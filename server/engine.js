import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { all, get, run, transaction, emit, now, uid, safeJson, defaultFlow, starterFlow, roomPayload, taskPayload, memberPayload, WORKTREES, bus } from './store.js';
import { validatePlan, PlanValidationError } from './plan.js';
import * as G from './git.js';
import { runWorker, killTree, WORKER_DEFS } from './adapters.js';
import { buildPlanPrompt, buildTaskPrompt, buildReviewPrompt } from './prompts.js';
import { readSettings as readRoomSettings, saveSettings as saveRoomSettings } from './settings.js';

const GLOBAL_LIMIT = 3;
const ROOM_LIMIT = 2;
// Entries reserve capacity before the first await and remain until all cleanup finishes.
const running = new Map();
const taskOperations = new Map();
const RESULT_STATUSES = new Set(['review', 'approved', 'changes_requested', 'escalated', 'merged', 'done']);
const MERGE_STATUSES = new Set(['review', 'approved', 'escalated']);
// 计划 / 评审这类不属于任务的运行，单独登记，便于取消和展示
const liveRuns = new Map();
// 合并必须串行：多个会话同时合并会争抢基准分支和 index.lock
let mergeQueue = Promise.resolve();

function mapTask(t) { return taskPayload(t); }

function assertTaskAvailable(taskId, owner = null) {
  const active = taskOperations.get(taskId);
  if (active && active !== owner) {
    const label = { run: '运行或收尾', review: '评审', merge: '合并', diff: '读取成果' }[active.kind] || '处理';
    throw new Error(`任务正在${label}，请等待完成后刷新再操作`);
  }
}

function claimTaskOperation(taskId, holder) {
  assertTaskAvailable(taskId);
  taskOperations.set(taskId, holder);
  return holder;
}

function releaseTaskOperation(taskId, holder) {
  if (taskOperations.get(taskId) === holder) taskOperations.delete(taskId);
}

function staleResult(message = '任务成果已更新，请刷新 Diff 并重新确认后再操作') {
  const error = new Error(message);
  error.statusCode = 409;
  return error;
}

function assertResultSnapshot(task, room, owner) {
  if (owner && taskOperations.get(task.id) !== owner) throw staleResult();
  const latest = get('SELECT * FROM tasks WHERE id=?', [task.id]);
  const currentRoom = get('SELECT * FROM rooms WHERE id=?', [room.id]);
  if (!latest || !currentRoom || latest.status !== task.status || latest.base_sha !== task.base_sha
    || latest.branch !== task.branch || latest.worktree !== task.worktree || (latest.result_sha || '') !== (task.result_sha || '')
    || currentRoom.repo_path !== room.repo_path || currentRoom.base_branch !== room.base_branch
    || currentRoom.status === 'archived' && room.status !== 'archived') throw staleResult();
  if (owner?.cancelled) throw new Error('操作已取消，请刷新任务后再操作');
  return latest;
}

async function readTaskResult(taskId, expectedSha, owner) {
  let task = get('SELECT * FROM tasks WHERE id=?', [taskId]);
  if (!task) throw new Error('任务不存在，请刷新会话后重试');
  const room = get('SELECT * FROM rooms WHERE id=?', [task.room_id]);
  if (!room) throw new Error('任务所属会话不存在，请刷新后重试');
  const legacy = !task.result_sha;
  if (legacy && (!RESULT_STATUSES.has(task.status) || !task.branch)) {
    throw new Error('任务尚无成功产出，请先完成运行后再查看、评审或合并');
  }
  if (!task.base_sha) throw new Error('任务基准提交缺失，请重新运行任务后再查看成果');
  const resultSha = await G.commitSha(room.repo_path, task.result_sha || task.branch);
  assertResultSnapshot(task, room, owner);
  if (expectedSha !== undefined && (typeof expectedSha !== 'string' || expectedSha.toLowerCase() !== resultSha)) {
    throw staleResult();
  }
  if (legacy) {
    run('UPDATE tasks SET result_sha=?, updated_at=? WHERE id=?', [resultSha, now(), taskId]);
    task = { ...task, result_sha: resultSha };
    emit(room.id, taskId, null, 'task.result', { resultSha });
  }
  const diff = await G.diffCommit(room.repo_path, task.base_sha, resultSha);
  assertResultSnapshot(task, room, owner);
  return { task, room, resultSha, diff };
}

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

function assertRoomEditable(roomId) {
  const busy = [...taskOperations.values()].some((operation) => operation.roomId === roomId)
    || [...running.values()].some((operation) => operation.roomId === roomId)
    || [...liveRuns.values()].some((operation) => operation.roomId === roomId);
  if (busy) throw staleResult('还有任务、计划或评审正在处理，请等待完成或停止后再保存');
}

const FLOW_GATES = new Set(['auto', 'agent', 'human']);
const FLOW_CONDITIONS = new Set(['passed', 'rejected', 'timeout', 'always']);
// 流程没写上限时的旧行为：最多打回 2 次，第 2 次不通过升级到收件箱。
const DEFAULT_MAX_LOOP = 2;

/**
 * 任务所属阶段的门禁。没绑定阶段、旧流程没有 gate、或数据不合法时按「评审通过」处理，
 * 这样不挂阶段的任务保持原来的人工点「自动检查」流程。
 */
function taskGate(room, task) {
  const flow = safeJson(room?.flow_json, null);
  const nodes = Array.isArray(flow?.nodes) ? flow.nodes : [];
  const phase = nodes.find((node) => node && node.type === 'phase' && node.id === task?.phase_id) || null;
  const gate = phase && FLOW_GATES.has(phase.gate) ? phase.gate : 'agent';
  const maxLoop = phase && Number.isInteger(phase.maxLoop) && phase.maxLoop >= 1 ? phase.maxLoop : DEFAULT_MAX_LOOP;
  return { gate, maxLoop, phase };
}

// 阶段在文案里的称呼：名字为空或缺失时用 id。
function flowNodeName(node) {
  return typeof node?.name === 'string' && node.name.trim() ? node.name : node.id;
}

/**
 * 迭代 Kosaraju：求有向图的强连通分量（显式栈，O(V+E)）。
 * 只用于「通过边」子图：同分量等价于「从 to 沿通过边能回到 from」。
 */
