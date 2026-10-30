const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
};

const STATUS = {
  draft: '草稿', planning: '计划中', running: '执行中', paused: '已暂停',
  completed: '已完成', archived: '已归档',
  backlog: '待办', ready: '就绪', review: '待评审', changes_requested: '待修改',
  approved: '已通过', merged: '已合并', done: '已完成',
  failed: '失败', escalated: '已升级', cancelled: '已取消',
};

/** 流程阶段可以挂的产物标记。只是标签，不参与执行；给用户点选，避免手敲。 */
const ARTIFACT_TYPES = [
  { key: 'brief', label: '需求说明' },
  { key: 'prd', label: '需求文档' },
  { key: 'outline', label: '大纲' },
  { key: 'design', label: '方案设计' },
  { key: 'code_diff', label: '代码改动' },
  { key: 'review_report', label: '评审报告' },
  { key: 'deliverable', label: '交付物' },
  { key: 'sources', label: '资料清单' },
  { key: 'draft', label: '初稿' },
  { key: 'question', label: '问题定义' },
  { key: 'findings', label: '调研发现' },
  { key: 'verification', label: '验证结论' },
];

const state = {
  rooms: [], running: [], workers: [],
  roomId: null, room: null, members: [], tasks: [], events: [], decisions: [], reviews: [],
  tab: 'board',
  selectedTaskId: null,
  drawerTab: 'overview',
  log: '', diff: '', logLive: true,
  planDraft: null,
  settingsRemoved: [],
  flowSelected: null,
  flowAdvanced: (() => { try { return localStorage.getItem('devhub.flowAdvanced') === '1'; } catch { return false; } })(),
  flowTemplates: [],
  repoPicker: null,
  refreshTimer: null,
  activity: new Map(),
  roomLive: null,
  showArchived: (() => { try { return localStorage.getItem('devhub.showArchived') === '1'; } catch { return false; } })(),
  live: 'connecting',
  mainSig: '',
  drawerSig: '',
};

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('#toast-root').appendChild(el);
  setTimeout(() => el.remove(), kind === 'err' ? 9000 : 4500);
}

/* ---------------- boot ---------------- */

async function boot() {
  try {
    const w = await api('/api/workers');
    state.workers = w.workers || [];
  } catch (e) { console.warn(e); }
  renderRail();
  try {
    await refreshState();
    if (state.rooms.length) await openRoom(state.rooms[0].id);
  } catch (e) { toast(e.message, 'err'); }
  connectEvents();
  // 兜底轮询：只在 SSE 断开时生效，正常情况下界面完全由事件驱动
  setInterval(() => {
    if (state.live !== 'open') refreshState(true).catch(() => {});
  }, 5000);
  // 运行中任务的计时器是纯本地计算，不需要请求服务端
  setInterval(tickElapsed, 1000);
}

function setLive(kind) {
  state.live = kind;
  const el = $('#live-badge');
  if (!el) return;
  el.className = 'pill live ' + kind;
  el.textContent = kind === 'open' ? '实时' : kind === 'down' ? '重连中' : '连接中';
}

function connectEvents() {
  try {
    const es = new EventSource('/api/events');
    es.onopen = () => {
      const wasDown = state.live !== 'open';
      setLive('open');
      if (wasDown) refreshState(true).catch(() => {});
    };
    es.onerror = () => setLive('down');
    es.onmessage = (e) => {
      let d;
      try { d = JSON.parse(e.data); } catch { return; }
      if (d.kind === 'log') {
        const what = d.activity || '';
        if (d.taskId && what) {
          state.activity.set(d.taskId, { line: what, at: d.at });
          updateCardLive(d.taskId, what);
        }
        // 计划 / 评审不是任务，用会话级活动条展示；只看当前会话，避免别的会话串台
        if (d.actor && d.actor.kind !== 'task' && what && d.roomId === state.roomId) {
          setRoomLive(d.actor.name, d.actor.worker, d.actor.kind, what);
        }
        if (d.taskId && d.taskId === state.selectedTaskId) appendLog(d.line, d.stream);
        return;
      }
      const mine = d.room_id === state.roomId;
      if (mine && d.type === 'plan.started') setRoomLive(d.payload?.planner, d.payload?.worker, 'plan', '正在拆解需求…');
      if (mine && d.type === 'review.started') setRoomLive(d.payload?.reviewer, d.payload?.worker, 'review', '正在阅读 diff…');
      if (mine && ['plan.ready', 'plan.failed', 'plan.cancelled', 'review.done', 'review.failed', 'review.cancelled', 'room.completed', 'room.paused'].includes(d.type)) clearRoomLive();
      // 任何事件都当作数据可能变化的信号；会话内的变化立即刷新，其他会话只刷左侧列表
      if (d.room_id && d.room_id === state.roomId) scheduleRefresh();
      scheduleRailRefresh();
    };
  } catch (e) { console.warn(e); }
}

function scheduleRefresh() {
  if (state.refreshTimer) return;
  state.refreshTimer = setTimeout(() => {
    state.refreshTimer = null;
    refreshState(true).catch(() => {});
  }, 350);
}

let railTimer = null;
function scheduleRailRefresh() {
  if (railTimer) return;
  railTimer = setTimeout(async () => {
    railTimer = null;
    try {
      const d = await api('/api/state');
      state.rooms = d.rooms;
      state.running = d.running;
      renderRail();
    } catch {}
  }, 1200);
}

async function refreshState(silent) {
  const d = await api('/api/state');
  state.rooms = d.rooms || [];
  state.running = d.running || [];
  state.flowTemplates = d.flowTemplates || [];
  renderRail();
  if (state.roomId) {
    const r = await api('/api/rooms/' + state.roomId);
    state.room = r.room;
    state.members = r.members;
    state.tasks = r.tasks;
    state.events = r.events;
    state.decisions = r.decisions;
    state.reviews = r.reviews;
  }
  renderMain();
  if (state.selectedTaskId) renderDrawer();
  if (!silent && !state.roomId) renderMain();
}

/** 只有渲染输入真的变了才重建 DOM，避免每个事件都把看板/抽屉整体重置。 */
function mainSignature() {
  return JSON.stringify([
    state.roomId,
    state.tab,
    state.flowSelected,
    state.flowAdvanced,
    state.room && [state.room.status, state.room.name, state.room.requirement, state.room.mode,
      state.room.auto_approve, state.room.flow, state.room.updated_at],
    state.members.map((m) => [m.id, m.name, m.worker, m.role_name, m.role_brief, m.model, m.concurrency, m.enabled]),
    state.tasks.map((t) => [t.id, t.status, t.title, t.spec, t.owner_id, t.updated_at, t.diff_stat]),
    state.decisions.length,
    state.events.length,
  ]);
}

function drawerSignature(t) {
  if (!t) return '';
  return JSON.stringify([
    state.drawerTab,
    t.id, t.status, t.updated_at, t.summary, t.feedback, t.diff_stat,
    state.reviews.length,
    state.drawerTab === 'diff' ? state.diff.length : 0,
  ]);
}

async function openRoom(id) {
  state.roomId = id;
  state.tab = 'board';
  state.selectedTaskId = null;
  state.flowSelected = null;
  state.activity.clear();
  clearRoomLive();
  await refreshState(true);
}

/* ---------------- rail ---------------- */

function workerLabel(key) {
  if (!key) return '';
  return state.workers.find((w) => w.key === key)?.label || key;
}

function renderRail() {
  const list = $('#room-list');
  if (!list) return;
  const btn = $('#btn-archived');
  if (btn) btn.textContent = state.showArchived ? '隐藏归档' : '显示归档';
  const rooms = state.rooms.filter((r) => state.showArchived || r.status !== 'archived' || r.id === state.roomId);
  list.innerHTML = rooms.length
    ? rooms.map((r) => {
      const active = r.id === state.roomId ? ' active' : '';
      const archived = r.status === 'archived' ? ' archived' : '';
      const dot = r.counts.failed ? 'failed' : r.counts.running ? 'running' : r.counts.review ? 'review' : r.status === 'completed' ? 'completed' : '';
      return `<div class="room-item${active}${archived}" data-act="open-room" data-id="${r.id}">
        <div class="ri-top"><span class="dot ${dot}"></span><span class="ri-name">${esc(r.name)}</span></div>
        <div class="ri-sub"><span>${r.counts.total} 任务</span><span>${r.counts.running} 运行</span><span>${r.counts.review} 待审</span>${archived ? '<span>已归档</span>' : ''}</div>
      </div>`;
    }).join('')
    : `<div class="small" style="color:#6f6e67;padding:8px">${state.rooms.length ? '没有活跃会话，点上方「显示归档」查看历史' : '还没有会话'}</div>`;

  $('#worker-list').innerHTML = state.workers.map((w) => `
    <div class="worker-row ${w.available ? 'on' : ''}">
      <span class="dot ${w.available ? 'running' : ''}"></span>
      <span class="w-name">${esc(w.label)}</span>
      <span class="w-state">${w.available ? '就绪' : '未装'}</span>
    </div>`).join('');
}

/* ---------------- main ---------------- */

function renderMain(force = false) {
  const main = $('#main');
  if (!state.room) {
    main.innerHTML = renderOverview();
    state.mainSig = '';
    return;
  }
  const sig = mainSignature();
  if (!force && sig === state.mainSig) return;
  state.mainSig = sig;

  // 局部刷新不应该打断阅读位置
  const oldBoard = $('.board', main);
  const scrollTop = oldBoard ? oldBoard.scrollTop : 0;
  const oldCanvas = $('.flow-canvas', main);
  const scrollLeft = oldCanvas ? oldCanvas.scrollLeft : 0;

  main.innerHTML = renderRoom();

  const newBoard = $('.board', main);
  if (newBoard && scrollTop) newBoard.scrollTop = scrollTop;
  const newCanvas = $('.flow-canvas', main);
  if (newCanvas && scrollLeft) newCanvas.scrollLeft = scrollLeft;
  wireFlow();
}

