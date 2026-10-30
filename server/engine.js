import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { all, get, run, emit, now, uid, safeJson, defaultFlow, starterFlow, roomPayload, taskPayload, memberPayload, WORKTREES, bus } from './store.js';
import * as G from './git.js';
import { runWorker, killTree, WORKER_DEFS } from './adapters.js';
import { buildPlanPrompt, buildTaskPrompt, buildReviewPrompt } from './prompts.js';

const GLOBAL_LIMIT = 3;
const ROOM_LIMIT = 2;
const running = new Map();
const starting = new Set();
// 计划 / 评审这类不属于任务的运行，单独登记，便于取消和展示
const liveRuns = new Map();
// 合并必须串行：多个会话同时合并会争抢基准分支和 index.lock
let mergeQueue = Promise.resolve();

function mapTask(t) { return taskPayload(t); }

export function listRooms() {
  const rooms = all('SELECT * FROM rooms ORDER BY created_at DESC').map(roomPayload);
  return rooms.map((r) => {
    const tasks = all('SELECT status FROM tasks WHERE room_id=?', [r.id]);
    return {
      ...r,
      counts: {
        total: tasks.length,
        running: tasks.filter((t) => t.status === 'running').length,
        review: tasks.filter((t) => ['review', 'changes_requested', 'approved'].includes(t.status)).length,
        done: tasks.filter((t) => ['merged', 'done'].includes(t.status)).length,
        failed: tasks.filter((t) => ['failed', 'escalated'].includes(t.status)).length,
      },
    };
  });
}

export function getRoomState(roomId) {
  const room = roomPayload(get('SELECT * FROM rooms WHERE id=?', [roomId]));
  if (!room) return null;
  const members = all('SELECT * FROM members WHERE room_id=? ORDER BY sort, name', [roomId]).map(memberPayload);
  const tasks = all('SELECT * FROM tasks WHERE room_id=? ORDER BY created_at', [roomId]).map(mapTask);
  const decisions = all('SELECT * FROM decisions WHERE room_id=? ORDER BY created_at', [roomId]);
  const reviews = all(
    `SELECT rv.* FROM reviews rv JOIN tasks t ON t.id = rv.task_id WHERE t.room_id=? ORDER BY rv.created_at`,
    [roomId],
  ).map((r) => ({ ...r, payload: safeJson(r.payload, {}) }));
  const events = all('SELECT * FROM events WHERE room_id=? ORDER BY id DESC LIMIT 200', [roomId])
    .map((e) => ({ ...e, payload: safeJson(e.payload, {}) }))
    .reverse();
  return {
    room, members, tasks, decisions, reviews, events,
    running: [...running.entries()].filter(([, v]) => v.roomId === roomId).map(([id]) => id),
  };
}