function flowComponents(ids, adjacency) {
  const visited = new Set();
  const order = [];
  for (const root of ids) {
    if (visited.has(root)) continue;
    visited.add(root);
    const stack = [[root, 0]];
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const nexts = adjacency.get(frame[0]) || [];
      if (frame[1] < nexts.length) {
        const next = nexts[frame[1]++];
        if (visited.has(next)) continue;
        visited.add(next);
        stack.push([next, 0]);
      } else {
        order.push(frame[0]);
        stack.pop();
      }
    }
  }
  const reverse = new Map();
  for (const [from, targets] of adjacency) {
    for (const to of targets) {
      if (!reverse.has(to)) reverse.set(to, []);
      reverse.get(to).push(from);
    }
  }
  const component = new Map();
  let label = 0;
  for (let i = order.length - 1; i >= 0; i--) {
    const root = order[i];
    if (component.has(root)) continue;
    component.set(root, label);
    const stack = [root];
    while (stack.length) {
      const id = stack.pop();
      for (const previous of reverse.get(id) || []) {
        if (component.has(previous)) continue;
        component.set(previous, label);
        stack.push(previous);
      }
    }
    label++;
  }
  return component;
}

// 保存流程时的服务端校验：结构 → 图结构，命中第一条即 400。
// memberNames 是房间成员名字集合（含停用成员），用于负责人校验。
function validateEditableFlow(flow, memberNames = new Set()) {
  const invalid = (message) => {
    const error = new Error(message);
    error.statusCode = 400;
    throw error;
  };
  if (!flow || typeof flow !== 'object' || Array.isArray(flow)) invalid('流程必须是对象');
  if (!Array.isArray(flow.nodes)) invalid('流程阶段必须是数组');
  if (!Array.isArray(flow.edges)) invalid('流程连线必须是数组');

  const ids = new Set();
  for (const node of flow.nodes) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) invalid('流程阶段格式无效');
    if (typeof node.id !== 'string' || !node.id.trim()) invalid('流程阶段必须有有效标识');
    if (ids.has(node.id)) invalid(`流程阶段标识重复：${node.id}`);
    ids.add(node.id);
    if (Object.hasOwn(node, 'outputs') && (!Array.isArray(node.outputs) || node.outputs.some((output) => typeof output !== 'string'))) {
      invalid('流程阶段产出必须是文字标签列表');
    }
    for (const axis of ['x', 'y']) {
      if (Object.hasOwn(node, axis)
        && (typeof node[axis] !== 'number' || !Number.isFinite(node[axis]) || node[axis] < 0)) {
        invalid(`流程阶段位置 ${axis} 必须是有限的非负数`);
      }
    }
    if (Object.hasOwn(node, 'type') && node.type !== 'phase') invalid('流程阶段类型只支持 phase');
    if (Object.hasOwn(node, 'gate') && !FLOW_GATES.has(node.gate)) {
      invalid('流程阶段完成条件只支持 auto / agent / human');
    }
    if (Object.hasOwn(node, 'maxLoop')
      && !(typeof node.maxLoop === 'number' && Number.isInteger(node.maxLoop) && node.maxLoop >= 0 && node.maxLoop <= 9)) {
      invalid('回边上限必须是 0-9 的整数');
    }
    if (Object.hasOwn(node, 'owner')) {
      if (typeof node.owner !== 'string') invalid('流程阶段负责人必须是成员名字');
      if (node.owner && !memberNames.has(node.owner)) {
        invalid(`阶段「${flowNodeName(node)}」的负责人「${node.owner}」不在成员列表中`);
      }
    }
  }
  for (const edge of flow.edges) {
    if (!edge || typeof edge !== 'object' || Array.isArray(edge)) invalid('流程连线格式无效');
    if (typeof edge.from !== 'string' || !ids.has(edge.from)
      || typeof edge.to !== 'string' || !ids.has(edge.to)) {
      invalid('流程连线的起点和终点必须是现有阶段');
    }
    if (edge.from === edge.to) invalid('流程连线不能指向自己');
    if (Object.hasOwn(edge, 'condition') && !FLOW_CONDITIONS.has(edge.condition)) {
      invalid('流程连线条件只支持 passed / rejected / timeout / always');
    }
  }

  // 空流程合法：不画阶段时不检查图结构。
  if (!flow.nodes.length) return;

  const nodeById = new Map(flow.nodes.map((node) => [node.id, node]));
  const outgoing = new Map(); // 全部边
  const forward = new Map(); // 通过边（非 rejected），用于环检测
  const incoming = new Map(flow.nodes.map((node) => [node.id, 0]));
  for (const edge of flow.edges) {
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    outgoing.get(edge.from).push(edge.to);
    incoming.set(edge.to, incoming.get(edge.to) + 1);
    if (edge.condition !== 'rejected') {
      if (!forward.has(edge.from)) forward.set(edge.from, []);
      forward.get(edge.from).push(edge.to);
    }
  }

  const starts = flow.nodes.filter((node) => incoming.get(node.id) === 0);
  if (starts.length !== 1) invalid('流程必须有且只有一个起始阶段');

  // 从唯一起始阶段沿任意条件的边做可达性（迭代 BFS）
  const reached = new Set([starts[0].id]);
  const queue = [starts[0].id];
  while (queue.length) {
    const id = queue.pop();
    for (const next of outgoing.get(id) || []) {
      if (reached.has(next)) continue;
      reached.add(next);
      queue.push(next);
    }
  }
  const orphans = flow.nodes.filter((node) => !reached.has(node.id));
  if (orphans.length) invalid(`这些阶段没有连到起始阶段：${orphans.map(flowNodeName).join('、')}`);

  // 通过边子图里同分量 ⇔ 该边在环上（边本身是正向边，只需 to 能回到 from）
  const component = flowComponents(flow.nodes.map((node) => node.id), forward);
  const reachable = new Map(); // 仅回边需要逐点可达性（走全部边），按起点记忆化
  const reachFrom = (startId) => {
    let reach = reachable.get(startId);
    if (!reach) {
      reach = new Set([startId]);
      const stack = [startId];
      while (stack.length) {
        const id = stack.pop();
        for (const next of outgoing.get(id) || []) {
          if (reach.has(next)) continue;
          reach.add(next);
          stack.push(next);
        }
      }
      reachable.set(startId, reach);
    }
    return reach;
  };
  for (const edge of flow.edges) {
    const label = () => `${flowNodeName(nodeById.get(edge.from))} → ${flowNodeName(nodeById.get(edge.to))}`;
    if (edge.condition !== 'rejected') {
      if (component.get(edge.from) === component.get(edge.to)) {
        invalid(`流程不能有由通过边构成的循环：${label()}`);
      }
      continue;
    }
    // 回边：从终点沿「任意边」（含 rejected）能回到起点即成环，A ⇄ B 互相打回也要算。
    // 与非 rejected 边刻意不对称：正向环只算通过边，否则默认模板的
    // 执行 --passed--> 评审 + 评审 --rejected--> 执行 会被误判成通过边环。
    if (!reachFrom(edge.to).has(edge.from)) continue;
    const loop = nodeById.get(edge.from).maxLoop;
    if (!(typeof loop === 'number' && Number.isInteger(loop) && loop >= 1)) {
      invalid(`回边必须设置打回上限（maxLoop ≥ 1）：${label()}`);
    }
  }
}