function renderOverview() {
  const cards = state.rooms.map((r) => `
    <div class="ov-card" data-act="open-room" data-id="${r.id}">
      <h3>${esc(r.name)}</h3>
      <div class="ov-req">${esc(r.requirement || '（没有填写需求）')}</div>
      <div class="ov-metrics">
        <div><b>${r.counts.total}</b>任务</div>
        <div><b>${r.counts.running}</b>运行</div>
        <div><b>${r.counts.review}</b>待审</div>
        <div><b>${r.counts.done}</b>完成</div>
      </div>
    </div>`).join('');
  return `<div class="overview">
    <h1>协作总览</h1>
    <div class="sub">一个需求一个会话。所有会话的上下文互相隔离。</div>
    <div class="ov-grid">
      ${cards}
      <div class="ov-card" data-act="new-room" style="display:grid;place-items:center;min-height:150px;border-style:dashed;">
        <div class="muted">＋ 新建会话</div>
      </div>
    </div>
  </div>`;
}

function renderRoom() {
  const r = state.room;
  const archived = r.status === 'archived';
  const hasTasks = state.tasks.length > 0;
  return `
  <div class="room-head">
    <div>
      <h1>${esc(r.name)}</h1>
      <div class="room-req">${esc(r.requirement || '还没有填写需求')}</div>
    </div>
    <div class="room-actions">
      ${archived ? '<button class="btn primary" data-act="restore-room">恢复会话</button>' : `
      <button class="btn ${hasTasks ? '' : 'primary'}" data-act="plan-room">生成计划</button>
      <button class="btn" data-act="add-task">添加任务</button>
      <button class="btn ${hasTasks && r.status !== 'running' ? 'primary' : ''}" data-act="toggle-run"
        ${hasTasks ? '' : 'disabled title="先生成计划或添加任务"'}>
        ${r.status === 'running' ? '暂停' : '开始执行'}
      </button>`}
      <button class="btn ghost" data-act="room-settings">设置</button>
      <button class="btn ghost" data-act="refresh" title="刷新">↻</button>
    </div>
  </div>
  ${archived ? '<div class="room-archived">这个会话已归档。流程、成员和任务都保留，但不能再执行或修改；点「恢复会话」继续。</div>' : ''}
  <div class="room-live ${state.roomLive ? '' : 'hidden'}" id="room-live">
    <span class="pulse"></span>
    <b class="rl-who">${esc(state.roomLive?.name || '')}</b>
    <span class="rl-worker">${esc(state.roomLive?.worker ? workerLabel(state.roomLive.worker) : '')}</span>
    <span class="rl-kind">${state.roomLive?.kind === 'plan' ? '规划中' : '评审中'}</span>
    <span class="rl-doing">${esc(state.roomLive?.text || '')}</span>
    <button class="btn sm ghost" data-act="cancel-room-run">停止</button>
  </div>
  <div class="room-meta">
    <span class="pill mono">${esc(r.repo_path)}</span>
    <span class="pill mono">${esc(r.base_branch)}</span>
    <span class="pill">${esc(r.status ? STATUS[r.status] || r.status : '')}</span>
    <span class="pill live ${state.live}" id="live-badge">${state.live === 'open' ? '实时' : state.live === 'down' ? '重连中' : '连接中'}</span>
    <button class="switch ${r.mode === 'serial' ? 'on' : ''}" data-act="toggle-mode">
      ${r.mode === 'serial' ? '串行' : '并行'}
    </button>
    <button class="switch warn ${r.auto_approve ? 'on' : ''}" data-act="toggle-auto" title="开：允许 agent 改文件、跑命令；关：更保守的只读沙箱">
      自动执行：${r.auto_approve ? '开' : '关'}
    </button>
    <button class="switch" data-act="decisions">决策 ${state.decisions.length}</button>
    <div class="tabs">
      <button class="tab ${state.tab === 'board' ? 'active' : ''}" data-act="tab" data-tab="board">任务板</button>
      <button class="tab ${state.tab === 'flow' ? 'active' : ''}" data-act="tab" data-tab="flow">流程</button>
    </div>
  </div>
  ${renderMembers()}
  ${state.tab === 'flow' ? renderFlow() : renderBoard()}`;
}

function renderMembers() {
  return `<div class="member-strip">${state.members.map((m) => {
    const task = state.tasks.find((t) => t.owner_id === m.id && t.status === 'running');
    const act = task ? state.activity.get(task.id) : null;
    return `<div class="member-chip ${task ? 'busy' : ''}" data-member="${m.id}">
      <span class="dot ${task ? 'running' : ''}"></span>
      <div class="mc-body">
        <div class="mc-name">${esc(m.name)}<span class="mc-worker">${esc(workerLabel(m.worker))}</span></div>
        <div class="mc-role">${esc(m.role_name || '未命名角色')} · ${m.concurrency}x</div>
        ${task ? `<div class="mc-now">
            <span class="mc-key">${esc(task.key)}</span>
            <span class="mc-since" data-since="${esc(task.updated_at)}">0:00</span>
            <span class="mc-doing">${esc(act?.line || '正在启动…')}</span>
          </div>` : ''}
      </div>
    </div>`;
  }).join('') || '<div class="small muted">还没有成员</div>'}</div>`;
}

const COLUMNS = [
  { key: 'todo', name: '待办', statuses: ['backlog', 'ready'] },
  { key: 'running', name: '运行中', statuses: ['running'] },
  { key: 'review', name: '待处理', statuses: ['review', 'changes_requested', 'approved', 'escalated', 'failed'] },
  { key: 'done', name: '完成', statuses: ['merged', 'done'] },
];

function memberName(id) {
  return state.members.find((m) => m.id === id)?.name || '未指派';
}

function renderBoard() {
  const failed = state.tasks.filter((t) => ['failed', 'escalated'].includes(t.status));
  const alert = failed.length ? `<div class="board-alert" style="grid-column:1/-1;background:var(--red-soft);border:1px solid #ecc9c4;border-radius:9px;padding:8px 12px;font-size:12px;color:var(--red);margin-bottom:2px">
      有 ${failed.length} 个任务异常：${failed.map((t) => esc(t.key)).join('、')} —— 打开任务查看原因
    </div>` : '';
  const guide = !state.tasks.length && state.room.status !== 'archived' ? `<div class="board-guide">
      <div class="bg-title">这个会话还没有任务，按三步开始</div>
      <div class="bg-steps">
        <span class="bg-step"><b>1</b> 生成计划</span>
        <span class="bg-arrow">→</span>
        <span class="bg-step"><b>2</b> 在弹窗里确认</span>
        <span class="bg-arrow">→</span>
        <span class="bg-step"><b>3</b> 开始执行</span>
      </div>
      <div class="hint">Planner 只负责拆任务；你确认后才会创建。每个任务在自己的 worktree 里改，改完再看 diff、评审、合并。</div>
    </div>` : '';
  const cols = COLUMNS.map((c) => {
    const items = state.tasks.filter((t) => c.statuses.includes(t.status));
    return `<div class="col ${c.key}">
      <div class="col-head"><span class="bar"></span><b>${c.name}</b><span>${items.length}</span></div>
      ${items.map((t) => taskCard(t)).join('')}
      ${items.length ? '' : '<div class="small muted" style="padding:8px 4px">—</div>'}
    </div>`;
  }).join('');
  return `<div class="board-wrap">
    <div class="board">${alert}${guide}${cols}</div>
    ${renderTimeline()}
  </div>`;
}

function taskCard(t) {
  const cls = ['failed', 'escalated'].includes(t.status) ? 'failed' : t.status === 'running' ? 'running' : ['review', 'changes_requested', 'approved'].includes(t.status) ? 'review' : '';
  const badge = t.status === 'changes_requested' ? '<span class="badge warn">待修改</span>'
    : t.status === 'escalated' ? '<span class="badge err">需人工</span>'
      : t.status === 'failed' ? '<span class="badge err">失败</span>'
        : t.status === 'approved' ? '<span class="badge ok">已通过</span>'
          : t.status === 'ready' ? '<span class="badge mute">就绪</span>' : '';
  const member = state.members.find((m) => m.id === t.owner_id);
  const worker = member ? workerLabel(member.worker) : '';
  const act = state.activity.get(t.id);
  const live = t.status === 'running'
    ? `<div class="c-live">
         <span class="pulse"></span>
         <span class="c-actor">${esc(member?.name || '未指派')}${worker ? ` · ${esc(worker)}` : ''}</span>
         <span class="c-elapsed" data-since="${esc(t.updated_at)}">0:00</span>
         <span class="c-doing">${esc(act?.line || '正在启动…')}</span>
       </div>`
    : '';
  return `<div class="card ${cls}" data-act="open-task" data-id="${t.id}">
    <div class="c-key">${esc(t.key)} · ${esc(t.type)}</div>
    <div class="c-title">${esc(t.title)}</div>
    <div class="c-spec">${esc(t.spec || '（无说明）')}</div>
    ${live}
    <div class="c-foot">
      <span class="owner">${esc(member?.name || '未指派')}</span>
      ${badge}
      ${t.diff_stat ? `<span class="small muted right">${esc((t.diff_stat || '').split('\n').pop() || '')}</span>` : ''}
    </div>
  </div>`;
}