function addMember(roomId, m, sort) {
  const id = uid('m');
  run(
    `INSERT INTO members (id, room_id, name, worker, role_name, role_brief, model, concurrency, enabled, sort)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [id, roomId, m.name || '成员', m.worker || 'claude', m.roleName || m.role_name || '', m.roleBrief || m.role_brief || '', m.model || '', Number(m.concurrency || 1), m.enabled === false ? 0 : 1, sort],
  );
  return get('SELECT * FROM members WHERE id=?', [id]);
}

export async function createRoom(input) {
  const repoPath = String(input.repoPath || '').trim();
  if (!repoPath) throw new Error('请填写仓库路径');
  if (!(await G.isRepo(repoPath))) throw new Error(`不是 git 仓库：${repoPath}`);
  const base = input.baseBranch || (await G.currentBranch(repoPath));
  const roomId = uid('r');
  const ts = now();
  const members = Array.isArray(input.members) && input.members.length
    ? input.members.map(normalizeMember)
    : [{ name: '成员 1', worker: 'claude', roleName: '执行者', roleBrief: '' }];

  // 流程起点：可以选一个模板，或从已有房间复制整套流程
  let flow = starterFlow(input.flowTemplate) || defaultFlow();
  if (input.flowFromRoomId) {
    const src = get('SELECT flow_json FROM rooms WHERE id=?', [String(input.flowFromRoomId)]);
    const copied = src ? safeJson(src.flow_json, null) : null;
    if (copied && Array.isArray(copied.nodes) && copied.nodes.length) {
      flow = { ...copied, id: uid('flow') };
    }
  }

  run(
    `INSERT INTO rooms (id, name, requirement, repo_path, base_branch, flow_json, status, mode, auto_approve, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [roomId, input.name || '未命名房间', input.requirement || '', repoPath, base,
      JSON.stringify(flow), 'draft', input.mode === 'serial' ? 'serial' : 'parallel',
      input.autoApprove === false ? 0 : 1, ts, ts],
  );
  members.forEach((m, i) => addMember(roomId, m, i));
  const list = all('SELECT * FROM members WHERE room_id=? ORDER BY sort', [roomId]);
  const pick = (id, name, fallback) => {
    if (id && list.find((m) => m.id === id)) return id;
    if (name) {
      const hit = list.find((m) => m.name === name);
      if (hit) return hit.id;
    }
    return fallback;
  };
  const plannerId = pick(input.plannerId, input.plannerName, list[0]?.id);
  const reviewerId = pick(input.reviewerId, input.reviewerName, list[list.length - 1]?.id);
  run('UPDATE rooms SET planner_id=?, reviewer_id=? WHERE id=?', [plannerId, reviewerId, roomId]);
  emit(roomId, null, null, 'room.created', { name: input.name, repo: repoPath });
  return getRoomState(roomId);
}

export function updateRoom(roomId, patch) {
  const room = get('SELECT * FROM rooms WHERE id=?', [roomId]);
  if (!room) throw new Error('房间不存在');
  if (room.status === 'archived') throw new Error('会话已归档，请先恢复再修改');
  const sets = [];
  const params = [];
  for (const k of ['name', 'requirement', 'mode', 'planner_id', 'reviewer_id']) {
    if (patch[k] !== undefined) {
      let v = patch[k];
      if (k === 'name' || k === 'requirement') v = String(v || '').trim();
      if (k === 'name' && !v) throw new Error('会话名不能为空');
      if (k === 'mode' && !['serial', 'parallel'].includes(v)) throw new Error('未知并发模式');
      if (k === 'planner_id' || k === 'reviewer_id') {
        if (v && !get('SELECT id FROM members WHERE id=? AND room_id=?', [v, roomId])) {
          throw new Error('指定的成员不属于这个会话');
        }
      }
      sets.push(`${k}=?`);
      params.push(v);
    }
  }
  if (patch.autoApprove !== undefined) { sets.push('auto_approve=?'); params.push(patch.autoApprove ? 1 : 0); }
  if (patch.flow !== undefined) { sets.push('flow_json=?'); params.push(JSON.stringify(patch.flow)); }
  if (!sets.length) return getRoomState(roomId);
  sets.push('updated_at=?'); params.push(now());
  params.push(roomId);
  run(`UPDATE rooms SET ${sets.join(',')} WHERE id=?`, params);
  emit(roomId, null, null, 'room.updated', { keys: Object.keys(patch) });
  return getRoomState(roomId);
}

export function archiveRoom(roomId) {
  const room = get('SELECT * FROM rooms WHERE id=?', [roomId]);
  if (!room) throw new Error('房间不存在');
  if (room.status === 'archived') return;
  const live = [...running.values()].some((r) => r.roomId === roomId)
    || [...liveRuns.values()].some((r) => r.roomId === roomId);
  if (live) throw new Error('还有任务、计划或评审在运行，不能归档');
  run('UPDATE rooms SET status=?, updated_at=? WHERE id=?', ['archived', now(), roomId]);
  emit(roomId, null, null, 'room.archived', {});
}

export function restoreRoom(roomId) {
  const room = get('SELECT * FROM rooms WHERE id=?', [roomId]);
  if (!room) throw new Error('房间不存在');
  if (room.status !== 'archived') return getRoomState(roomId);
  run('UPDATE rooms SET status=?, updated_at=? WHERE id=?', ['draft', now(), roomId]);
  emit(roomId, null, null, 'room.restored', {});
  return getRoomState(roomId);
}

export function addRoomMember(roomId, m) {
  const room = get('SELECT * FROM rooms WHERE id=?', [roomId]);
  if (!room) throw new Error('房间不存在');
  if (room.status === 'archived') throw new Error('会话已归档，请先恢复再修改');
  const maxSort = get('SELECT MAX(sort) m FROM members WHERE room_id=?', [roomId]).m;
  const n = (maxSort === null || maxSort === undefined ? -1 : Number(maxSort)) + 1;
  const row = addMember(roomId, normalizeMember(m), n);
  emit(roomId, null, null, 'member.added', { name: row.name });
  return memberPayload(row);
}

function normalizeMember(m) {
  const worker = String(m.worker || '');
  if (!WORKER_DEFS[worker]) throw new Error('未知 worker：' + (worker || '（空）'));
  const name = String(m.name || '').trim();
  if (!name) throw new Error('成员名不能为空');
  const concurrency = Math.max(1, Math.min(10, Number(m.concurrency) || 1));
  return { ...m, name, worker, concurrency };
}

export function updateRoomMember(memberId, patch) {
  const m = get('SELECT * FROM members WHERE id=?', [memberId]);
  if (!m) throw new Error('成员不存在');
  const room = get('SELECT * FROM rooms WHERE id=?', [m.room_id]);
  if (room?.status === 'archived') throw new Error('会话已归档，请先恢复再修改');
  const sets = [];
  const params = [];
  if (patch.name !== undefined) {
    const name = String(patch.name || '').trim();
    if (!name) throw new Error('成员名不能为空');
    sets.push('name=?'); params.push(name);
  }
  if (patch.worker !== undefined) {
    if (!WORKER_DEFS[patch.worker]) throw new Error('未知 worker：' + patch.worker);
    sets.push('worker=?'); params.push(patch.worker);
  }
  for (const k of ['role_name', 'role_brief', 'model']) {
    if (patch[k] !== undefined) { sets.push(`${k}=?`); params.push(String(patch[k] || '').trim()); }
  }
  if (patch.concurrency !== undefined) {
    sets.push('concurrency=?');
    params.push(Math.max(1, Math.min(10, Number(patch.concurrency) || 1)));
  }
  if (patch.enabled !== undefined) { sets.push('enabled=?'); params.push(patch.enabled ? 1 : 0); }
  if (!sets.length) return memberPayload(m);
  params.push(memberId);
  run(`UPDATE members SET ${sets.join(',')} WHERE id=?`, params);
  const next = memberPayload(get('SELECT * FROM members WHERE id=?', [memberId]));
  emit(m.room_id, null, null, 'member.updated', { name: next.name });
  return next;
}

export function removeRoomMember(memberId) {
  const m = get('SELECT * FROM members WHERE id=?', [memberId]);
  if (!m) return;
  const room = get('SELECT * FROM rooms WHERE id=?', [m.room_id]);
  if (room?.status === 'archived') throw new Error('会话已归档，请先恢复再修改');
  const total = get('SELECT COUNT(*) c FROM members WHERE room_id=?', [m.room_id]).c;
  if (total <= 1) throw new Error('会话至少要保留一个成员');
  const owned = get('SELECT COUNT(*) c FROM tasks WHERE owner_id=?', [memberId]).c;
  if (owned) throw new Error(`「${m.name}」名下还有 ${owned} 个任务，不能删除；可以先停用这个成员。`);
  run('DELETE FROM members WHERE id=?', [memberId]);
  const rest = all('SELECT id FROM members WHERE room_id=? ORDER BY sort, name', [m.room_id]);
  const fallback = rest[0]?.id || null;
  if (room.planner_id === memberId) run('UPDATE rooms SET planner_id=? WHERE id=?', [fallback, m.room_id]);
  if (room.reviewer_id === memberId) run('UPDATE rooms SET reviewer_id=? WHERE id=?', [fallback, m.room_id]);
  emit(m.room_id, null, null, 'member.removed', { name: m.name });
}

function extractJson(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/```json/gi, '').replace(/```/g, '');
  const s = cleaned.indexOf('{');
  const e = cleaned.lastIndexOf('}');
  if (s < 0 || e <= s) return null;
  try { return JSON.parse(cleaned.slice(s, e + 1)); } catch { return null; }
}