export function readSettings(roomId) {
  return readRoomSettings(roomId);
}

export function saveSettings(roomId, input) {
  assertRoomEditable(roomId);
  return saveRoomSettings(roomId, input);
}

export function updateRoom(roomId, patch) {
  const room = get('SELECT * FROM rooms WHERE id=?', [roomId]);
  if (!room) throw new Error('房间不存在');
  if (room.status === 'archived') {
    if (patch.flow !== undefined) throw staleResult('会话已归档，请先恢复再修改流程');
    throw new Error('会话已归档，请先恢复再修改');
  }
  if (patch.flow !== undefined) {
    assertRoomEditable(roomId);
    const currentFlow = safeJson(room.flow_json, defaultFlow());
    if (!Object.hasOwn(patch, 'expectedFlow')) {
      const error = new Error('缺少流程版本，请重新加载最新流程后再保存');
      error.statusCode = 400;
      throw error;
    }
    if (!isDeepStrictEqual(patch.expectedFlow, currentFlow)) {
      throw staleResult('流程已在其他地方更新，请重新加载最新流程后再保存');
    }
    // 负责人按房间成员校验：停用成员也算，历史流程里的旧名字不会被改写。
    const memberNames = new Set(all('SELECT name FROM members WHERE room_id=?', [roomId]).map((m) => m.name));
    validateEditableFlow(patch.flow, memberNames);
  }
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
  const live = [...taskOperations.values()].some((r) => r.roomId === roomId)
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

function execWorker({ worker, model, autoApprove, cwd, prompt, runId, roomId, taskId, timeoutMs, onSpawn, actor, waitForExitOnTimeout = false }) {
  return new Promise((resolve) => {
    let finished = false;
    let timedOut = false;
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
      onExit: (r) => done(timedOut ? { ...r, code: -2, error: '超时' } : r),
    });
    if (onSpawn) onSpawn(h.child.pid);
    timer = setTimeout(() => {
      timedOut = true;
      try { killTree(h.child.pid); } catch {}
      try { bus.emit('log', { roomId, taskId, runId, line: `[devhub] 超时，正在终止（${Math.round(timeoutMs / 1000)}s）`, stream: 'err', at: now() }); } catch {}
      if (!waitForExitOnTimeout) done({ code: -2, error: '超时', text: '', session: '', logPath: h.logPath });
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
  let plan = extractJson(res.text);
  if (!plan || !Array.isArray(plan.tasks)) {
    emit(roomId, null, runId, 'plan.failed', { error: res.error || '无法解析计划', raw: String(res.text || '').slice(0, 2000) });
    throw new Error(`计划生成失败：${res.error || '模型没有返回合法 JSON'}\n${String(res.text || '').slice(0, 800)}`);
  }
  try {
    plan = validatePlan(plan, { members, flow });
  } catch (error) {
    if (!(error instanceof PlanValidationError)) throw error;
    // Keep the original dependency values so the user can correct the draft explicitly.
    plan = { ...plan, validationErrors: error.issues };
  }
  run('UPDATE rooms SET plan_json=?, status=?, updated_at=? WHERE id=?', [JSON.stringify(plan), 'planning', now(), roomId]);
  emit(roomId, null, runId, 'plan.ready', { count: plan.tasks.length, summary: typeof plan.summary === 'string' ? plan.summary : '', validationErrors: plan.validationErrors || [] });
  return plan;
}

export function applyPlan(roomId, plan) {
  const room = get('SELECT * FROM rooms WHERE id=?', [roomId]);
  if (!room) throw new Error('房间不存在');
  if (room.status === 'archived') throw new Error('会话已归档，请先恢复再修改计划');
  const active = get(`SELECT COUNT(*) c FROM tasks WHERE room_id=? AND status='running'`, [roomId]).c;
  if (active > 0) throw new Error('还有任务在运行，不能覆盖计划');
  // 已经跑过的任务不能悄悄删掉：旧 worktree / 分支还在，同名任务重建会冲突，
  // 已合并的记录也会一起消失。要重新规划就开新会话。
  const existing = all('SELECT * FROM tasks WHERE room_id=?', [roomId]);
  if (existing.some((task) => taskOperations.has(task.id))) {
    throw new Error('还有任务正在启动或运行，不能覆盖计划');
  }
  const executed = existing.filter((t) => !['backlog', 'ready'].includes(t.status) || t.worktree || t.branch);
  if (executed.length) {
    throw new Error('这个会话已经有执行记录，重新生成计划会覆盖它们。请新建会话，或先归档当前会话。');
  }
  const members = all('SELECT * FROM members WHERE room_id=? ORDER BY sort, name', [roomId]).map(memberPayload);
  const flow = safeJson(room.flow_json, defaultFlow());
  const normalized = validatePlan(plan, { members, flow });
  const phases = Array.isArray(flow?.nodes) ? flow.nodes.filter((n) => n?.type === 'phase') : [];
  const ts = now();
  const created = transaction(() => {
    run('DELETE FROM tasks WHERE room_id=?', [roomId]);
    const created = [];
    normalized.tasks.forEach((task, i) => {
      const key = 'T' + (i + 1);
      const owner = members.find((m) => m.name === task.owner);
      // 只有计划里明确指定了阶段才绑定：门禁按阶段执行，不能拿任务顺序猜阶段。
      const phase = phases.find((p) => p.name === task.phase) || null;
      const id = uid('t');
      run(
        `INSERT INTO tasks (id, room_id, key, title, spec, type, owner_id, phase_id, status, deps_json, acceptance_json, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, roomId, key, task.title, task.spec, task.type, owner.id,
          phase?.id || null, task.dependsOn.length ? 'backlog' : 'ready', JSON.stringify(task.dependsOn.map((n) => 'T' + n)),
          JSON.stringify(task.acceptance), ts, ts],
      );
      created.push({ id, key });
    });
    for (const decision of normalized.decisions) {
      run('INSERT INTO decisions (id, room_id, text, rationale, status, created_at) VALUES (?,?,?,?,?,?)',
        [uid('d'), roomId, decision, '', 'active', ts]);
    }
    run('UPDATE rooms SET plan_json=?, status=?, updated_at=? WHERE id=?', ['', 'planning', ts, roomId]);
    return created;
  });
  emit(roomId, null, null, 'plan.applied', { count: created.length });
  return getRoomState(roomId);
}

export function createTask(input) {
  const invalid = (message, statusCode = 400) => {
    throw Object.assign(new Error(message), { statusCode });
  };
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('任务必须是 JSON 对象');
  const stringField = (key, fallback, label, trim = false) => {
    if (input[key] === undefined) return fallback;
    if (typeof input[key] !== 'string') invalid(`${label}必须是字符串`);
    return trim ? input[key].trim() : input[key];
  };
  const roomId = stringField('roomId', '', '会话编号', true);
  if (!roomId) invalid('请选择任务所属会话');
  const title = stringField('title', '新任务', '任务标题', true) || '新任务';
  const spec = stringField('spec', '', '任务说明');
  const type = input.type === undefined ? 'code' : input.type;
  if (!['code', 'document', 'research'].includes(type)) invalid('任务类型必须是 code、document 或 research');
  let ownerId = input.ownerId;
  if (ownerId === undefined || ownerId === null) ownerId = '';
  if (typeof ownerId !== 'string') invalid('负责人编号必须是字符串');
  ownerId = ownerId.trim();
  const stringList = (key, label) => {
    const value = input[key];
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
      invalid(`${label}必须是非空字符串数组`);
    }
    return value.map((item) => item.trim());
  };
  const deps = stringList('deps', '任务依赖');
  const acceptance = stringList('acceptance', '验收标准');
  if (new Set(deps).size !== deps.length) invalid('任务依赖不能重复');

  return transaction(() => {
    const room = get('SELECT * FROM rooms WHERE id=?', [roomId]);
    if (!room) invalid('会话不存在，请刷新后重试', 404);
    if (room.status === 'archived') invalid('会话已归档，请先恢复再添加任务', 409);
    const members = all('SELECT * FROM members WHERE room_id=? ORDER BY sort, name', [roomId]);
    const owner = ownerId ? members.find((member) => member.id === ownerId) : members.find((member) => member.enabled);
    if (!owner) invalid(ownerId ? '负责人不属于当前会话，请重新选择成员' : '当前会话没有启用成员，请在设置中启用后再添加任务');
    if (!owner.enabled) invalid(`负责人「${owner.name}」已停用，请换人或先启用成员`);
    if (!Object.hasOwn(WORKER_DEFS, owner.worker)) invalid(`负责人「${owner.name}」的 CLI 无效，请先在设置中重新选择`);
    const tasks = all('SELECT * FROM tasks WHERE room_id=?', [roomId]);
    const occupied = new Set(tasks.map((task) => task.key));
    let number = tasks.length + 1;
    while (occupied.has(`T${number}`)) number++;
    const key = `T${number}`;
    const byKey = new Map();
    for (const task of tasks) {
      if (!byKey.has(task.key)) byKey.set(task.key, []);
      byKey.get(task.key).push(task);
    }
    // Only inspect the selected upstream chain. Legacy errors elsewhere must not
    // block independent work, and iterative traversal handles long chains safely.
    const visited = new Set(), active = new Set();
    const stack = deps.slice().reverse().map((key) => ({ key, exit: false }));
    while (stack.length) {
      const current = stack.pop();
      if (current.exit) { active.delete(current.key); visited.add(current.key); continue; }
      if (current.key === key || active.has(current.key)) invalid('任务依赖存在循环，不能依赖自身或尚未创建的当前任务');
      if (visited.has(current.key)) continue;
      const matches = byKey.get(current.key) || [];
      if (matches.length !== 1) invalid(matches.length ? `依赖任务编号「${current.key}」重复，无法确定上游` : `依赖任务「${current.key}」不在当前会话中`);
      const upstream = matches[0];
      if (['merged', 'done'].includes(upstream.status)) { visited.add(current.key); continue; }
      let parentDeps;
      try { parentDeps = JSON.parse(upstream.deps_json); } catch {}
      if (!Array.isArray(parentDeps) || parentDeps.some((item) => typeof item !== 'string' || !item.trim()) || new Set(parentDeps).size !== parentDeps.length) {
        invalid(`依赖任务「${current.key}」的依赖格式无效，请先处理该任务`);
      }
      active.add(current.key);
      stack.push({ key: current.key, exit: true });
      for (let i = parentDeps.length - 1; i >= 0; i--) stack.push({ key: parentDeps[i], exit: false });
    }
    const id = uid('t'), ts = now();
    run(
      `INSERT INTO tasks (id, room_id, key, title, spec, type, owner_id, status, deps_json, acceptance_json, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, roomId, key, title, spec, type, owner.id, 'backlog', JSON.stringify(deps), JSON.stringify(acceptance), ts, ts],
    );
    if (room.status === 'completed') {
      run('UPDATE rooms SET status=?, updated_at=? WHERE id=?', ['paused', ts, roomId]);
      emit(roomId, null, null, 'room.paused', { reason: 'task.created' });
    }
    emit(roomId, id, null, 'task.created', { title });
    return { id };
  });
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

const STARTABLE_TASK_STATUSES = new Set(['backlog', 'ready', 'failed', 'cancelled', 'changes_requested', 'escalated']);

class TaskStartBlockedError extends Error {}

function taskStartContext(taskId, { automatic = false, reservedTaskId = null } = {}) {
  assertTaskAvailable(taskId, reservedTaskId ? running.get(reservedTaskId) : null);
  const block = (message) => { throw new TaskStartBlockedError(message); };
  const task = get('SELECT * FROM tasks WHERE id=?', [taskId]);
  if (!task) block('任务不存在，请刷新会话后重试');
  const room = get('SELECT * FROM rooms WHERE id=?', [task.room_id]);
  if (!room) block('任务所属会话不存在，请刷新后重新选择任务');
  if (room.status === 'archived') block('会话已归档，请先恢复会话再运行任务');
  if (automatic && room.status !== 'running') block('会话尚未开始或已暂停，请开始执行会话，或手动运行该任务');
  if (reservedTaskId ? task.status !== 'running' : !STARTABLE_TASK_STATUSES.has(task.status)) {
    if (['merged', 'done'].includes(task.status)) block('任务已经完成，不能重复运行；后续需求请新建任务');
    if (task.status === 'running') block('任务仍记录为运行中，请先取消该任务，再重试运行');
    block('当前任务状态不能运行，请先打回任务再按意见重跑，或继续评审、合并');
  }
  if (automatic && !reservedTaskId && task.status !== 'ready') block('任务尚未就绪，请先完成上游依赖');
  const member = task.owner_id ? get('SELECT * FROM members WHERE id=?', [task.owner_id]) : null;
  if (!member) block('任务没有有效负责人，请在计划中分配会话成员后再运行');
  if (member.room_id !== room.id) block('任务负责人不属于当前会话，请在计划中重新分配负责人');
  if (!member.enabled) block(`负责人「${member.name}」已停用，请在会话设置中启用或更换负责人`);
  if (!WORKER_DEFS[member.worker]) block(`负责人「${member.name}」的 CLI 无效，请在会话设置中重新选择 CLI`);
  if ([...liveRuns.values()].some((r) => r.kind === 'review' && r.taskId === taskId)) {
    block('这个任务正在评审，请等待评审结束，或先在会话顶部停止评审');
  }
  const deps = safeJson(task.deps_json, null);
  if (!Array.isArray(deps) || deps.some((key) => typeof key !== 'string')) {
    block('任务依赖格式无效，请重新确认计划，或新建依赖配置正确的任务');
  }
  const tasks = all('SELECT * FROM tasks WHERE room_id=?', [room.id]).map(mapTask);
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  const upstream = [];
  for (const key of deps) {
    const dependency = byKey.get(key);
    if (!dependency || dependency.id === task.id) block(`依赖 ${key} 无效，请重新确认计划，或新建依赖配置正确的任务`);
    if (!['merged', 'done'].includes(dependency.status)) {
      block(`依赖 ${key} 尚未完成，请先完成上游任务；有代码改动时还需合并，再运行当前任务`);
    }
    upstream.push(dependency);
  }
  const occupied = [...running.entries()].filter(([id]) => id !== reservedTaskId).map(([, live]) => live);
  if (occupied.length >= GLOBAL_LIMIT) block(`全局 ${GLOBAL_LIMIT} 个执行名额已满，请等待其他任务结束后再运行`);
  const roomLimit = room.mode === 'serial' ? 1 : ROOM_LIMIT;
  if (occupied.filter((live) => live.roomId === room.id).length >= roomLimit) {
    block(`当前会话的 ${roomLimit} 个执行名额已满，请等待会话内任务结束后再运行`);
  }
  const memberLimit = Math.max(1, Math.floor(Number(member.concurrency) || 1));
  if (occupied.filter((live) => live.memberId === member.id).length >= memberLimit) {
    block(`负责人「${member.name}」的并发已满，请等待其任务结束，或在会话设置中提高并发`);
  }
  return { task, room, member, upstream };
}

export function schedule() {
  const rooms = all(`SELECT * FROM rooms WHERE status='running'`);
  for (const room of rooms) {
    const tasks = all(`SELECT * FROM tasks WHERE room_id=? AND status='ready' ORDER BY created_at`, [room.id]);
    for (const task of tasks) {
      if (running.size >= GLOBAL_LIMIT) return;
      if (running.has(task.id)) continue;
      // startTask reserves synchronously. Eligibility failures leave queued tasks intact;
      // failures after reservation are recorded by startTask before it releases capacity.
      startTask(task.id, { automatic: true }).catch(() => {});
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

export async function startTask(taskId, { automatic = false } = {}) {
  if (running.has(taskId)) return { ok: true, already: true };
  const initial = taskStartContext(taskId, { automatic });
  const { task, room, member } = initial;
  const runId = uid('run');
  const holder = claimTaskOperation(taskId, { kind: 'run', roomId: room.id, memberId: member.id, runId, pid: 0, phase: 'starting', cancelled: false });
  running.set(taskId, holder);
  let result = null;
  let recorded = false;
  const cancelled = () => holder.cancelled || get('SELECT status FROM tasks WHERE id=?', [taskId])?.status === 'cancelled';
  const ownsRunningTask = () => running.get(taskId) === holder && !cancelled()
    && get('SELECT status FROM tasks WHERE id=?', [taskId])?.status === 'running';
  const finishRun = (status, error = '') => {
    if (!recorded) return;
    run('UPDATE runs SET status=?, session_id=?, exit_code=?, error=?, log_path=?, ended_at=? WHERE id=?', [
      status, result?.session || '', result?.code ?? null,
      error || result?.error || (result?.errors || []).join('; ').slice(0, 1000), result?.logPath || '', now(), runId,
    ]);
  };
  const finishCancelled = () => {
    finishRun('cancelled', '已取消');
    return { ok: false, cancelled: true };
  };
  const finishInterrupted = () => {
    finishRun('cancelled', '任务状态已变化，未采用旧运行结果');
    return { ok: false, interrupted: true };
  };

  try {
    run(`INSERT INTO runs (id, task_id, member_id, status, log_path, started_at, flow_json) VALUES (?,?,?,?,?,?,?)`,
      [runId, taskId, member.id, 'running', '', now(), room.flow_json]);
    recorded = true;
    // 升级后由人点「按意见重跑」是明确再给一轮机会：打回计数从 0 重新开始。
    setStatus(taskId, 'running', {
      summary: '', diff_stat: '', ...(task.status === 'escalated' ? { reject_count: 0 } : {}),
    });
    emit(room.id, taskId, runId, 'task.started', { member: member.name, worker: member.worker, key: task.key, phase: holder.phase });
    const wt = await ensureWorktree(taskPayload(task), roomPayload(room));
    if (cancelled()) return finishCancelled();

    let current;
    try {
      // A pause, disabled member or changed dependency during preparation must not
      // launch a stale worker. Restore the queued state rather than mark it failed.
      current = taskStartContext(taskId, { automatic, reservedTaskId: taskId });
    } catch (error) {
      if (!(error instanceof TaskStartBlockedError)) throw error;
      if (cancelled()) return finishCancelled();
      // 恢复排队状态时把打回计数一起还原：升级任务的重跑计数只在真正执行时清零。
      if (ownsRunningTask()) setStatus(taskId, task.status, {
        summary: task.summary || '', diff_stat: task.diff_stat || '', reject_count: task.reject_count || 0,
      });
      finishRun('cancelled', error.message);
      emit(room.id, taskId, runId, 'task.deferred', { reason: error.message });
      throw error;
    }
    const baseSha = current.task.base_sha || '';
    if (!baseSha) throw new Error('无法确定任务基准提交（base_sha 为空）');
    const decisions = all('SELECT * FROM decisions WHERE room_id=? AND status=?', [room.id, 'active']);
    const prompt = buildTaskPrompt({
      room: roomPayload(current.room), task: taskPayload(current.task), member: memberPayload(current.member),
      decisions, upstream: current.upstream, feedback: current.task.feedback || '', worktree: wt,
    });
    holder.memberId = current.member.id;
    holder.phase = 'running';
    emit(room.id, taskId, runId, 'task.phase', { phase: holder.phase });
    if (cancelled()) return finishCancelled();
    result = await execWorker({
      worker: current.member.worker, model: current.member.model, autoApprove: !!current.room.auto_approve,
      cwd: wt, prompt, runId, roomId: room.id, taskId,
      timeoutMs: task.type === 'code' ? 30 * 60 * 1000 : 20 * 60 * 1000,
      waitForExitOnTimeout: true,
      onSpawn: (pid) => { holder.pid = pid; if (holder.cancelled) killTree(pid); },
      actor: { name: current.member.name, worker: current.member.worker, kind: 'task' },
    });
    holder.pid = 0;
    if (cancelled()) return finishCancelled();
    if (!ownsRunningTask()) return finishInterrupted();
    holder.phase = 'collecting';
    emit(room.id, taskId, runId, 'task.phase', { phase: holder.phase });
    if (cancelled()) return finishCancelled();
    const committed = await G.commitAll(wt, `devhub(${task.key}): ${task.title}`);
    if (cancelled()) return finishCancelled();
    if (!ownsRunningTask()) return finishInterrupted();
    const resultSha = await G.commitSha(wt, 'HEAD');
    if (cancelled()) return finishCancelled();
    if (!ownsRunningTask()) return finishInterrupted();
    // Use the throwing Git operation: an unreadable diff is not a successful empty diff.
    const { stdout: stat } = await G.git(wt, ['diff', '--stat', baseSha, resultSha]);
    if (cancelled()) return finishCancelled();
    if (!ownsRunningTask()) return finishInterrupted();

    const summary = (result.text || '').trim() || (result.error ? `执行失败：${result.error}` : '（没有文本输出）');
    const failed = result.code !== 0;
    const noChange = !failed && !stat.trim();
    // 门禁决定这次产出要谁来确认：auto 有产出即通过，agent 等评审，human 等用户点通过。
    const gate = taskGate(current.room, current.task);
    const rejectCount = Number(current.task.reject_count) || 0;
    const nextStatus = failed ? 'failed' : noChange ? 'done' : gate.gate === 'auto' ? 'approved' : 'review';
    finishRun(failed ? 'failed' : 'completed');
    setStatus(taskId, nextStatus, { summary: summary.slice(0, 20000), diff_stat: stat, ...(!failed ? { result_sha: resultSha } : {}) });
    emit(room.id, taskId, runId, failed ? 'task.failed' : 'task.finished', {
      code: result.code, summary: summary.slice(0, 4000), stat, committed,
      noChange, status: nextStatus, resultSha: !failed ? resultSha : task.result_sha || '',
      session: result.session || '', cost: result.cost ?? null, usage: result.usage || null,
      gate: gate.gate, maxLoop: gate.maxLoop, rejectCount,
    });
    if (!failed && !noChange) {
      if (gate.gate === 'auto') {
        emit(room.id, taskId, runId, 'gate.passed', { gate: 'auto', resultSha, checks: ['diff'], maxLoop: gate.maxLoop, rejectCount });
      } else {
        emit(room.id, taskId, runId, 'gate.waiting', { gate: gate.gate, maxLoop: gate.maxLoop, rejectCount, resultSha });
      }
    }
    refreshReady(room.id);
    return { ok: !failed, code: result.code };
  } catch (error) {
    holder.pid = 0;
    if (cancelled()) return finishCancelled();
    if (error instanceof TaskStartBlockedError) throw error;
    const action = holder.phase === 'starting' ? '准备工作区失败，请检查仓库路径和基准分支后重试'
      : holder.phase === 'collecting' ? '收集改动失败，请检查工作区和 Git 错误后重试'
        : '启动或执行失败，请检查 CLI 配置和日志后重试';
    const message = `${action}：${String(error.message || error)}`;
    finishRun('failed', message);
    if (ownsRunningTask()) setStatus(taskId, 'failed', { summary: message });
    emit(room.id, taskId, runId, 'task.error', { error: message });
    throw new Error(message, { cause: error });
  } finally {
    if (running.get(taskId) === holder) running.delete(taskId);
    releaseTaskOperation(taskId, holder);
    maybeCompleteRoom(room.id);
    schedule();
  }
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

export async function reviewTask(taskId, { resultSha: expectedSha } = {}) {
  assertTaskAvailable(taskId);
  const task = get('SELECT * FROM tasks WHERE id=?', [taskId]);
  if (!task) throw new Error('任务不存在，请刷新会话后重试');
  const room = get('SELECT * FROM rooms WHERE id=?', [task.room_id]);
  if (!room) throw new Error('房间不存在，请刷新后重试');
  if (room.status === 'archived') throw new Error('会话已归档，请先恢复再评审');
  if (!['review', 'approved', 'changes_requested'].includes(task.status)) {
    throw new Error('当前任务没有可自动评审的成功产出，请先完成运行；需人工状态请直接审阅 Diff 后决定');
  }
  // 门禁不是「评审」的阶段不需要再跑评审进程：人工门禁等用户点通过，自动门禁已经通过。
  const gate = taskGate(room, task);
  if (gate.gate === 'human') throw new Error('这个阶段的门禁是人工确认，请点「通过」或「退回修改」，不需要自动评审');
  if (gate.gate === 'auto') throw new Error('这个阶段的门禁是自动通过，有产出就已经通过，不需要自动评审');
  const members = all('SELECT * FROM members WHERE room_id=?', [room.id]).map(memberPayload);
  const reviewer = members.find((m) => m.id === room.reviewer_id) || members[members.length - 1];
  if (!reviewer || !reviewer.enabled) throw new Error('没有启用的评审者，请在会话设置中启用或更换评审者');
  if (!WORKER_DEFS[reviewer.worker]) throw new Error('评审者 CLI 无效，请在会话设置中重新选择 CLI');
  const reviewed = get('SELECT COUNT(*) c FROM reviews WHERE task_id=?', [taskId]).c || 0;
  const rejectCount = Number(task.reject_count) || 0;
  if (rejectCount >= gate.maxLoop) {
    throw new Error(`这个任务已经打回 ${gate.maxLoop} 次，达到本阶段上限，请人工决定：按意见重跑、人工通过或取消`);
  }
  const runId = uid('run');
  const holder = claimTaskOperation(taskId, { kind: 'review', roomId: room.id, taskId, pid: 0, cancelled: false });
  liveRuns.set(runId, holder);
  try {
    emit(room.id, taskId, runId, 'review.started', { reviewer: reviewer.name, worker: reviewer.worker, key: task.key });
    const frozen = await readTaskResult(taskId, expectedSha, holder);
    if (!frozen.diff) throw new Error('固定成果没有可评审的改动，请刷新 Diff 后确认是否需要重跑');
    const dirtyBefore = await G.trackedStatus(task.worktree);
    const headBefore = await G.commitSha(task.worktree, 'HEAD');
    assertResultSnapshot(frozen.task, room, holder);
    if (dirtyBefore || headBefore !== frozen.resultSha) {
      throw staleResult('评审工作区已偏离固定成果，请先保留并处理工作区中的改动，重跑任务或恢复到已展示的提交后重试');
    }
    const prompt = buildReviewPrompt({
      room: roomPayload(room), task: taskPayload(frozen.task), member: reviewer,
      diff: frozen.diff, acceptance: taskPayload(frozen.task).acceptance, worktree: task.worktree,
    });
    const result = await execWorker({
      worker: reviewer.worker, model: reviewer.model, autoApprove: false,
      cwd: task.worktree, prompt, runId, roomId: room.id, taskId, timeoutMs: 8 * 60 * 1000,
      waitForExitOnTimeout: true,
      actor: { name: reviewer.name, worker: reviewer.worker, kind: 'review' },
      onSpawn: (pid) => { holder.pid = pid; if (holder.cancelled) killTree(pid); },
    });
    holder.pid = 0;
    if (holder.cancelled) throw new Error('评审已取消');
    if (result.code !== 0) {
      throw new Error(`评审进程未成功结束（${result.code ?? '未知退出码'}）：${result.error || '请检查 CLI 日志后重试，或人工审阅 Diff 后合并'}`);
    }
    const dirtyAfter = await G.trackedStatus(task.worktree);
    const headAfter = await G.commitSha(task.worktree, 'HEAD');
    assertResultSnapshot(frozen.task, room, holder);
    if (dirtyAfter || headAfter !== frozen.resultSha) {
      throw new Error('评审过程中修改了已跟踪文件或提交，结果不能采用；请保留并处理这些改动后重试，或人工审阅固定 Diff');
    }
    const parsed = extractJson(result.text);
    if (!parsed || !['approve', 'request_changes'].includes(parsed.verdict)
      || (parsed.blocking !== undefined && (!Array.isArray(parsed.blocking) || parsed.blocking.some((item) => !item || typeof item !== 'object')))) {
      throw new Error('评审没有返回合法结论，请检查评审角色约束后重试，或人工审阅 Diff 后合并');
    }
    const verdict = { ...parsed, blocking: parsed.blocking || [], resultSha: frozen.resultSha };
    if (verdict.verdict === 'approve' && verdict.blocking.length) throw new Error('评审同时返回通过和阻塞问题，请人工审阅 Diff 后决定');
    const round = reviewed + 1;
    const approve = verdict.verdict === 'approve';
    const lines = verdict.blocking.map((b) => `- ${b.file || '?'}:${b.line || '?'} ${b.issue || ''} → ${b.suggestion || ''}`);
    const feedback = approve ? task.feedback || ''
      : `${task.feedback ? task.feedback + '\n\n' : ''}第 ${round} 轮评审：\n${lines.join('\n') || verdict.notes || '需要修改'}`.slice(0, 20000);
    const nextRejectCount = approve ? rejectCount : rejectCount + 1;
    const nextStatus = approve ? 'approved' : nextRejectCount >= gate.maxLoop ? 'escalated' : 'changes_requested';
    assertResultSnapshot(frozen.task, room, holder);
    transaction(() => {
      run('INSERT INTO reviews (id, task_id, round, verdict, payload, created_at) VALUES (?,?,?,?,?,?)',
        [uid('rv'), taskId, round, verdict.verdict, JSON.stringify(verdict), now()]);
      run('UPDATE tasks SET status=?, feedback=?, reject_count=?, updated_at=? WHERE id=?',
        [nextStatus, feedback, nextRejectCount, now(), taskId]);
    });
    emit(room.id, taskId, null, 'task.status', { status: nextStatus, key: task.key, title: task.title });
    emit(room.id, taskId, runId, 'review.done', {
      verdict: verdict.verdict, round, escalated: nextStatus === 'escalated',
      notes: verdict.notes || '', resultSha: frozen.resultSha, maxLoop: gate.maxLoop, rejectCount: nextRejectCount,
    });
    if (nextStatus === 'escalated') {
      emit(room.id, taskId, runId, 'gate.escalated', {
        gate: gate.gate, by: 'agent', maxLoop: gate.maxLoop, rejectCount: nextRejectCount, round,
      });
    }
    return { verdict, round, resultSha: frozen.resultSha };
  } catch (error) {
    const message = holder.cancelled ? '评审已取消，未采用评审结论' : `自动评审失败：${String(error.message || error)}`;
    emit(room.id, taskId, runId, holder.cancelled ? 'review.cancelled' : 'review.failed', { error: message });
    if (error.statusCode) { error.message = message; throw error; }
    throw new Error(message, { cause: error });
  } finally {
    liveRuns.delete(runId);
    releaseTaskOperation(taskId, holder);
    schedule();
  }
}

export function rejectTask(taskId, note) {
  assertTaskAvailable(taskId);
  const task = get('SELECT * FROM tasks WHERE id=?', [taskId]);
  if (!task) throw new Error('任务不存在');
  if (!['review', 'approved', 'escalated'].includes(task.status)) throw new Error('当前状态不能打回，请刷新任务后选择运行、评审或新建任务');
  const room = get('SELECT * FROM rooms WHERE id=?', [task.room_id]);
  if (room?.status === 'archived') throw new Error('会话已归档，请先恢复再操作');
  const gate = taskGate(room, task);
  const old = task.feedback ? task.feedback + '\n\n' : '';
  const rejectCount = Number(task.reject_count) || 0;
  // 已经升级的任务再打回，是人工明确再给一轮机会：回到「待修改」并把计数清零。
  const nextRejectCount = task.status === 'escalated' ? 0 : rejectCount + 1;
  const nextStatus = task.status === 'escalated' ? 'changes_requested'
    : nextRejectCount >= gate.maxLoop ? 'escalated' : 'changes_requested';
  setStatus(taskId, nextStatus, { feedback: (old + '人工打回：' + (note || '请修改') + '').slice(0, 20000), reject_count: nextRejectCount });
  emit(task.room_id, taskId, null, 'task.rejected', { note: note || '', escalated: nextStatus === 'escalated', maxLoop: gate.maxLoop, rejectCount: nextRejectCount });
  if (nextStatus === 'escalated') {
    emit(task.room_id, taskId, null, 'gate.escalated', { gate: gate.gate, by: 'human', maxLoop: gate.maxLoop, rejectCount: nextRejectCount });
  }
}

/** 人工确认门禁：把固定成果标记为通过，之后仍由用户手动合并。 */
export function approveTask(taskId) {
  assertTaskAvailable(taskId);
  const task = get('SELECT * FROM tasks WHERE id=?', [taskId]);
  if (!task) throw new Error('任务不存在，请刷新会话后重试');
  const room = get('SELECT * FROM rooms WHERE id=?', [task.room_id]);
  if (!room) throw new Error('任务所属会话不存在，请刷新后重试');
  if (room.status === 'archived') throw new Error('会话已归档，请先恢复再操作');
  if (task.status === 'approved') throw new Error('任务已经通过，等待合并即可');
  if (task.status === 'running') throw new Error('任务正在执行，结束后再确认');
  if (!['review', 'escalated'].includes(task.status)) throw new Error('当前任务没有可确认的成果，请先运行任务');
  if (!task.result_sha) throw new Error('任务没有可确认的成果，请先运行任务');
  const gate = taskGate(room, task);
  setStatus(taskId, 'approved');
  emit(room.id, taskId, null, 'gate.passed', {
    gate: gate.gate, by: 'human', manual: gate.gate !== 'human',
    maxLoop: gate.maxLoop, rejectCount: Number(task.reject_count) || 0, resultSha: task.result_sha,
  });
  return { status: 'approved' };
}

export function retryTask(taskId) {
  if (running.has(taskId)) throw new TaskStartBlockedError('任务仍在准备、执行或收尾，请等待结束后再重试');
  const { task } = taskStartContext(taskId);
  setStatus(taskId, 'ready');
  emit(task.room_id, taskId, null, 'task.retry', {});
  schedule();
}

export function cancelTask(taskId) {
  const task = get('SELECT * FROM tasks WHERE id=?', [taskId]);
  if (!task) throw new Error('任务不存在，请刷新会话后重试');
  const room = get('SELECT * FROM rooms WHERE id=?', [task.room_id]);
  if (room?.status === 'archived') throw new Error('会话已归档，请先恢复会话再取消任务');
  if (['merged', 'done'].includes(task.status)) throw new Error('任务已经完成，不能取消；后续需求请新建任务');
  const operation = taskOperations.get(taskId);
  if (operation && !['run', 'review'].includes(operation.kind)) {
    throw new Error('任务正在合并或读取成果，请等待完成后刷新再操作');
  }
  const live = running.get(taskId);
  if (operation?.kind === 'review') {
    operation.cancelled = true;
    if (operation.pid) killTree(operation.pid);
  }
  if (live) {
    live.cancelled = true;
    if (live.pid) killTree(live.pid);
  }
  if (task.status !== 'cancelled') {
    setStatus(taskId, 'cancelled');
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

/** Count task executions and plan/review operations that global stop can signal. */
export function activeWorkerCount() {
  return running.size + [...liveRuns.values()].filter((run) => ['plan', 'review'].includes(run.kind)).length;
}

/** Stop only task runs and plan/review workers; merges and read-only operations are intentionally excluded. */
export function stopAll() {
  let stopped = 0;
  const taskIds = [...running.keys()];
  const liveRooms = new Set([...liveRuns.values()]
    .filter((run) => ['plan', 'review'].includes(run.kind))
    .map((run) => run.roomId));
  const activeRooms = new Set([
    ...taskIds.map((taskId) => running.get(taskId)?.roomId).filter(Boolean),
    ...liveRooms,
  ]);
  // Pause dispatch before cancellation. Otherwise a worker's `finally` can
  // schedule the next ready task while this stop request is still draining.
  for (const roomId of activeRooms) {
    const roomStatus = get('SELECT status FROM rooms WHERE id=?', [roomId])?.status;
    if (roomStatus && !['paused', 'archived'].includes(roomStatus)) pauseRoom(roomId);
  }
  for (const taskId of taskIds) {
    try {
      cancelTask(taskId);
      stopped++;
    } catch {}
  }
  for (const roomId of liveRooms) {
    try { stopped += cancelRoomRun(roomId); } catch {}
  }
  return stopped;
}

export async function mergeTask(taskId, { resultSha: expectedSha } = {}) {
  assertTaskAvailable(taskId);
  const task = get('SELECT * FROM tasks WHERE id=?', [taskId]);
  if (!task) throw new Error('任务不存在，请刷新会话后重试');
  const room = get('SELECT * FROM rooms WHERE id=?', [task.room_id]);
  if (!room) throw new Error('房间不存在，请刷新后重试');
  if (room.status === 'archived') throw new Error('会话已归档，请先恢复再合并');
  if (!MERGE_STATUSES.has(task.status)) throw new Error('当前任务没有可合并的成功产出，请先完成运行并查看最新 Diff');
  const holder = claimTaskOperation(taskId, { kind: 'merge', roomId: room.id, cancelled: false });
  const job = mergeQueue.then(() => mergeTaskInner(taskId, expectedSha, holder));
  mergeQueue = job.then(() => {}, () => {});
  try {
    return await job;
  } catch (error) {
    emit(room.id, taskId, null, 'task.merge_failed', { error: String(error.message || error) });
    throw error;
  } finally {
    releaseTaskOperation(taskId, holder);
    schedule();
  }
}

async function mergeTaskInner(taskId, expectedSha, holder) {
  const task = get('SELECT * FROM tasks WHERE id=?', [taskId]);
  if (!task || !MERGE_STATUSES.has(task.status)) throw staleResult();
  const room = get('SELECT * FROM rooms WHERE id=?', [task.room_id]);
  if (!room || room.status === 'archived') throw new Error('会话不可合并，请先恢复会话并刷新 Diff');
  emit(room.id, taskId, null, 'task.merge_started', {});
  const frozen = await readTaskResult(taskId, expectedSha, holder);
  assertResultSnapshot(frozen.task, room, holder);
  if (frozen.diff) {
    await G.mergeSquash(room.repo_path, room.base_branch, frozen.resultSha, `devhub(${task.key}): ${task.title}`);
    assertResultSnapshot(frozen.task, room, holder);
  }
  transaction(() => {
    assertResultSnapshot(frozen.task, room, holder);
    const nextStatus = frozen.diff ? 'merged' : 'done';
    setStatus(taskId, nextStatus);
    emit(room.id, taskId, null, 'task.merged', { branch: task.branch, resultSha: frozen.resultSha, noChange: !frozen.diff });
    refreshReady(room.id);
    maybeCompleteRoom(room.id);
  });
  return { ok: true, resultSha: frozen.resultSha, ...(!frozen.diff ? { noChange: true } : {}) };
}

export async function taskDiff(taskId) {
  const task = get('SELECT * FROM tasks WHERE id=?', [taskId]);
  if (!task) throw new Error('任务不存在，请刷新会话后重试');
  if (!task.result_sha && (!RESULT_STATUSES.has(task.status) || !task.branch)) return { diff: '', resultSha: '' };
  const owner = task.result_sha ? null : claimTaskOperation(taskId, { kind: 'diff', roomId: task.room_id, cancelled: false });
  try {
    const frozen = await readTaskResult(taskId, undefined, owner);
    return { diff: frozen.diff, resultSha: frozen.resultSha };
  } catch (error) {
    if (error.statusCode) throw error;
    throw new Error(`无法读取固定成果，请检查仓库、任务分支或重新运行任务：${String(error.message || error)}`, { cause: error });
  } finally {
    if (owner) releaseTaskOperation(taskId, owner);
  }
}

export function taskLog(taskId) {
  const row = get('SELECT * FROM runs WHERE task_id=? ORDER BY started_at DESC LIMIT 1', [taskId]);
  if (!row || !row.log_path || !existsSync(row.log_path)) return '';
  try { return readFileSync(row.log_path, 'utf8'); } catch { return ''; }
}

export function runningTasks() {
  return [...running.entries()].map(([taskId, v]) => ({ taskId, ...v }));
}