/** 计划 / 评审这类“不是任务”的运行，用会话级活动条。 */
function setRoomLive(name, worker, kind, text) {
  state.roomLive = { name, worker, kind, text };
  const el = $('#room-live');
  if (!el) return;
  el.classList.remove('hidden');
  const who = $('.rl-who', el);
  const wk = $('.rl-worker', el);
  const kindEl = $('.rl-kind', el);
  const doing = $('.rl-doing', el);
  if (who) who.textContent = name || '';
  if (wk) wk.textContent = worker ? (workerLabel(worker) || worker) : '';
  if (kindEl) kindEl.textContent = kind === 'plan' ? '规划中' : '评审中';
  if (doing && text) doing.textContent = text;
}

function clearRoomLive() {
  state.roomLive = null;
  const el = $('#room-live');
  if (el) el.classList.add('hidden');
}

/** SSE 只改这一行，不重绘整块看板。 */
function updateCardLive(taskId, activity) {
  if (!activity) return;
  const card = $(`.card[data-id="${taskId}"]`);
  if (card) {
    const el = $('.c-doing', card);
    if (el) el.textContent = activity;
  }
  const task = state.tasks.find((t) => t.id === taskId);
  if (task) {
    const chip = $(`.member-chip[data-member="${task.owner_id}"] .mc-doing`);
    if (chip) chip.textContent = activity;
    if (state.selectedTaskId === taskId) {
      const doing = $('#drawer-doing');
      if (doing) doing.textContent = activity;
    }
  }
}