function execWorker({ worker, model, autoApprove, cwd, prompt, runId, roomId, taskId, timeoutMs, onSpawn, actor }) {
  return new Promise((resolve) => {
    let finished = false;
    let timer = null;
    const done = (r) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      resolve(r);
    };
    const h = runWorker({
      worker, model, autoApprove, cwd, prompt, runId,
      onLine: (line, prefix, obj, activity) => bus.emit('log', {
        roomId, taskId, runId, line, stream: prefix,
        activity: activity || '', actor: actor || null, at: now(),
      }),
      onExit: (r) => done(r),
    });
    if (onSpawn) onSpawn(h.child.pid);
    timer = setTimeout(() => {
      try { killTree(h.child.pid); } catch {}
      bus.emit('log', { roomId, taskId, runId, line: `[devhub] 超时，已终止（${Math.round(timeoutMs / 1000)}s）`, stream: 'err', at: now() });
      done({ code: -2, error: '超时', text: '', session: '', logPath: h.logPath });
    }, timeoutMs);
    // 子进程可能在定时器赋值前就已经退出，避免留下一个 30 分钟的空转定时器
    if (finished) clearTimeout(timer);
  });
}

export async function generatePlan(roomId) {
  const room = get('SELECT * FROM rooms WHERE id=?', [roomId]);
  if (!room) throw new Error('房间不存在');
  if (room.status === 'archived') throw new Error('会话已归档，请先恢复再生成计划');
  const members = all('SELECT * FROM members WHERE room_id=? ORDER BY sort', [roomId]).map(memberPayload);
  if (!members.length) throw new Error('房间还没有成员');
  const planner = members.find((m) => m.id === room.planner_id) || members[0];
  if (!planner.enabled) throw new Error(`计划者「${planner.name}」已停用，请先在会话设置里启用或换人`);
  for (const [, r] of liveRuns) {
    if (r.kind === 'plan' && r.roomId === roomId) throw new Error('计划正在生成，请等待或先点停止');
  }
  const flow = safeJson(room.flow_json, defaultFlow());
  const decisions = all('SELECT * FROM decisions WHERE room_id=? AND status=?', [roomId, 'active']);
  const prompt = buildPlanPrompt({ room: roomPayload(room), members, flow, decisions });
  const runId = uid('run');
  emit(roomId, null, runId, 'plan.started', { planner: planner.name, worker: planner.worker });
  const holder = { kind: 'plan', roomId, taskId: null, pid: 0, cancelled: false };
  liveRuns.set(runId, holder);
  let res;
  try {
    res = await execWorker({
      worker: planner.worker, model: planner.model, autoApprove: false,
      cwd: room.repo_path, prompt, runId, roomId, taskId: null, timeoutMs: 10 * 60 * 1000,
      actor: { name: planner.name, worker: planner.worker, kind: 'plan' },
      onSpawn: (pid) => { holder.pid = pid; if (holder.cancelled) killTree(pid); },
    });
  } finally {
    liveRuns.delete(runId);
  }
  if (holder.cancelled) {
    emit(roomId, null, runId, 'plan.cancelled', {});
    throw new Error('计划生成已取消');
  }
  const plan = extractJson(res.text);
  if (!plan || !Array.isArray(plan.tasks)) {
    emit(roomId, null, runId, 'plan.failed', { error: res.error || '无法解析计划', raw: String(res.text || '').slice(0, 2000) });
    throw new Error(`计划生成失败：${res.error || '模型没有返回合法 JSON'}\n${String(res.text || '').slice(0, 800)}`);
  }
  run('UPDATE rooms SET plan_json=?, status=?, updated_at=? WHERE id=?', [JSON.stringify(plan), 'planning', now(), roomId]);
  emit(roomId, null, runId, 'plan.ready', { count: plan.tasks.length, summary: plan.summary || '' });
  return plan;
}

export function applyPlan(roomId, plan) {
  const room = get('SELECT * FROM rooms WHERE id=?', [roomId]);
  if (!room) throw new Error('房间不存在');
  if (room.status === 'archived') throw new Error('会话已归档，请先恢复再修改计划');
  if (!Array.isArray(plan.tasks) || !plan.tasks.length) throw new Error('计划里没有任务');
  const active = get(`SELECT COUNT(*) c FROM tasks WHERE room_id=? AND status='running'`, [roomId]).c;
  if (active > 0) throw new Error('还有任务在运行，不能覆盖计划');
  // 已经跑过的任务不能悄悄删掉：旧 worktree / 分支还在，同名任务重建会冲突，
  // 已合并的记录也会一起消失。要重新规划就开新会话。
  const existing = all('SELECT * FROM tasks WHERE room_id=?', [roomId]);
  const executed = existing.filter((t) => !['backlog', 'ready'].includes(t.status) || t.worktree || t.branch);
  if (executed.length) {
    throw new Error('这个会话已经有执行记录，重新生成计划会覆盖它们。请新建会话，或先归档当前会话。');
  }
  const members = all('SELECT * FROM members WHERE room_id=?', [roomId]).map(memberPayload);
  const flow = safeJson(room.flow_json, defaultFlow());
  const phases = flow.nodes.filter((n) => n.type === 'phase');

  run('DELETE FROM tasks WHERE room_id=?', [roomId]);
  const ts = now();
  const created = [];
  (plan.tasks || []).forEach((t, i) => {
    const key = 'T' + (i + 1);
    const owner = members.find((m) => m.name === t.owner)
      || members.find((m) => m.name.includes(String(t.owner || '')) || String(t.owner || '').includes(m.name))
      || members[0];
    const phase = phases.find((p) => p.name === t.phase) || phases[Math.min(i, phases.length - 1)];
    const id = uid('t');
    run(
      `INSERT INTO tasks (id, room_id, key, title, spec, type, owner_id, phase_id, status, deps_json, acceptance_json, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, roomId, key, t.title || `任务 ${i + 1}`, t.spec || '', t.type || 'code', owner?.id || null,
        phase?.id || null, 'backlog', JSON.stringify((t.dependsOn || []).map((n) => 'T' + n)),
        JSON.stringify(t.acceptance || []), ts, ts],
    );
    created.push({ id, key });
  });

  for (const d of plan.decisions || []) {
    run('INSERT INTO decisions (id, room_id, text, rationale, status, created_at) VALUES (?,?,?,?,?,?)',
      [uid('d'), roomId, String(d), '', 'active', ts]);
  }
  run('UPDATE rooms SET plan_json=?, status=?, updated_at=? WHERE id=?', ['', 'planning', ts, roomId]);
  emit(roomId, null, null, 'plan.applied', { count: created.length });
  refreshReady(roomId);
  return getRoomState(roomId);
}

function setStatus(taskId, status, extra = {}) {
  const sets = ['status=?', 'updated_at=?'];
  const params = [status, now()];
  for (const [k, v] of Object.entries(extra)) { sets.push(`${k}=?`); params.push(v); }
  params.push(taskId);
  run(`UPDATE tasks SET ${sets.join(',')} WHERE id=?`, params);
  const t = get('SELECT * FROM tasks WHERE id=?', [taskId]);
  if (t) emit(t.room_id, t.id, null, 'task.status', { status, key: t.key, title: t.title });
  return t;
}

function refreshReady(roomId) {
  const tasks = all('SELECT * FROM tasks WHERE room_id=?', [roomId]).map(mapTask);
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  for (const t of tasks) {
    if (t.status !== 'backlog') continue;
    const ok = (t.deps || []).every((k) => {
      const d = byKey.get(k);
      return d && ['merged', 'done'].includes(d.status);
    });
    if (ok) setStatus(t.id, 'ready');
  }
}

export function startRoom(roomId) {
  const room = get('SELECT * FROM rooms WHERE id=?', [roomId]);
  if (!room) throw new Error('房间不存在');
  if (room.status === 'archived') throw new Error('会话已归档，请先恢复再执行');
  run('UPDATE rooms SET status=?, updated_at=? WHERE id=?', ['running', now(), roomId]);
  refreshReady(roomId);
  emit(roomId, null, null, 'room.started', {});
  schedule();
  return getRoomState(roomId);
}

export function pauseRoom(roomId) {
  const room = get('SELECT * FROM rooms WHERE id=?', [roomId]);
  if (!room) throw new Error('房间不存在');
  if (room.status === 'archived') throw new Error('会话已归档，请先恢复再操作');
  run('UPDATE rooms SET status=?, updated_at=? WHERE id=?', ['paused', now(), roomId]);
  emit(roomId, null, null, 'room.paused', {});
}

export function schedule() {
  const rooms = all(`SELECT * FROM rooms WHERE status='running'`);
  for (const room of rooms) {
    const runningInRoom = () => [...running.values()].filter((r) => r.roomId === room.id).length;
    const limit = room.mode === 'serial' ? 1 : ROOM_LIMIT;
    if (runningInRoom() >= limit) continue;
    const tasks = all(`SELECT * FROM tasks WHERE room_id=? AND status='ready' ORDER BY created_at`, [room.id]).map(mapTask);
    for (const t of tasks) {
      if (running.size >= GLOBAL_LIMIT) return;
      if (runningInRoom() >= limit) break;
      if (!t.owner_id) continue;
      if (starting.has(t.id) || running.has(t.id)) continue;
      const member = get('SELECT * FROM members WHERE id=?', [t.owner_id]);
      if (!member || !member.enabled) continue;
      const memberCount = [...running.values()].filter((r) => r.memberId === member.id).length;
      if (memberCount >= Math.max(1, member.concurrency || 1)) continue;
      starting.add(t.id);
      startTask(t.id).catch((e) => {
        setStatus(t.id, 'failed', { summary: String(e.message || e) });
        emit(room.id, t.id, null, 'task.error', { error: String(e.message || e) });
      }).finally(() => starting.delete(t.id));
    }
  }
}

async function ensureWorktree(task, room) {
  if (task.worktree && existsSync(join(task.worktree, '.git'))) return task.worktree;
  const base = room.base_branch || (await G.currentBranch(room.repo_path));
  const sha = await G.revParse(room.repo_path, base);
  const wt = join(WORKTREES, room.id, task.id);
  const branch = `devhub/${room.id}/${task.key}-${task.id.slice(-6)}`;
  await G.addWorktree(room.repo_path, wt, branch, sha);
  run('UPDATE tasks SET worktree=?, branch=?, base_sha=?, updated_at=? WHERE id=?', [wt, branch, sha, now(), task.id]);
  emit(room.id, task.id, null, 'task.worktree', { path: wt, branch });
  return wt;
}

export async function startTask(taskId) {
  if (running.has(taskId)) return { ok: true, already: true };
  const task = get('SELECT * FROM tasks WHERE id=?', [taskId]);
  if (!task) throw new Error('任务不存在');
  const room = get('SELECT * FROM rooms WHERE id=?', [task.room_id]);
  if (!room) throw new Error('房间不存在');
  if (room.status === 'archived') throw new Error('会话已归档，请先恢复再运行任务');
  const member = task.owner_id ? get('SELECT * FROM members WHERE id=?', [task.owner_id]) : null;
  if (!member) throw new Error('任务没有负责人');
  if (!member.enabled) throw new Error(`负责人「${member.name}」已停用，请先启用或换人`);
  const wt = await ensureWorktree(taskPayload(task), roomPayload(room));
  // ensureWorktree 会把 base_sha 写回数据库；上面的 task 是创建 worktree 之前读的，
  // 必须重新取一次，否则 diff 会拿空 ref 去比对，导致有改动的任务被判成“无改动”。
  const baseSha = get('SELECT base_sha FROM tasks WHERE id=?', [taskId])?.base_sha || '';
  if (!baseSha) throw new Error('无法确定任务基准提交（base_sha 为空）');
  // 建 worktree 期间用户可能已经取消，不要再启动 agent
  if (get('SELECT status FROM tasks WHERE id=?', [taskId])?.status === 'cancelled') {
    return { ok: false, cancelled: true };
  }
  const decisions = all('SELECT * FROM decisions WHERE room_id=? AND status=?', [room.id, 'active']);
  const allTasks = all('SELECT * FROM tasks WHERE room_id=?', [room.id]).map(mapTask);
  const byKey = new Map(allTasks.map((t) => [t.key, t]));
  const upstream = (taskPayload(task).deps || []).map((k) => byKey.get(k)).filter(Boolean);

  const prompt = buildTaskPrompt({
    room: roomPayload(room), task: taskPayload(task), member: memberPayload(member),
    decisions, upstream, feedback: task.feedback || '', worktree: wt,
  });
  const runId = uid('run');
  run(`INSERT INTO runs (id, task_id, member_id, status, log_path, started_at) VALUES (?,?,?,?,?,?)`,
    [runId, taskId, member.id, 'running', '', now()]);
  setStatus(taskId, 'running', { summary: '', diff_stat: '' });
  emit(room.id, taskId, runId, 'task.started', { member: member.name, worker: member.worker, key: task.key });
  const holder = { roomId: room.id, memberId: member.id, runId, pid: 0 };
  running.set(taskId, holder);

  const timeoutMs = task.type === 'code' ? 30 * 60 * 1000 : 20 * 60 * 1000;
  const res = await execWorker({
    worker: member.worker, model: member.model, autoApprove: !!room.auto_approve,
    cwd: wt, prompt, runId, roomId: room.id, taskId, timeoutMs,
    onSpawn: (pid) => { holder.pid = pid; },
    actor: { name: member.name, worker: member.worker, kind: 'task' },
  });
  running.delete(taskId);

  // 用户取消后，进程会以非 0 退出；这里必须直接收尾，不能再提交半成品或覆盖取消状态。
  const latest = get('SELECT status FROM tasks WHERE id=?', [taskId]);
  if (latest?.status === 'cancelled') {
    run('UPDATE runs SET status=?, session_id=?, exit_code=?, error=?, log_path=?, ended_at=? WHERE id=?', [
      'cancelled', res.session || '', res.code ?? null, '已取消', res.logPath || '', now(), runId,
    ]);
    schedule();
    return { ok: false, cancelled: true };
  }

  let committed = false;
  let stat = '';
  try {
    committed = await G.commitAll(wt, `devhub(${task.key}): ${task.title}`);
    stat = await G.diffStat(wt, baseSha);
  } catch (e) {
    bus.emit('log', { roomId: room.id, taskId, runId, line: `[devhub] 收集改动失败：${e.message}`, stream: 'err', at: now() });
  }

  run('UPDATE runs SET status=?, session_id=?, exit_code=?, error=?, log_path=?, ended_at=? WHERE id=?', [
    res.code === 0 ? 'completed' : 'failed', res.session || '', res.code ?? null,
    res.error || (res.errors || []).join('; ').slice(0, 1000) || '', res.logPath || '', now(), runId,
  ]);

  const summary = (res.text || '').trim() || (res.error ? `执行失败：${res.error}` : '（没有文本输出）');
  const failed = res.code !== 0;
  // 没有产生任何改动（例如只输出结论的 document / research 任务）时无法评审和合并，
  // 直接收尾，否则依赖它的下游任务会永远卡在 backlog。
  const noChange = !failed && !stat.trim();
  const nextStatus = failed ? 'failed' : noChange ? 'done' : 'review';
  setStatus(taskId, nextStatus, {
    summary: summary.slice(0, 20000),
    diff_stat: stat,
  });
  emit(room.id, taskId, runId, failed ? 'task.failed' : 'task.finished', {
    code: res.code, summary: summary.slice(0, 4000), stat, committed,
    noChange, status: nextStatus,
    session: res.session || '', cost: res.cost ?? null, usage: res.usage || null,
  });
  refreshReady(room.id);
  maybeCompleteRoom(room.id);
  schedule();
  return { ok: !failed, code: res.code };
}

function maybeCompleteRoom(roomId) {
  const room = get('SELECT * FROM rooms WHERE id=?', [roomId]);
  if (!room || room.status !== 'running') return;
  const tasks = all('SELECT status FROM tasks WHERE room_id=?', [roomId]);
  if (!tasks.length) return;
  const terminal = tasks.every((t) => ['merged', 'done', 'cancelled'].includes(t.status));
  if (terminal) {
    run('UPDATE rooms SET status=?, updated_at=? WHERE id=?', ['completed', now(), roomId]);
    emit(roomId, null, null, 'room.completed', {});
  }
}

export async function reviewTask(taskId) {
  const task = get('SELECT * FROM tasks WHERE id=?', [taskId]);
  if (!task) throw new Error('任务不存在');
  const room = get('SELECT * FROM rooms WHERE id=?', [task.room_id]);
  if (!room) throw new Error('房间不存在');
  if (room.status === 'archived') throw new Error('会话已归档，请先恢复再评审');
  const members = all('SELECT * FROM members WHERE room_id=?', [room.id]).map(memberPayload);
  const reviewer = members.find((m) => m.id === room.reviewer_id) || members[members.length - 1];
  if (!reviewer) throw new Error('没有可用的评审者');
  if (!reviewer.enabled) throw new Error(`评审者「${reviewer.name}」已停用，请先启用或换人`);
  for (const [, r] of liveRuns) {
    if (r.kind === 'review' && r.taskId === taskId) throw new Error('这个任务正在评审，请等待或先点停止');
  }
  const reviewed = get('SELECT COUNT(*) c FROM reviews WHERE task_id=?', [taskId]).c || 0;
  if (reviewed >= 2) {
    throw new Error('这个任务已经评审 2 轮，达到上限；请人工判断后合并，或按意见重跑后人工合并。');
  }
  const diff = await G.diff(task.worktree, task.base_sha);
  if (!diff) throw new Error('这个任务没有可评审的改动');
  const prompt = buildReviewPrompt({
    room: roomPayload(room), task: taskPayload(task), member: reviewer,
    diff, acceptance: taskPayload(task).acceptance, worktree: task.worktree,
  });
  const runId = uid('run');
  emit(room.id, taskId, runId, 'review.started', { reviewer: reviewer.name, worker: reviewer.worker, key: task.key });
  const dirtyBefore = await G.trackedStatus(task.worktree);
  const headBefore = await G.revParse(task.worktree, 'HEAD').catch(() => '');
  const holder = { kind: 'review', roomId: room.id, taskId, pid: 0, cancelled: false };
  liveRuns.set(runId, holder);
  let res;
  try {
    res = await execWorker({
      worker: reviewer.worker, model: reviewer.model, autoApprove: false,
      cwd: task.worktree, prompt, runId, roomId: room.id, taskId, timeoutMs: 8 * 60 * 1000,
      actor: { name: reviewer.name, worker: reviewer.worker, kind: 'review' },
      onSpawn: (pid) => { holder.pid = pid; if (holder.cancelled) killTree(pid); },
    });
  } finally {
    liveRuns.delete(runId);
  }
  if (holder.cancelled) {
    emit(room.id, taskId, runId, 'review.cancelled', {});
    throw new Error('评审已取消');
  }
  // 评审必须是只读的。若评审者改了工作区，它给出的结论只能证明自己的改动，
  // 不能作为合并依据；这里直接失败关闭，保留任务在 review 状态等人工处理。
  const dirtyAfter = await G.trackedStatus(task.worktree);
  const headAfter = await G.revParse(task.worktree, 'HEAD').catch(() => '');
  if (dirtyAfter !== dirtyBefore || headAfter !== headBefore) {
    emit(room.id, taskId, runId, 'review.failed', { error: '评审过程中修改了工作区或提交，评审结果不可信' });
    throw new Error('评审过程中修改了工作区或提交，评审结果不可信；请检查该 reviewer 的角色约束后重试');
  }
  const verdict = extractJson(res.text) || { verdict: 'request_changes', blocking: [], notes: String(res.text || res.error || '').slice(0, 1000) };
  const round = (get('SELECT COUNT(*) c FROM reviews WHERE task_id=?', [taskId]).c || 0) + 1;
  run('INSERT INTO reviews (id, task_id, round, verdict, payload, created_at) VALUES (?,?,?,?,?,?)',
    [uid('rv'), taskId, round, verdict.verdict || 'request_changes', JSON.stringify(verdict), now()]);
  const approve = verdict.verdict === 'approve';
  if (approve) {
    setStatus(taskId, 'approved');
  } else {
    const lines = (verdict.blocking || []).map((b) => `- ${b.file || '?'}:${b.line || '?'} ${b.issue || ''} → ${b.suggestion || ''}`);
    const feedback = `第 ${round} 轮评审：\n${lines.join('\n') || verdict.notes || '需要修改'}`;
    const old = task.feedback ? task.feedback + '\n\n' : '';
    // 评审最多 2 轮：第 2 轮仍不通过就升级给人工，不再自动进入第 3 轮。
    setStatus(taskId, round >= 2 ? 'escalated' : 'changes_requested', { feedback: (old + feedback).slice(0, 20000) });
  }
  emit(room.id, taskId, runId, 'review.done', { verdict: verdict.verdict, round, escalated: !approve && round >= 2, notes: verdict.notes || '' });
  return { verdict, round };
}

export function rejectTask(taskId, note) {
  const task = get('SELECT * FROM tasks WHERE id=?', [taskId]);
  if (!task) throw new Error('任务不存在');
  const room = get('SELECT * FROM rooms WHERE id=?', [task.room_id]);
  if (room?.status === 'archived') throw new Error('会话已归档，请先恢复再操作');
  const old = task.feedback ? task.feedback + '\n\n' : '';
  setStatus(taskId, 'changes_requested', { feedback: (old + '人工打回：' + (note || '请修改') + '').slice(0, 20000) });
  emit(task.room_id, taskId, null, 'task.rejected', { note: note || '' });
}

export function retryTask(taskId) {
  const before = get('SELECT * FROM tasks WHERE id=?', [taskId]);
  if (!before) throw new Error('任务不存在');
  const room = get('SELECT * FROM rooms WHERE id=?', [before.room_id]);
  if (room?.status === 'archived') throw new Error('会话已归档，请先恢复再操作');
  setStatus(taskId, 'ready');
  const t = get('SELECT * FROM tasks WHERE id=?', [taskId]);
  emit(t.room_id, taskId, null, 'task.retry', {});
  schedule();
}

export function cancelTask(taskId) {
  const live = running.get(taskId);
  if (live?.pid) killTree(live.pid);
  const task = get('SELECT * FROM tasks WHERE id=?', [taskId]);
  setStatus(taskId, 'cancelled');
  if (task) {
    emit(task.room_id, taskId, null, 'task.cancelled', {});
    maybeCompleteRoom(task.room_id);
  }
}

/** 取消这个会话正在进行的计划或评审（任务运行走 cancelTask）。 */
export function cancelRoomRun(roomId) {
  let count = 0;
  for (const [, r] of liveRuns) {
    if (r.roomId !== roomId || !['plan', 'review'].includes(r.kind)) continue;
    r.cancelled = true;
    if (r.pid) killTree(r.pid);
    count++;
  }
  if (count) emit(roomId, null, null, 'run.cancel.requested', { count });
  return count;
}

export function mergeTask(taskId) {
  const job = mergeQueue.then(() => mergeTaskInner(taskId));
  // 无论成功失败都放开队列，避免一次冲突把后续合并永久堵死
  mergeQueue = job.then(() => {}, () => {});
  return job;
}

async function mergeTaskInner(taskId) {
  const task = get('SELECT * FROM tasks WHERE id=?', [taskId]);
  if (!task) throw new Error('任务不存在');
  const room = get('SELECT * FROM rooms WHERE id=?', [task.room_id]);
  if (!room) throw new Error('房间不存在');
  if (room.status === 'archived') throw new Error('会话已归档，请先恢复再合并');
  if (!task.branch) throw new Error('任务还没有分支');
  const stat = String(task.diff_stat || '').trim();
  if (!stat) {
    // 没有改动就没有可合并的内容，直接收尾，避免空提交失败
    setStatus(taskId, 'done');
    emit(room.id, taskId, null, 'task.merged', { branch: task.branch, noChange: true });
    refreshReady(room.id);
    maybeCompleteRoom(room.id);
    schedule();
    return { ok: true, noChange: true };
  }
  try { await G.commitAll(task.worktree, `devhub(${task.key}): ${task.title}`); } catch {}
  await G.mergeSquash(room.repo_path, room.base_branch, task.branch, `devhub(${task.key}): ${task.title}`);
  setStatus(taskId, 'merged');
  emit(room.id, taskId, null, 'task.merged', { branch: task.branch });
  refreshReady(room.id);
  maybeCompleteRoom(room.id);
  schedule();
  return { ok: true };
}

export async function taskDiff(taskId) {
  const task = get('SELECT * FROM tasks WHERE id=?', [taskId]);
  if (!task || !task.worktree) return '';
  return G.diff(task.worktree, task.base_sha);
}

export function taskLog(taskId) {
  const row = get('SELECT * FROM runs WHERE task_id=? ORDER BY started_at DESC LIMIT 1', [taskId]);
  if (!row || !row.log_path || !existsSync(row.log_path)) return '';
  try { return readFileSync(row.log_path, 'utf8'); } catch { return ''; }
}

export function runningTasks() {
  return [...running.entries()].map(([taskId, v]) => ({ taskId, ...v }));
}