function fmtElapsed(since) {
  if (!since) return '0:00';
  const sec = Math.max(0, Math.floor((Date.now() - new Date(since).getTime()) / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** 运行时长纯本地计算，每秒刷新，不请求服务端。 */
function tickElapsed() {
  $$('.c-elapsed').forEach((el) => {
    if (el.dataset.since) el.textContent = fmtElapsed(el.dataset.since);
  });
  $$('.mc-since[data-since]').forEach((el) => {
    el.textContent = fmtElapsed(el.dataset.since);
  });
}

function eventText(e) {
  const p = e.payload || {};
  switch (e.type) {
    case 'room.created': return `会话创建 · ${p.name || ''}`;
    case 'room.started': return '开始执行';
    case 'room.paused': return '已暂停';
    case 'room.completed': return '会话完成';
    case 'room.archived': return '会话已归档';
    case 'room.restored': return '会话已恢复';
    case 'plan.started': return `Planner 开始生成计划 · ${p.planner || ''}`;
    case 'plan.ready': return `计划已生成 · ${p.count || 0} 个任务`;
    case 'plan.applied': return `计划已落地 · ${p.count || 0} 个任务`;
    case 'plan.failed': return `计划失败 · ${String(p.error || '').slice(0, 80)}`;
    case 'plan.cancelled': return '计划生成已取消';
    case 'task.created': return `任务创建 · ${p.title || ''}`;
    case 'task.worktree': return `创建工作区 · ${p.branch || ''}`;
    case 'task.started': return `${p.key || ''} 开始执行 · ${p.member || ''}`;
    case 'task.finished': return `${p.key || ''} 执行完成`;
    case 'task.failed': return `${p.key || ''} 执行失败`;
    case 'task.status': return `${p.key || ''} → ${STATUS[p.status] || p.status}`;
    case 'task.merged': return `${p.key || ''} 已合并`;
    case 'task.rejected': return `${p.key || ''} 被打回`;
    case 'task.retry': return `${p.key || ''} 重试`;
    case 'task.cancelled': return `${p.key || ''} 已取消`;
    case 'task.error': return `错误 · ${String(p.error || '').slice(0, 80)}`;
    case 'review.started': return `${p.key || ''} 评审开始 · ${p.reviewer || ''}`;
    case 'review.done': return `评审完成 · ${p.verdict === 'approve' ? '通过' : p.escalated ? '要求修改（已达 2 轮，转人工）' : '要求修改'}${p.round ? `（第 ${p.round} 轮）` : ''}`;
    case 'review.failed': return `评审失败 · ${String(p.error || '').slice(0, 80)}`;
    case 'review.cancelled': return '评审已取消';
    case 'decision.added': return `新增决策 · ${p.text || ''}`;
    case 'member.added': return `新增成员 · ${p.name || ''}`;
    case 'member.updated': return `成员更新 · ${p.name || ''}`;
    case 'member.removed': return `移除成员 · ${p.name || ''}`;
    default: return e.type;
  }
}

function renderTimeline() {
  const items = state.events.slice(-80).reverse();
  return `<div class="timeline">
    <div class="tl-head"><b>时间线</b><span class="small muted right">${state.events.length} 条</span></div>
    <div class="tl-list">
      ${items.map((e) => {
    const cls = e.type.startsWith('plan') ? 'ev-plan' : e.type.startsWith('review') ? 'ev-review' : e.type.includes('fail') || e.type.includes('error') ? 'ev-error' : e.type.startsWith('task') ? 'ev-task' : '';
    return `<div class="tl-item ${cls}"><span class="tl-time">${fmtTime(e.created_at)}</span><span class="tl-dot"></span><div class="tl-body">${esc(eventText(e))}</div></div>`;
  }).join('') || '<div class="small muted">还没有事件</div>'}
    </div>
  </div>`;
}

/* ---------------- flow ---------------- */

function renderFlow() {
  const flow = state.room.flow || { nodes: [], edges: [] };
  const nodes = flow.nodes || [];
  const sel = nodes.find((n) => n.id === state.flowSelected);
  const busy = state.tasks.some((t) => t.status === 'running');
  const readOnly = busy || state.room.status === 'archived';
  return `<div class="flow-toolbar">
      <b style="font-size:12px">${esc(flow.name || '流程')}</b>
      <span class="small muted">拖拽节点调整位置 · 点节点编辑</span>
      <span class="spacer"></span>
      ${state.room.status === 'archived' ? '<span class="badge warn">会话已归档，流程只读</span>' : busy ? '<span class="badge warn">有任务运行中，流程只读</span>' : ''}
      <button class="btn sm ghost" data-act="flow-mode">${state.flowAdvanced ? '简单模式' : '高级设置'}</button>
      <button class="btn sm" data-act="flow-add" ${readOnly ? 'disabled' : ''}>＋ 阶段</button>
      <button class="btn sm primary" data-act="flow-save" ${readOnly ? 'disabled' : ''}>保存流程</button>
    </div>
    <div class="flow-help">
      <b>怎么改：</b>点一个阶段 → 选「谁来做」和「怎么算完成」→ 勾选下一步。负责人可以留空，生成计划时 Planner 会按成员角色分配。不改也能直接跑，默认流程已经能用。
    </div>
    <div class="flow-wrap">
      <div class="flow-canvas">
        <div class="flow-inner" id="flow-inner">
          <svg class="flow-svg" id="flow-svg">
            <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#b9b3a4"></path>
            </marker></defs>
          </svg>
          ${nodes.map((n) => `
            <div class="fnode ${n.id === state.flowSelected ? 'selected' : ''}" data-node="${n.id}"
                 data-act="select-node" data-id="${n.id}"
                 style="left:${n.x || 40}px;top:${n.y || 80}px">
              <div class="fn-name">${esc(n.name || '未命名阶段')}</div>
              <div class="fn-meta">
                <span class="badge ${n.gate === 'human' ? 'warn' : n.gate === 'agent' ? 'ok' : 'mute'}">${gateLabel(n.gate)}</span>
                ${(n.outputs || []).map((o) => `<span class="badge mute">${esc(artifactLabel(o))}</span>`).join('')}
                ${n.maxLoop ? `<span class="badge err">打回≤${n.maxLoop}</span>` : ''}
              </div>
              <div class="fn-owner">${esc(n.owner ? '负责人：' + n.owner : '负责人：由 Planner 分配')}</div>
            </div>`).join('')}
        </div>
      </div>
      <div class="flow-side">
        ${sel ? flowSide(sel) : `<h3>流程</h3><div class="small muted">点左边任意一个阶段开始编辑。</div>
          <div class="fs-section"><h4>三个概念</h4>
            <div class="small" style="line-height:1.8">
              <b>谁来做</b>：这个阶段建议谁做，留空也可以。<br/>
              <b>怎么算完成</b>：人工确认 / 评审通过 / 自动通过。<br/>
              <b>下一步</b>：通过后走到哪个阶段，可以多选。
            </div>
          </div>`}
      </div>
    </div>`;
}

function gateLabel(g) {
  return g === 'human' ? '人工' : g === 'agent' ? '评审' : '自动';
}

function artifactLabel(key) {
  return ARTIFACT_TYPES.find((a) => a.key === key)?.label || key;
}

function flowSide(n) {
  const flow = state.room.flow || { nodes: [], edges: [] };
  const busy = state.tasks.some((t) => t.status === 'running') || state.room.status === 'archived';
  const dis = busy ? 'disabled' : '';
  const others = (flow.nodes || []).filter((x) => x.id !== n.id);
  const passed = new Set((flow.edges || []).filter((e) => e.from === n.id && e.condition !== 'rejected').map((e) => e.to));
  const rejected = (flow.edges || []).find((e) => e.from === n.id && e.condition === 'rejected')?.to || '';
  const members = state.members || [];
  const known = new Set(ARTIFACT_TYPES.map((a) => a.key));
  const extras = (n.outputs || []).filter((o) => !known.has(o));
  const ownerOptions = [
    `<option value="" ${!n.owner ? 'selected' : ''}>不指定（由 Planner 分配）</option>`,
    ...members.map((m) => `<option value="${esc(m.name)}" ${m.name === n.owner ? 'selected' : ''}>${esc(m.name)} · ${esc(m.role_name || '未命名角色')}</option>`),
    ...(n.owner && !members.some((m) => m.name === n.owner)
      ? [`<option value="${esc(n.owner)}" selected>${esc(n.owner)}（不在成员列表）</option>`] : []),
  ].join('');
  return `<div class="fs-head"><h3>阶段设置</h3><span class="small muted">${esc(n.id)}</span></div>
    <div class="fs-section">
      <div class="field"><label>阶段名称</label><input class="input" data-field="name" value="${esc(n.name)}" ${dis}></div>
      <div class="field"><label>谁来做（建议负责人）</label>
        <select class="select" data-field="owner" ${dis}>${ownerOptions}</select>
        <div class="hint">留空也没关系：生成计划时 Planner 会按成员角色分配。</div>
      </div>
      <div class="field"><label>怎么算完成</label>
        <select class="select" data-field="gate" ${dis}>
          <option value="human" ${n.gate === 'human' ? 'selected' : ''}>人工确认 —— 你点通过</option>
          <option value="agent" ${n.gate === 'agent' ? 'selected' : ''}>评审通过 —— 评审者看过 diff</option>
          <option value="auto" ${n.gate === 'auto' ? 'selected' : ''}>自动通过 —— 有产出即可</option>
        </select>
      </div>
    </div>
    <div class="fs-section">
      <h4>下一步</h4>
      <div class="field"><label>通过后流向（可多选）</label>
        <div class="check-list">${others.length ? others.map((o) => `<label class="check-row"><input type="checkbox" data-next="${o.id}" ${passed.has(o.id) ? 'checked' : ''} ${dis}><span>${esc(o.name)}</span></label>`).join('') : '<div class="small muted">没有其他阶段</div>'}</div>
        <div class="hint">不勾选 = 这是最后一个阶段。</div>
      </div>
      <div class="field"><label>被打回时回到</label>
        <select class="select" data-field="reject" ${dis}>
          <option value="">不回退</option>
          ${others.map((o) => `<option value="${o.id}" ${rejected === o.id ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}
        </select>
      </div>
    </div>
    ${state.flowAdvanced ? `<div class="fs-section">
      <h4>高级</h4>
      <div class="field"><label>阶段产出（可留空）</label>
        <div class="artifact-grid">
          ${ARTIFACT_TYPES.map((a) => `<label class="check-row"><input type="checkbox" data-artifact="${a.key}" ${(n.outputs || []).includes(a.key) ? 'checked' : ''} ${dis}><span>${a.label}</span></label>`).join('')}
          ${extras.map((o) => `<label class="check-row"><input type="checkbox" data-artifact="${esc(o)}" checked ${dis}><span>${esc(o)}</span></label>`).join('')}
        </div>
        <div class="hint">只是给阶段贴标签，方便看；不影响执行，不选也可以。</div>
      </div>
      <div class="field"><label>最多打回几次</label>
        <input class="input" type="number" min="0" max="9" data-field="maxLoop" value="${n.maxLoop || 0}" ${dis}>
        <div class="hint">0 = 不允许回边。评审回路默认 2 次。</div>
      </div>
    </div>` : ''}
    <div class="fs-foot"><button class="btn danger sm" data-act="flow-del" ${dis}>删除这个阶段</button></div>`;
}

function wireFlow() {
  if (state.tab !== 'flow') return;
  drawEdges();
  const inner = $('#flow-inner');
  if (!inner) return;

  let drag = null;
  const onMove = (e) => {
    if (!drag) return;
    const n = state.room.flow.nodes.find((x) => x.id === drag.id);
    if (!n) return;
    n.x = Math.max(0, drag.x + (e.clientX - drag.sx));
    n.y = Math.max(0, drag.y + (e.clientY - drag.sy));
    drag.el.style.left = n.x + 'px';
    drag.el.style.top = n.y + 'px';
    drawEdges();
  };
  const onUp = () => {
    drag = null;
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  };
  inner.addEventListener('mousedown', (e) => {
    const el = e.target.closest('.fnode');
    if (!el) return;
    const n = state.room.flow.nodes.find((x) => x.id === el.dataset.node);
    if (!n) return;
    drag = { id: n.id, el, sx: e.clientX, sy: e.clientY, x: n.x, y: n.y };
    e.preventDefault();
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  const applyField = (el) => {
    const n = state.room.flow.nodes.find((x) => x.id === state.flowSelected);
    if (!n) return;
    const f = el.dataset.field;
    const flow = state.room.flow;
    if (!Array.isArray(flow.edges)) flow.edges = [];

    if (f === 'maxLoop') n.maxLoop = Number(el.value) || 0;
    else if (f === 'reject') {
      flow.edges = flow.edges.filter((e) => !(e.from === n.id && e.condition === 'rejected'));
      if (el.value && el.value !== n.id) flow.edges.push({ from: n.id, to: el.value, condition: 'rejected' });
      drawEdges();
    } else {
      n[f] = el.value;
      if (f === 'name') {
        const nameEl = $(`.fnode[data-node="${n.id}"] .fn-name`);
        if (nameEl) nameEl.textContent = n.name || '未命名阶段';
      }
    }
  };

  $$('.flow-side [data-field]').forEach((el) => {
    el.addEventListener('input', () => applyField(el));
    el.addEventListener('change', () => applyField(el));
  });

  // 下一步用复选框，不用 Ctrl/⌘ 多选：鼠标点一下就能改。
  $$('.flow-side [data-next]').forEach((el) => {
    el.addEventListener('change', () => {
      const n = state.room.flow.nodes.find((x) => x.id === state.flowSelected);
      if (!n) return;
      const flow = state.room.flow;
      if (!Array.isArray(flow.edges)) flow.edges = [];
      const targets = $$('.flow-side [data-next]:checked')
        .map((x) => x.dataset.next)
        .filter((v) => v && v !== n.id);
      flow.edges = flow.edges.filter((e) => !(e.from === n.id && e.condition !== 'rejected'));
      for (const to of targets) flow.edges.push({ from: n.id, to, condition: 'passed' });
      drawEdges();
    });
  });

  // 产物是可选标签，勾选即可；重绘一次让节点上的 badge 同步。
  $$('.flow-side [data-artifact]').forEach((el) => {
    el.addEventListener('change', () => {
      const n = state.room.flow.nodes.find((x) => x.id === state.flowSelected);
      if (!n) return;
      n.outputs = $$('.flow-side [data-artifact]:checked').map((x) => x.dataset.artifact);
      renderMain();
    });
  });
}

function drawEdges() {
  const svg = $('#flow-svg');
  if (!svg) return;
  const flow = state.room.flow;
  const nodes = flow.nodes || [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const W = 188, H = 76;
  const paths = (flow.edges || []).map((e) => {
    const a = byId.get(e.from), b = byId.get(e.to);
    if (!a || !b) return '';
    const x1 = a.x + W, y1 = a.y + H / 2;
    const x2 = b.x, y2 = b.y + H / 2;
    let d;
    if (x2 > x1 + 20) d = `M${x1},${y1} C${x1 + 70},${y1} ${x2 - 70},${y2} ${x2},${y2}`;
    else {
      const midY = Math.max(a.y, b.y) + H + 64;
      d = `M${x1},${y1} C${x1 + 90},${y1} ${x1 + 90},${midY} ${(x1 + x2) / 2},${midY} S${x2 - 60},${y2} ${x2},${y2}`;
    }
    const stroke = e.condition === 'rejected' ? '#c1844a' : '#b9b3a4';
    return `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="1.4" marker-end="url(#arrow)" ${e.condition === 'rejected' ? 'stroke-dasharray="5 4"' : ''}/>`;
  }).join('');
  svg.innerHTML = `<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="#b9b3a4"></path></marker></defs>${paths}`;
}

/* ---------------- drawer ---------------- */

function openTask(id) {
  state.selectedTaskId = id;
  state.drawerTab = 'overview';
  state.log = '';
  state.diff = '';
  const t = state.tasks.find((x) => x.id === id);
  if (t) {
    api('/api/tasks/' + id + '/log').then((d) => {
      state.log = d.log || '';
      if (state.drawerTab === 'log') renderDrawer(true);
    }).catch(() => {});
  }
  renderDrawer(true);
}

function closeDrawer() {
  state.selectedTaskId = null;
  state.drawerSig = '';
  $('#drawer-root').innerHTML = '';
}

function renderDrawer(force = false) {
  const t = state.tasks.find((x) => x.id === state.selectedTaskId);
  const root = $('#drawer-root');
  if (!t) { root.innerHTML = ''; state.drawerSig = ''; return; }
  const sig = drawerSignature(t);
  if (!force && sig === state.drawerSig) return;
  state.drawerSig = sig;
  const reviews = state.reviews.filter((r) => r.task_id === t.id);
  const runningNow = t.status === 'running';
  let body = '';
  if (state.drawerTab === 'overview') {
    body = `<div class="section"><h4>任务说明</h4><div class="prose">${esc(t.spec || '（无）')}</div></div>
      <div class="section"><h4>验收标准</h4><div class="prose">${(t.acceptance || []).map((a) => '· ' + esc(a)).join('\n') || '（无）'}</div></div>
      ${t.feedback ? `<div class="section"><h4>评审意见</h4><div class="prose" style="color:var(--amber)">${esc(t.feedback)}</div></div>` : ''}
      ${t.status === 'escalated' ? `<div class="section"><h4>评审已达上限</h4><div class="prose" style="color:var(--red)">这个任务已经评审 2 轮仍未通过，系统不再自动评审。请按意见重跑后人工合并，或直接取消。</div></div>` : ''}
      <div class="section"><h4>执行摘要</h4><div class="prose">${esc(t.summary || '（还没有运行）')}</div></div>
      <div class="section"><h4>元信息</h4><dl class="kv">
        <dt>负责人</dt><dd>${esc(memberName(t.owner_id))}</dd>
        <dt>分支</dt><dd class="mono" style="font-family:var(--mono);font-size:11.5px">${esc(t.branch || '—')}</dd>
        <dt>工作区</dt><dd style="font-family:var(--mono);font-size:11px">${esc(t.worktree || '—')}</dd>
        <dt>改动统计</dt><dd style="font-family:var(--mono);font-size:11px;white-space:pre-wrap">${esc(t.diff_stat || '—')}</dd>
      </dl></div>`;
  } else if (state.drawerTab === 'log') {
    body = `<div class="section"><div class="row" style="align-items:center;margin-bottom:8px">
        <h4 style="margin:0">执行日志</h4>
        <button class="btn sm ghost right" data-act="reload-log">重新加载</button>
        <button class="btn sm ghost" data-act="scroll-log">滚到底</button>
      </div>
      <div class="log-box" id="log-box">${esc(state.log || '（暂无日志）')}</div></div>`;
  } else if (state.drawerTab === 'diff') {
    body = state.diff
      ? `<div class="diff-box">${colorDiff(state.diff)}</div>`
      : `<div class="center">正在加载 diff…</div>`;
  } else {
    body = reviews.length ? reviews.map((rv) => {
      const p = rv.payload || {};
      return `<div class="review">
        <div class="r-head"><span class="badge ${rv.verdict === 'approve' ? 'ok' : 'warn'}">${rv.verdict === 'approve' ? '通过' : '要求修改'}</span>
          <span class="small muted">第 ${rv.round} 轮 · ${fmtTime(rv.created_at)}</span></div>
        <div class="prose" style="margin-top:6px">${esc(p.notes || '')}</div>
        ${(p.blocking || []).map((b) => `<div class="small" style="margin-top:6px;color:var(--red)">· ${esc(b.file || '')}:${b.line || '?'} ${esc(b.issue || '')} → ${esc(b.suggestion || '')}</div>`).join('')}
      </div>`;
    }).join('') : '<div class="center">还没有评审记录。点下方「自动评审」。</div>';
  }

  const buttons = [];
  if (state.room?.status === 'archived') {
    buttons.push('<span class="small muted">会话已归档，恢复后才能操作</span>');
  } else {
    if (['backlog', 'ready', 'failed', 'cancelled', 'changes_requested', 'escalated'].includes(t.status)) {
      buttons.push(`<button class="btn primary" data-act="run-task">${t.status === 'changes_requested' ? '按意见重跑' : t.status === 'escalated' ? '按意见重跑' : '运行'}</button>`);
    }
    if (t.status === 'running') buttons.push('<button class="btn danger" data-act="cancel-task">取消</button>');
    if (['review', 'changes_requested', 'approved', 'failed'].includes(t.status)) {
      buttons.push('<button class="btn" data-act="review-task">自动评审</button>');
    }
    if (['review', 'approved', 'escalated'].includes(t.status)) {
      buttons.push(`<button class="btn primary" data-act="merge-task">${t.status === 'escalated' ? '人工合并' : '合并'}</button>`);
    }
    if (['review', 'approved'].includes(t.status)) {
      buttons.push('<button class="btn danger" data-act="reject-task">打回</button>');
    }
    if (t.status === 'escalated') buttons.push('<button class="btn danger" data-act="cancel-task">取消任务</button>');
  }
  if (!buttons.length && t.status === 'merged') buttons.push('<span class="small muted">已合并</span>');
  if (!buttons.length && t.status === 'done') buttons.push('<span class="small muted">已完成（没有代码改动）</span>');

  root.innerHTML = `<div class="drawer-mask"></div>
    <div class="drawer">
      <div class="drawer-head">
        <div class="d-top">
          <span class="badge mute">${esc(t.key)}</span>
          <h2>${esc(t.title)}</h2>
          <button class="btn ghost right" data-act="close-drawer">✕</button>
        </div>
        <div class="d-sub">
          ${[
      memberName(t.owner_id),
      workerLabel(state.members.find((m) => m.id === t.owner_id)?.worker),
      STATUS[t.status] || t.status,
      t.type,
    ].filter(Boolean).map(esc).join(' · ')}
        </div>
        ${t.status === 'running' ? `<div class="d-live">
            <span class="pulse"></span>
            <span class="c-elapsed" data-since="${esc(t.updated_at)}">0:00</span>
            <span id="drawer-doing">${esc(state.activity.get(t.id)?.line || '正在启动…')}</span>
          </div>` : ''}
        <div class="drawer-tabs">
          ${['overview|概览', 'log|日志', 'diff|Diff', 'review|评审'].map((x) => {
    const [k, n] = x.split('|');
    return `<button class="tab ${state.drawerTab === k ? 'active' : ''}" data-act="drawer-tab" data-tab="${k}">${n}</button>`;
  }).join('')}
        </div>
      </div>
      <div class="drawer-body">${body}</div>
      <div class="drawer-foot">${buttons.join('')}</div>
    </div>`;

  if (state.drawerTab === 'diff' && !state.diff) {
    api('/api/tasks/' + t.id + '/diff').then((d) => { state.diff = d.diff || ''; renderDrawer(); }).catch(() => {});
  }
  if (state.drawerTab === 'log') {
    const box = $('#log-box');
    if (box) box.scrollTop = box.scrollHeight;
  }
}

function colorDiff(text) {
  return String(text).split('\n').map((line) => {
    const e = esc(line);
    if (line.startsWith('+++') || line.startsWith('---')) return `<span class="meta">${e}</span>`;
    if (line.startsWith('@@')) return `<span class="hunk">${e}</span>`;
    if (line.startsWith('+')) return `<span class="add">${e}</span>`;
    if (line.startsWith('-')) return `<span class="del">${e}</span>`;
    return `<span>${e}</span>`;
  }).join('\n');
}

function appendLog(line, stream) {
  state.log += (state.log ? '\n' : '') + line;
  if (state.drawerTab !== 'log') return;
  const box = $('#log-box');
  if (!box) return;
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 40;
  const span = document.createElement('div');
  if (stream === 'err') span.className = 'l-err';
  span.textContent = line;
  box.appendChild(span);
  if (atBottom) box.scrollTop = box.scrollHeight;
}

/* ---------------- modals ---------------- */

function closeModal() {
  state.repoPicker = null;
  $('#modal-root').innerHTML = '';
}

async function loadRepoPicker(path) {
  const prev = state.repoPicker && !state.repoPicker.loading ? state.repoPicker : null;
  state.repoPicker = { ...(prev || {}), loading: true };
  renderRepoPicker();
  try {
    state.repoPicker = await api('/api/fs' + (path ? `?path=${encodeURIComponent(path)}` : ''));
  } catch (e) {
    state.repoPicker = prev;
    renderRepoPicker();
    throw e;
  }
  renderRepoPicker();
}

function openRoomModal() {
  state.repoPicker = null;
  const opts = state.workers.map((w) => `<option value="${w.key}" ${w.available ? '' : 'disabled'}>${esc(w.label)}${w.available ? '' : '（未检测到）'}</option>`).join('');
  const memberRow = (i) => `<div class="member-row" data-mrow>
    <input class="input" data-m="name" placeholder="成员名" value="成员 ${i + 1}">
    <select class="select" data-m="worker">${opts}</select>
    <input class="input" data-m="role_name" placeholder="例如：后端实现 / 代码评审">
    <input class="input" data-m="role_brief" placeholder="例如：只改 server/，不碰前端">
    <input class="input" data-m="concurrency" type="number" min="1" value="1" title="并发">
    <button class="rm" data-act="rm-member">✕</button>
  </div>`;
  $('#modal-root').innerHTML = `<div class="modal-mask">
    <div class="modal wide" data-stop="1">
      <div class="modal-head"><h2>新建会话</h2><button class="btn ghost x" data-act="close-modal">✕</button></div>
      <div class="modal-body">
        <div class="hint" style="margin:-2px 0 10px">只有「会话名 / 仓库路径 / 需求」必填；其他保持默认就能创建。</div>
        <div class="row">
          <div class="field"><label>会话名</label><input class="input" id="nr-name" placeholder="例如：订单限流"></div>
          <div class="field"><label>仓库路径</label>
            <div style="display:flex;gap:6px">
              <input class="input" id="nr-repo" placeholder="D:\\code\\your-repo">
              <button class="btn sm" data-act="browse-repo">浏览…</button>
            </div>
            <div id="repo-picker"></div>
          </div>
        </div>
        <div class="field"><label>需求（会作为会话公告，所有 agent 都能看到）</label>
          <textarea class="textarea" id="nr-req" placeholder="描述这次要做什么。越具体，Planner 拆得越准。"></textarea></div>
        <div class="row">
          <div class="field"><label>并发模式</label>
            <select class="select" id="nr-mode"><option value="parallel">并行（按依赖跑）</option><option value="serial">串行（一次一个）</option></select></div>
          <div class="field"><label>自动执行命令</label>
            <select class="select" id="nr-auto"><option value="1">开启（推荐，本地可信仓库）</option><option value="0">关闭（agent 不能跑命令）</option></select></div>
        </div>
        <div class="field"><label>流程</label>
          <select class="select" id="nr-flow">
            ${state.flowTemplates.map((t) => `<option value="tpl:${t.key}" ${t.key === 'generic' ? 'selected' : ''}>${esc(t.name)}（${esc(t.desc)}）</option>`).join('')}
            ${state.rooms.map((r) => `<option value="room:${r.id}">复制：${esc(r.name)}</option>`).join('')}
          </select>
          <div class="hint" id="nr-flow-hint"></div>
        </div>
        <div class="field"><label>成员（每个成员 = 一个 CLI + 你写的角色）</label>
          <div class="member-editor" id="nr-members">${[0, 1].map(memberRow).join('')}</div>
          <button class="btn sm" style="margin-top:8px" data-act="add-member">＋ 加一个成员</button>
          <div class="hint">名字随便起；角色和职责只是给 Planner 的说明，留空也能用。同一个 CLI 可以开多个成员。</div>
        </div>
        <div class="row">
          <div class="field"><label>谁做计划</label><select class="select" id="nr-planner"></select></div>
          <div class="field"><label>谁做评审</label><select class="select" id="nr-reviewer"></select></div>
        </div>
        <div class="hint">提示：计划者和评审者只是会话里的两个位置，谁都可以当。</div>
      </div>
      <div class="modal-foot">
        <button class="btn" data-act="close-modal">取消</button>
        <button class="btn primary" data-act="create-room">创建会话</button>
      </div>
    </div>
  </div>`;
  refreshRoleSelects();
  renderFlowHint();
}

function renderFlowHint() {
  const hint = $('#nr-flow-hint');
  if (!hint) return;
  const v = $('#nr-flow')?.value || '';
  if (v.startsWith('tpl:')) {
    const t = state.flowTemplates.find((x) => 'tpl:' + x.key === v);
    hint.textContent = !t ? ''
      : t.phases.length
        ? `阶段：${t.phases.join(' → ')}。创建后可在「流程」标签里改。`
        : '空画布：创建后到「流程」标签里自己加阶段。';
    return;
  }
  const r = state.rooms.find((x) => 'room:' + x.id === v);
  hint.textContent = r ? `复制「${r.name}」当前的流程，之后各改各的，互不影响。` : '';
}

function renderRepoPicker() {
  const root = $('#repo-picker');
  if (!root) return;
  const p = state.repoPicker;
  if (!p) { root.innerHTML = ''; return; }
  if (p.loading) {
    root.innerHTML = '<div class="picker"><div class="picker-loading">正在读取目录…</div></div>';
    return;
  }
  const roots = (p.roots || []).map((r) => `<button class="chip" data-act="picker-go" data-path="${esc(r.path)}" title="${esc(r.path)}">${esc(r.name)}</button>`).join('');
  const rows = (p.dirs || []).map((d) => `<button class="picker-row" data-act="picker-go" data-path="${esc(d.path)}" title="${esc(d.path)}">
      <span class="picker-folder">▸</span>
      <span class="picker-name">${esc(d.name)}</span>
      ${d.repo ? '<span class="badge ok">git</span>' : ''}
    </button>`).join('');
  root.innerHTML = `<div class="picker">
    <div class="picker-head">
      <button class="btn sm" data-act="picker-up" ${p.parent ? '' : 'disabled'}>↑ 上一级</button>
      <span class="picker-path" title="${esc(p.path)}">${esc(p.path)}</span>
      <button class="btn ghost sm" data-act="picker-close">收起</button>
    </div>
    <div class="picker-roots">
      ${roots}
      <button class="chip" data-act="picker-go" data-path="${esc(p.home)}">主目录</button>
    </div>
    <div class="picker-list">${rows || '<div class="picker-empty">这个目录下没有子目录</div>'}</div>
    <div class="picker-foot">
      <span>${p.isRepo ? '<span class="badge ok">git 仓库</span>' : '<span class="badge mute">不是 git 仓库</span>'}</span>
      <span class="small muted">${(p.dirs || []).length} 个子目录${p.truncated ? ' · 仅显示前 400 个' : ''}</span>
      <button class="btn primary sm" data-act="picker-pick" ${p.isRepo ? '' : 'disabled'}>使用此目录</button>
    </div>
  </div>`;
}

function refreshRoleSelects() {
  const rows = $$('#nr-members [data-mrow]');
  const names = rows.map((r) => $('[data-m="name"]', r).value || '未命名');
  const options = names.map((n, i) => `<option value="${i}">${esc(n)}</option>`).join('');
  const p = $('#nr-planner'), r = $('#nr-reviewer');
  if (p) p.innerHTML = options;
  if (r) { r.innerHTML = options; if (names.length) r.value = String(names.length - 1); }
}

function collectMembers() {
  return $$('#nr-members [data-mrow]').map((row) => ({
    name: $('[data-m="name"]', row).value.trim() || '成员',
    worker: $('[data-m="worker"]', row).value,
    roleName: $('[data-m="role_name"]', row).value.trim(),
    roleBrief: $('[data-m="role_brief"]', row).value.trim(),
    concurrency: Number($('[data-m="concurrency"]', row).value) || 1,
  }));
}

/* ---------------- 会话设置 ---------------- */

function workerOptions(selected) {
  return state.workers.map((w) => `<option value="${w.key}" ${w.key === selected ? 'selected' : ''} ${w.available ? '' : 'disabled'}>${esc(w.label)}${w.available ? '' : '（未检测到）'}</option>`).join('');
}

function settingsMemberRow(m, i) {
  return `<div class="member-row settings" data-mrow data-mid="${esc(m.id || '')}">
    <input class="input" data-m="name" placeholder="成员名" value="${esc(m.name || `成员 ${i + 1}`)}">
    <select class="select" data-m="worker">${workerOptions(m.worker || state.workers[0]?.key)}</select>
    <input class="input" data-m="role_name" placeholder="角色" value="${esc(m.role_name || '')}">
    <input class="input" data-m="role_brief" placeholder="职责边界 / 交付契约" value="${esc(m.role_brief || '')}">
    <input class="input" data-m="concurrency" type="number" min="1" max="10" value="${m.concurrency || 1}" title="并发">
    <input class="input" data-m="model" placeholder="模型(可空)" value="${esc(m.model || '')}">
    <label class="check"><input type="checkbox" data-m="enabled" ${m.enabled === false ? '' : 'checked'}>启用</label>
    <button class="rm" data-act="settings-rm-member" title="移除成员">✕</button>
  </div>`;
}

function openRoomSettings() {
  const r = state.room;
  if (!r) return;
  state.settingsRemoved = [];
  const archived = r.status === 'archived';
  const dis = archived ? 'disabled' : '';
  $('#modal-root').innerHTML = `<div class="modal-mask">
    <div class="modal wide" data-stop="1">
      <div class="modal-head"><h2>会话设置</h2><button class="btn ghost x" data-act="close-modal">✕</button></div>
      <div class="modal-body">
        <div class="row">
          <div class="field"><label>会话名</label><input class="input" id="rs-name" value="${esc(r.name)}" ${dis}></div>
          <div class="field"><label>仓库（创建后不可改）</label><input class="input" value="${esc(r.repo_path)}" disabled></div>
        </div>
        <div class="field"><label>需求（会作为会话公告，所有 agent 都能看到）</label>
          <textarea class="textarea" id="rs-req" ${dis}>${esc(r.requirement || '')}</textarea></div>
        <div class="row">
          <div class="field"><label>并发模式</label>
            <select class="select" id="rs-mode" ${dis}>
              <option value="parallel" ${r.mode !== 'serial' ? 'selected' : ''}>并行（按依赖跑）</option>
              <option value="serial" ${r.mode === 'serial' ? 'selected' : ''}>串行（一次一个）</option>
            </select></div>
          <div class="field"><label>自动执行命令</label>
            <select class="select" id="rs-auto" ${dis}>
              <option value="1" ${r.auto_approve ? 'selected' : ''}>开启（本地可信仓库）</option>
              <option value="0" ${!r.auto_approve ? 'selected' : ''}>关闭（更保守）</option>
            </select></div>
        </div>
        <div class="row">
          <div class="field"><label>谁做计划</label><select class="select" id="rs-planner" ${dis}></select></div>
          <div class="field"><label>谁做评审</label><select class="select" id="rs-reviewer" ${dis}></select></div>
        </div>
        <div class="field"><label>成员（角色完全由你定义）</label>
          <div class="member-editor" id="rs-members">${state.members.map(settingsMemberRow).join('')}</div>
          ${archived ? '' : '<button class="btn sm" style="margin-top:8px" data-act="settings-add-member">＋ 加一个成员</button>'}
          <div class="settings-note">停用的成员不会被调度，也不能生成计划或评审；名下还有任务的成员不能删除，只能停用。</div>
        </div>
      </div>
      <div class="modal-foot">
        ${archived
          ? '<button class="btn" data-act="close-modal">关闭</button><button class="btn primary" data-act="restore-room">恢复会话</button>'
          : '<button class="btn danger" data-act="archive-room">归档会话</button><span style="flex:1"></span><button class="btn" data-act="close-modal">取消</button><button class="btn primary" data-act="save-room-settings">保存</button>'}
      </div>
    </div>
  </div>`;
  refreshSettingsRoleSelects();
}

function refreshSettingsRoleSelects() {
  const rows = $$('#rs-members [data-mrow]');
  const names = rows.map((row) => $('[data-m="name"]', row).value.trim() || '未命名');
  const options = names.map((n, i) => `<option value="${i}">${esc(n)}</option>`).join('');
  const plannerIdx = state.members.findIndex((m) => m.id === state.room?.planner_id);
  const reviewerIdx = state.members.findIndex((m) => m.id === state.room?.reviewer_id);
  const fill = (el, initial, fallback) => {
    if (!el) return;
    const prev = el.value;
    el.innerHTML = options;
    if (!names.length) return;
    if (prev !== '' && Number(prev) < names.length) el.value = prev;
    else if (initial >= 0) el.value = String(Math.min(initial, names.length - 1));
    else el.value = String(Math.min(fallback, names.length - 1));
  };
  fill($('#rs-planner'), plannerIdx, 0);
  fill($('#rs-reviewer'), reviewerIdx, names.length - 1);
}

function collectSettingsMembers() {
  return $$('#rs-members [data-mrow]').map((row, i) => ({
    id: row.dataset.mid || '',
    name: $('[data-m="name"]', row).value.trim(),
    worker: $('[data-m="worker"]', row).value,
    role_name: $('[data-m="role_name"]', row).value.trim(),
    role_brief: $('[data-m="role_brief"]', row).value.trim(),
    concurrency: Math.max(1, Math.min(10, Number($('[data-m="concurrency"]', row).value) || 1)),
    model: $('[data-m="model"]', row).value.trim(),
    enabled: $('[data-m="enabled"]', row).checked,
    sort: i,
  }));
}

async function saveRoomSettings() {
  const r = state.room;
  if (!r) return;
  const members = collectSettingsMembers();
  if (!members.length) throw new Error('至少要保留一个成员');
  if (members.some((m) => !m.name)) throw new Error('每个成员都要有名字');
  if (members.some((m) => !m.worker)) throw new Error('每个成员都要选择 CLI');
  const plannerIdx = Number($('#rs-planner').value || 0);
  const reviewerIdx = Number($('#rs-reviewer').value || 0);

  // 删除前先在前端挡住“名下有任务”的情况，避免保存到一半才失败。
  for (const id of state.settingsRemoved) {
    const m = state.members.find((x) => x.id === id);
    const owned = state.tasks.filter((t) => t.owner_id === id).length;
    if (owned) throw new Error(`「${m?.name || '成员'}」名下还有 ${owned} 个任务，不能删除；请改成停用。`);
  }

  for (const id of state.settingsRemoved) {
    await api('/api/members/' + id, { method: 'DELETE' });
  }
  const ids = [];
  for (const m of members) {
    const { id, ...body } = m;
    if (id) {
      await api('/api/members/' + id, { method: 'PATCH', body });
      ids.push(id);
    } else {
      const d = await api(`/api/rooms/${r.id}/members`, { method: 'POST', body });
      ids.push(d.id);
    }
  }
  await api(`/api/rooms/${r.id}`, {
    method: 'PATCH',
    body: {
      name: $('#rs-name').value.trim() || r.name,
      requirement: $('#rs-req').value,
      mode: $('#rs-mode').value,
      autoApprove: $('#rs-auto').value === '1',
      planner_id: ids[plannerIdx] || ids[0],
      reviewer_id: ids[reviewerIdx] || ids[ids.length - 1],
    },
  });
  closeModal();
  await refreshState();
  toast('会话设置已保存');
}

function openTaskModal() {
  const opts = state.members.map((m) => `<option value="${m.id}">${esc(m.name)} · ${esc(m.role_name || '')}</option>`).join('');
  $('#modal-root').innerHTML = `<div class="modal-mask">
    <div class="modal" data-stop="1">
      <div class="modal-head"><h2>添加任务</h2><button class="btn ghost x" data-act="close-modal">✕</button></div>
      <div class="modal-body">
        <div class="field"><label>标题</label><input class="input" id="nt-title" placeholder="例如：实现限流接口"></div>
        <div class="field"><label>说明（自包含，执行者只能看到这段）</label><textarea class="textarea" id="nt-spec" placeholder="要做什么、边界、涉及文件、怎么验收"></textarea></div>
        <div class="row">
          <div class="field"><label>类型</label><select class="select" id="nt-type"><option value="code">code</option><option value="document">document</option><option value="research">research</option></select></div>
          <div class="field"><label>负责人</label><select class="select" id="nt-owner">${opts}</select></div>
        </div>
        <div class="field"><label>验收标准（每行一条）</label><textarea class="textarea" id="nt-accept"></textarea></div>
      </div>
      <div class="modal-foot">
        <button class="btn" data-act="close-modal">取消</button>
        <button class="btn primary" data-act="create-task">创建</button>
      </div>
    </div>
  </div>`;
}

function openPlanModal(plan) {
  state.planDraft = JSON.parse(JSON.stringify(plan));
  renderPlanModal();
}

function renderPlanModal() {
  const p = state.planDraft;
  if (!p) return;
  const ownerOptions = (selected) => state.members.map((m) => `<option value="${esc(m.name)}" ${m.name === selected ? 'selected' : ''}>${esc(m.name)}</option>`).join('');
  $('#modal-root').innerHTML = `<div class="modal-mask">
    <div class="modal wide" data-stop="1">
      <div class="modal-head"><h2>计划待确认</h2><button class="btn ghost x" data-act="close-modal">✕</button></div>
      <div class="modal-body">
        <div class="prose" style="margin-bottom:12px">${esc(p.summary || '')}</div>
        ${(p.tasks || []).map((t, i) => `<div class="plan-task" data-pt="${i}">
          <div class="pt-head">
            <span class="pt-key">T${i + 1}</span>
            <input class="input" data-p="title" value="${esc(t.title)}" style="flex:1">
            <select class="select" data-p="owner" style="width:120px">${ownerOptions(t.owner)}</select>
            <select class="select" data-p="type" style="width:96px">
              ${['code', 'document', 'research'].map((k) => `<option value="${k}" ${t.type === k ? 'selected' : ''}>${k}</option>`).join('')}
            </select>
            <button class="rm" data-act="rm-plan-task" data-i="${i}">✕</button>
          </div>
          <textarea class="textarea" data-p="spec" style="min-height:64px">${esc(t.spec || '')}</textarea>
          <textarea class="textarea" data-p="acceptance" style="min-height:44px;margin-top:6px" placeholder="验收标准，每行一条">${esc((t.acceptance || []).join('\n'))}</textarea>
          <div class="hint">${t.dependsOn?.length ? `依赖 T${t.dependsOn.join(', T')}` : '无依赖'}</div>
        </div>`).join('')}
        <button class="btn sm" data-act="plan-add-task">＋ 添加任务</button>
        ${(p.decisions || []).length ? `<div class="section"><h4>将记录的决策</h4>${p.decisions.map((d) => `<div class="small">· ${esc(d)}</div>`).join('')}</div>` : ''}
        ${(p.risks || []).length ? `<div class="section"><h4>风险</h4>${p.risks.map((d) => `<div class="small" style="color:var(--amber)">· ${esc(d)}</div>`).join('')}</div>` : ''}
      </div>
      <div class="modal-foot">
        <button class="btn" data-act="close-modal">取消</button>
        <button class="btn primary" data-act="apply-plan" ${(p.tasks || []).length ? '' : 'disabled'}>确认，创建 ${(p.tasks || []).length} 个任务</button>
      </div>
    </div>
  </div>`;
}

function openDecisionsModal() {
  $('#modal-root').innerHTML = `<div class="modal-mask">
    <div class="modal" data-stop="1">
      <div class="modal-head"><h2>会话决策</h2><button class="btn ghost x" data-act="close-modal">✕</button></div>
      <div class="modal-body">
        ${state.decisions.length ? state.decisions.map((d) => `<div class="review"><div class="r-head"><span class="badge ok">生效</span><span class="small muted">${fmtTime(d.created_at)}</span></div><div class="prose" style="margin-top:4px">${esc(d.text)}</div></div>`).join('') : '<div class="center">还没有决策。决策会被带入每一个任务的上下文。</div>'}
        <div class="field" style="margin-top:12px"><label>新增决策</label><input class="input" id="d-text" placeholder="例如：接口统一 REST，不上 GraphQL"></div>
      </div>
      <div class="modal-foot">
        <button class="btn" data-act="close-modal">关闭</button>
        <button class="btn primary" data-act="add-decision">添加</button>
      </div>
    </div>
  </div>`;
}

/* ---------------- actions ---------------- */

async function act(el) {
  const a = el.dataset.act;
  const id = el.dataset.id;
  try {
    if (a === 'new-room') return openRoomModal();
    if (a === 'browse-repo') {
      const start = $('#nr-repo').value.trim();
      try {
        await loadRepoPicker(start);
      } catch (e) {
        if (!start) throw e;
        toast('这个路径打不开，已从主目录开始');
        await loadRepoPicker('');
      }
      return;
    }
    if (a === 'picker-go') return loadRepoPicker(el.dataset.path || '');
    if (a === 'picker-up') {
      const p = state.repoPicker;
      if (p && p.parent) await loadRepoPicker(p.parent);
      return;
    }
    if (a === 'picker-pick') {
      const p = state.repoPicker;
      if (!p || p.loading) return;
      $('#nr-repo').value = p.path;
      state.repoPicker = null;
      renderRepoPicker();
      toast('已选择：' + p.path);
      return;
    }
    if (a === 'picker-close') {
      state.repoPicker = null;
      renderRepoPicker();
      return;
    }
    if (a === 'close-modal') return closeModal();
    if (a === 'close-drawer') return closeDrawer();
    if (a === 'toggle-archived') {
      state.showArchived = !state.showArchived;
      try { localStorage.setItem('devhub.showArchived', state.showArchived ? '1' : '0'); } catch {}
      return renderRail();
    }
    if (a === 'room-settings') return openRoomSettings();
    if (a === 'archive-room') {
      if (!confirm('归档后这个会话会变成只读，任务、日志和 worktree 都会保留。继续？')) return;
      await api(`/api/rooms/${state.roomId}`, { method: 'DELETE' });
      closeModal();
      await refreshState();
      toast('会话已归档');
      return;
    }
    if (a === 'restore-room') {
      await api(`/api/rooms/${state.roomId}/restore`, { method: 'POST' });
      closeModal();
      await refreshState();
      toast('会话已恢复');
      return;
    }
    if (a === 'settings-add-member') {
      const n = $$('#rs-members [data-mrow]').length;
      $('#rs-members').insertAdjacentHTML('beforeend', settingsMemberRow({ name: `成员 ${n + 1}`, worker: state.workers[0]?.key, concurrency: 1, enabled: true }, n));
      return refreshSettingsRoleSelects();
    }
    if (a === 'settings-rm-member') {
      const row = el.closest('[data-mrow]');
      if (row?.dataset.mid) state.settingsRemoved.push(row.dataset.mid);
      row?.remove();
      return refreshSettingsRoleSelects();
    }
    if (a === 'save-room-settings') return saveRoomSettings();
    if (a === 'open-room') { await openRoom(id); return; }
    if (a === 'refresh') { await refreshState(); return; }
    if (a === 'tab') { state.tab = el.dataset.tab; return renderMain(); }
    if (a === 'select-node') {
      if (state.flowSelected === id) return;
      state.flowSelected = id;
      return renderMain();
    }
    if (a === 'drawer-tab') {
      state.drawerTab = el.dataset.tab;
      if (state.drawerTab === 'diff') state.diff = '';
      if (state.drawerTab === 'log') { state.log = ''; const t = state.tasks.find((x) => x.id === state.selectedTaskId); if (t) { const d = await api('/api/tasks/' + t.id + '/log'); state.log = d.log || ''; } }
      return renderDrawer();
    }
    if (a === 'open-task') return openTask(id);
    if (a === 'plan-room') {
      toast('Planner 正在生成计划…');
      const d = await api(`/api/rooms/${state.roomId}/plan`, { method: 'POST' });
      return openPlanModal(d.plan);
    }
    if (a === 'apply-plan') {
      const p = state.planDraft;
      if (state.tasks.length && !confirm('当前会话已经有任务。应用新计划会覆盖这些任务记录，继续吗？')) return;
      for (const row of $$('#modal-root [data-pt]')) {
        const i = Number(row.dataset.pt);
        p.tasks[i].title = $('[data-p="title"]', row).value;
        p.tasks[i].spec = $('[data-p="spec"]', row).value;
        p.tasks[i].owner = $('[data-p="owner"]', row).value;
        p.tasks[i].type = $('[data-p="type"]', row).value;
        p.tasks[i].acceptance = $('[data-p="acceptance"]', row).value.split('\n').map((s) => s.trim()).filter(Boolean);
      }
      await api(`/api/rooms/${state.roomId}/plan/apply`, { method: 'POST', body: { plan: p } });
      closeModal();
      await refreshState();
      toast('计划已创建');
      return;
    }
    if (a === 'rm-plan-task') {
      state.planDraft.tasks = state.planDraft.tasks || [];
      state.planDraft.tasks.splice(Number(el.dataset.i), 1);
      return renderPlanModal();
    }
    if (a === 'plan-add-task') {
      state.planDraft.tasks = state.planDraft.tasks || [];
      state.planDraft.tasks.push({
        title: '新任务', spec: '', type: 'code',
        owner: state.members[0]?.name || '', acceptance: [], dependsOn: [],
      });
      return renderPlanModal();
    }
    if (a === 'add-task') return openTaskModal();
    if (a === 'create-task') {
      const title = $('#nt-title').value.trim();
      if (!title) throw new Error('请填写标题');
      await api('/api/tasks', { method: 'POST', body: {
        roomId: state.roomId, title, spec: $('#nt-spec').value,
        type: $('#nt-type').value, ownerId: $('#nt-owner').value,
        acceptance: $('#nt-accept').value.split('\n').map((s) => s.trim()).filter(Boolean),
      } });
      closeModal();
      await refreshState();
      toast('任务已创建');
      return;
    }
    if (a === 'create-room') {
      const members = collectMembers();
      const pIdx = Number($('#nr-planner').value || 0);
      const rIdx = Number($('#nr-reviewer').value || 0);
      const flowVal = $('#nr-flow').value || '';
      const body = {
        name: $('#nr-name').value.trim() || '未命名会话',
        repoPath: $('#nr-repo').value.trim(),
        requirement: $('#nr-req').value.trim(),
        mode: $('#nr-mode').value,
        autoApprove: $('#nr-auto').value === '1',
        flowTemplate: flowVal.startsWith('tpl:') ? flowVal.slice(4) : undefined,
        flowFromRoomId: flowVal.startsWith('room:') ? flowVal.slice(5) : undefined,
        members,
        plannerName: members[pIdx]?.name,
        reviewerName: members[rIdx]?.name,
      };
      const d = await api('/api/rooms', { method: 'POST', body });
      closeModal();
      await refreshState();
      await openRoom(d.room.id);
      toast('会话已创建');
      return;
    }
    if (a === 'add-member') {
      const n = $$('#nr-members [data-mrow]').length;
      $('#nr-members').insertAdjacentHTML('beforeend', `<div class="member-row" data-mrow>
        <input class="input" data-m="name" placeholder="成员名" value="成员 ${n + 1}">
        <select class="select" data-m="worker">${state.workers.map((w) => `<option value="${w.key}" ${w.available ? '' : 'disabled'}>${esc(w.label)}</option>`).join('')}</select>
        <input class="input" data-m="role_name" placeholder="角色，任意写">
        <input class="input" data-m="role_brief" placeholder="职责边界 / 交付契约">
        <input class="input" data-m="concurrency" type="number" min="1" value="1">
        <button class="rm" data-act="rm-member">✕</button>
      </div>`);
      return refreshRoleSelects();
    }
    if (a === 'rm-member') { el.closest('[data-mrow]').remove(); return refreshRoleSelects(); }
    if (a === 'toggle-run') {
      if (state.room.status === 'running') await api(`/api/rooms/${state.roomId}/pause`, { method: 'POST' });
      else await api(`/api/rooms/${state.roomId}/start`, { method: 'POST' });
      return refreshState();
    }
    if (a === 'cancel-room-run') {
      const d = await api(`/api/rooms/${state.roomId}/runs/cancel`, { method: 'POST' });
      toast(d.cancelled ? '已请求停止当前运行' : '当前没有可停止的计划或评审');
      return;
    }
    if (a === 'toggle-mode') {
      await api(`/api/rooms/${state.roomId}`, { method: 'PATCH', body: { mode: state.room.mode === 'serial' ? 'parallel' : 'serial' } });
      return refreshState();
    }
    if (a === 'toggle-auto') {
      await api(`/api/rooms/${state.roomId}`, { method: 'PATCH', body: { autoApprove: !state.room.auto_approve } });
      return refreshState();
    }
    if (a === 'decisions') return openDecisionsModal();
    if (a === 'add-decision') {
      const text = $('#d-text').value.trim();
      if (!text) throw new Error('请输入决策内容');
      await api('/api/decisions', { method: 'POST', body: { roomId: state.roomId, text } });
      closeModal();
      return refreshState();
    }
    if (a === 'run-task') { el.disabled = true; await api(`/api/tasks/${state.selectedTaskId}/run`, { method: 'POST' }); await refreshState(); return; }
    if (a === 'review-task') { el.disabled = true; toast('评审中…'); await api(`/api/tasks/${state.selectedTaskId}/review`, { method: 'POST' }); await refreshState(); toast('评审完成'); return; }
    if (a === 'merge-task') {
      if (!confirm('确认把这个分支合并到基准分支？')) return;
      await api(`/api/tasks/${state.selectedTaskId}/merge`, { method: 'POST' });
      await refreshState();
      toast('已合并');
      return;
    }
    if (a === 'reject-task') {
      const note = prompt('打回原因（会带回给执行者）：', '请按评审意见修改');
      if (note === null) return;
      await api(`/api/tasks/${state.selectedTaskId}/reject`, { method: 'POST', body: { note } });
      await refreshState();
      return;
    }
    if (a === 'cancel-task') { await api(`/api/tasks/${state.selectedTaskId}/cancel`, { method: 'POST' }); return refreshState(); }
    if (a === 'reload-log') { const d = await api('/api/tasks/' + state.selectedTaskId + '/log'); state.log = d.log || ''; return renderDrawer(); }
    if (a === 'scroll-log') { const b = $('#log-box'); if (b) b.scrollTop = b.scrollHeight; return; }
    if (a === 'flow-mode') {
      state.flowAdvanced = !state.flowAdvanced;
      try { localStorage.setItem('devhub.flowAdvanced', state.flowAdvanced ? '1' : '0'); } catch {}
      return renderMain();
    }
    if (a === 'flow-add') {
      const f = state.room.flow;
      const last = f.nodes.filter((x) => x.type === 'phase').slice(-1)[0];
      const n = {
        id: 'n' + Date.now(), type: 'phase', name: '新阶段', owner: '', gate: 'auto', outputs: [],
        x: last ? Math.min(1350, (last.x || 40) + 230) : 40,
        y: last ? (last.y || 90) : 90,
        maxLoop: 0,
      };
      f.nodes.push(n);
      if (last) f.edges.push({ from: last.id, to: n.id, condition: 'passed' });
      state.flowSelected = n.id;
      return renderMain();
    }
    if (a === 'flow-del') {
      if (!confirm('删除这个阶段？和它相连的线也会一起删掉。')) return;
      const f = state.room.flow;
      f.nodes = f.nodes.filter((n) => n.id !== state.flowSelected);
      f.edges = f.edges.filter((e) => e.from !== state.flowSelected && e.to !== state.flowSelected);
      state.flowSelected = null;
      return renderMain();
    }
    if (a === 'flow-save') {
      await api(`/api/rooms/${state.roomId}`, { method: 'PATCH', body: { flow: state.room.flow } });
      await refreshState();
      toast('流程已保存');
      return;
    }
  } catch (e) {
    console.error(e);
    toast(e.message || String(e), 'err');
    setTimeout(() => { try { renderMain(); if (state.selectedTaskId) renderDrawer(); } catch {} }, 30);
  }
}

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  // 弹窗内容区标了 data-stop：点在内容区时，被冒泡命中的外层遮罩（close-modal）不算数
  const stop = e.target.closest('[data-stop]');
  if (stop && !stop.contains(el)) return;
  if (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') return;
  act(el);
});

document.addEventListener('input', (e) => {
  if (e.target.closest('#nr-members')) refreshRoleSelects();
  if (e.target.closest('#rs-members')) refreshSettingsRoleSelects();
  if (e.target.id === 'nr-flow') renderFlowHint();
});

boot();
