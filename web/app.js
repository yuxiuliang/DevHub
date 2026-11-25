import { addPlanTask, createPlanDraft, removePlanTask, serializePlan, suggestTaskTitle, suggestTaskType } from './plan-draft.js';
import { appendRecentLog, limitLog } from './log-buffer.js';
import { cloneDraft, createDraftCache, sameValue } from './edit-drafts.js';

const settingsDrafts = createDraftCache('devhub.settings-draft.');
const flowDrafts = createDraftCache('devhub.flow-draft.');
const planDrafts = createDraftCache('devhub.plan-draft.');
const flowSaves = new Set();
let settingsRequest = 0;
let newMemberSequence = 0;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
};
const fmtBytes = (n) => Number(n || 0).toLocaleString('zh-CN');

const STATUS = {
  draft: '草稿', planning: '计划中', running: '执行中', paused: '已暂停',
  completed: '已完成', archived: '已归档',
  backlog: '待办', ready: '就绪', review: '待评审', changes_requested: '待修改',
  approved: '已通过', merged: '已合并', done: '已完成',
  failed: '失败', escalated: '已升级', cancelled: '已取消', interrupted: '已中断',
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
  rooms: [], running: [], workers: [], inbox: [], activeWorkers: 0,
  stoppingAll: false, stopPending: false,
  roomId: null, room: null, members: [], tasks: [], events: [], decisions: [], reviews: [],
  roomLoading: false, roomError: '', roomNavigation: 0, roomRequest: 0,
  initialLoaded: false, initialLoading: true, initialLoadError: '',
  workerStatus: 'checking', workerError: '',
  planRoomId: null, planDraft: null, planSource: null, planBase: null, planDraftRecovered: false, planDraftStale: false,
  generatingPlans: new Set(), planErrors: new Map(), startErrors: new Map(), startingRooms: new Set(), applyingPlan: false,
  tab: 'board',
  selectedTaskId: null,
  drawerInvokerTaskId: null, drawerInvoker: null,
  drawerTab: 'overview',
  log: '', logMeta: null, logTruncated: false, logFollow: true,
  inputMeta: null, inputRunId: null, inputFocus: false,
  diff: '', resultSha: '', drawerLoad: '', drawerError: '', drawerNotice: '', taskAction: new Map(),
  settingsEditor: null,
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
  if (!res.ok) {
    const error = new Error(data.error || `请求失败 (${res.status})`);
    error.statusCode = res.status;
    throw error;
  }
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
  renderMain();
  renderRail();
  refreshWorkers();
  try {
    await refreshState();
    const recent = state.rooms.find((room) => room.status !== 'archived');
    if (recent && !state.inbox.length && state.roomNavigation === 0 && !$('#modal-root').children.length) await openRoom(recent.id);
  } catch (e) { if (state.roomId) toast(e.message, 'err'); }
  connectEvents();
  // 兜底轮询：只在 SSE 断开时生效，正常情况下界面完全由事件驱动
  setInterval(() => {
    if (state.live !== 'open' || state.stopPending) refreshState().catch(() => {});
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
      if (wasDown) refreshState().catch(() => {});
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
        if (d.taskId && d.taskId === state.selectedTaskId && (!d.actor || d.actor.kind === 'task')) appendLog(d.line, d.stream, d.runId);
        return;
      }
      const mine = d.room_id === state.roomId;
      if (mine && d.type === 'plan.started') setRoomLive(d.payload?.planner, d.payload?.worker, 'plan', '正在拆解需求…');
      if (mine && d.type === 'review.started') setRoomLive(d.payload?.reviewer, d.payload?.worker, 'review', '正在阅读 diff…');
      if (mine && d.type === 'task.started' && d.task_id === state.selectedTaskId && state.drawerTab === 'log') {
        setDrawerTab('log');
      }
      if (mine && ['plan.ready', 'plan.failed', 'plan.cancelled', 'review.done', 'review.failed', 'review.cancelled', 'room.completed', 'room.paused'].includes(d.type)) clearRoomLive();
      // 任何事件都当作数据可能变化的信号；会话内的变化立即刷新，其他会话只刷左侧列表
      if (mine && d.room_id) scheduleRefresh();
      else scheduleRailRefresh();
    };
  } catch (e) { console.warn(e); }
}

function scheduleRefresh() {
  if (state.refreshTimer) return;
  state.refreshTimer = setTimeout(() => {
    state.refreshTimer = null;
    refreshState().catch(() => {});
  }, 350);
}

let railTimer = null;
function scheduleRailRefresh() {
  if (railTimer) return;
  railTimer = setTimeout(async () => {
    railTimer = null;
    try {
      const request = state.roomRequest;
      const d = await api('/api/state');
      if (request !== state.roomRequest) return;
      state.rooms = d.rooms || [];
      state.running = d.running || [];
      state.inbox = Array.isArray(d.inbox) ? d.inbox : [];
      updateActiveWorkers(d);
      renderRail();
      if (!state.roomId) renderMain();
    } catch {}
  }, 1200);
}

function updateActiveWorkers(data) {
  const reported = Number(data.activeWorkers);
  state.activeWorkers = Number.isInteger(reported) && reported >= 0
    ? reported : (Array.isArray(data.running) ? data.running.length : 0);
  if (state.activeWorkers === 0) state.stopPending = false;
}

async function refreshState() {
  const id = state.roomId;
  const request = ++state.roomRequest;
  if (!id && !state.initialLoaded && !state.initialLoadError) {
    state.initialLoading = true;
    state.initialLoadError = '';
    renderMain();
    renderRail();
  }
  try {
    const [d, r] = await Promise.all([api('/api/state'), id ? api('/api/rooms/' + id) : null]);
    if (request !== state.roomRequest || id !== state.roomId) return;
    state.rooms = d.rooms || [];
    state.running = d.running || [];
    state.inbox = Array.isArray(d.inbox) ? d.inbox : [];
    updateActiveWorkers(d);
    state.flowTemplates = d.flowTemplates || [];
    if (!id) {
      state.initialLoaded = true;
      state.initialLoading = false;
      state.initialLoadError = '';
    }
    if (r) {
      const previous = state.tasks.find((task) => task.id === state.selectedTaskId);
      const current = r.tasks.find((task) => task.id === state.selectedTaskId);
      const finishedRun = previous?.status === 'running' && current && current.status !== 'running';
      if (finishedRun && state.drawerTab === 'log' && state.logFollow && state.drawerLoad === 'loaded') {
        // Refresh final exit information only while following live output.
        queueMicrotask(() => {
          if (state.selectedTaskId === current.id && state.drawerTab === 'log' && state.logFollow) setDrawerTab('log');
        });
      }
      state.room = r.room;
      state.members = r.members;
      state.tasks = r.tasks;
      state.events = r.events;
      state.decisions = r.decisions;
      state.reviews = r.reviews;
    }
    state.roomLoading = false;
    state.roomError = '';
    renderRail();
    renderMain();
    if (state.selectedTaskId) renderDrawer();
  } catch (e) {
    if (request !== state.roomRequest || id !== state.roomId) return;
    if (!id && !state.initialLoaded) {
      state.initialLoading = false;
      state.initialLoadError = e.message || '请检查本地服务后重试。';
      renderMain(true);
      renderRail();
      throw e;
    }
    if (state.roomLoading || state.roomError) {
      state.roomLoading = false;
      state.roomError = e.message;
      renderMain(true);
    }
    throw e;
  }
}

/** 只有渲染输入真的变了才重建 DOM，避免每个事件都把看板/抽屉整体重置。 */
function mainSignature() {
  return JSON.stringify([
    state.roomId,
    state.tab,
    state.flowSelected,
    state.flowAdvanced,
    state.tab === 'flow' && state.room ? [flowEntry()?.dirty, flowEntry()?.error, flowSaves.has(state.roomId), Boolean(state.roomLive)] : null,
    state.room && [state.room.status, state.room.name, state.room.requirement, state.room.mode,
      state.room.auto_approve, state.room.flow, state.room.plan, state.room.updated_at],
    state.generatingPlans.has(state.roomId),
    state.planErrors.get(state.roomId),
    state.startErrors.get(state.roomId),
    state.startingRooms.has(state.roomId),
    state.running.map((entry) => [entry.taskId, entry.phase]),
    state.members.map((m) => [m.id, m.name, m.worker, m.role_name, m.role_brief, m.model, m.concurrency, m.enabled]),
    state.tasks.map((t) => [t.id, t.status, t.title, t.spec, t.owner_id, t.updated_at, t.diff_stat]),
    state.decisions.length,
    state.tab === 'board' ? state.events.at(-1)?.id : null,
  ]);
}

function drawerSignature(t) {
  if (!t) return '';
  return JSON.stringify([
    state.drawerTab,
    t.id, t.status, t.updated_at, t.summary, t.feedback, t.diff_stat, t.phase_id, t.reject_count, runPhase(t.id),
    state.room?.updated_at,
    state.reviews.length,
    state.drawerTab === 'diff' ? state.diff.length : 0,
    state.drawerTab === 'input'
      ? [state.inputRunId, state.inputMeta?.runId, (state.inputMeta?.prompt || '').length, state.inputMeta?.available, state.inputMeta?.readError]
      : null,
  ]);
}

async function openRoom(id) {
  state.roomNavigation++;
  closeModal();
  closeDrawer(false);
  state.roomId = id;
  state.room = null;
  state.roomLoading = Boolean(id);
  state.roomError = '';
  state.members = [];
  state.tasks = [];
  state.events = [];
  state.decisions = [];
  state.reviews = [];
  state.tab = 'board';
  state.flowSelected = null;
  state.activity.clear();
  clearRoomLive();
  renderRail();
  renderMain(true);
  await refreshState();
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
  const badge = $('#inbox-count');
  if (badge) {
    badge.hidden = !state.inbox.length;
    badge.textContent = String(state.inbox.length);
  }
  const overview = $('[data-act="open-overview"]');
  if (overview) {
    if (!state.roomId) overview.setAttribute('aria-current', 'page');
    else overview.removeAttribute('aria-current');
  }
  const stopAll = $('#btn-stop-all');
  if (stopAll) {
    const busy = state.stoppingAll || state.stopPending;
    stopAll.hidden = state.activeWorkers === 0 && !busy;
    stopAll.disabled = busy || state.activeWorkers === 0;
    stopAll.textContent = busy ? '正在停止…' : `停止所有运行（${state.activeWorkers}）`;
    stopAll.setAttribute('aria-label', busy ? '正在停止所有运行' : `停止所有运行中的协作工具，共 ${state.activeWorkers} 项`);
  }
  const rooms = state.rooms.filter((r) => state.showArchived || r.status !== 'archived' || r.id === state.roomId);
  const focusedRoomId = list.contains(document.activeElement) ? document.activeElement.dataset.id : null;
  list.innerHTML = rooms.length
    ? rooms.map((r) => {
      const active = r.id === state.roomId ? ' active' : '';
      const archived = r.status === 'archived' ? ' archived' : '';
      const dot = r.counts.failed ? 'failed' : r.counts.running ? 'running' : r.counts.review ? 'review' : r.status === 'completed' ? 'completed' : r.status === 'paused' ? 'paused' : '';
      return `<button class="room-item${active}${archived}" data-act="open-room" data-id="${esc(r.id)}"${active ? ' aria-current="page"' : ''}>
        <span class="ri-top"><span class="dot ${dot}" aria-hidden="true"></span><span class="ri-name">${esc(r.name)}</span></span>
        <span class="ri-sub"><span>${r.counts.total} 任务</span><span>${r.counts.running} 运行</span><span>${r.counts.review} 待审</span>${r.status === 'paused' ? '<span class="ri-paused">已暂停</span>' : ''}${archived ? '<span>已归档</span>' : ''}</span>
      </button>`;
    }).join('')
    : !state.initialLoaded
      ? `<div class="small rail-empty" role="status">${state.initialLoading ? '正在读取会话…' : '会话暂不可用'}</div>`
      : `<div class="small rail-empty">${state.rooms.length ? '没有活跃会话，点上方「显示归档」查看历史' : '还没有会话'}</div>`;
  if (focusedRoomId) {
    $$('button[data-id]', list).find((button) => button.dataset.id === focusedRoomId)?.focus({ preventScroll: true });
  }

  const availableWorkers = state.workers.filter((worker) => worker.available).length;
  const workerSummary = $('#worker-summary-state');
  if (workerSummary) workerSummary.textContent = state.workerStatus === 'checking' ? '检测中…'
    : state.workerStatus === 'error' ? '检测失败'
      : availableWorkers ? `${availableWorkers} 个就绪` : '未找到可用工具';
  const workerMessage = state.workerStatus === 'checking' ? '正在检测本机上的协作工具…'
    : state.workerStatus === 'error' ? `检测失败${state.workerError ? `：${state.workerError}` : '，请稍后重试。'}`
      : !availableWorkers ? '没有找到可用工具。确认支持的 CLI 已安装或可执行路径已配置，然后重新检测。' : '';
  const messageKind = state.workerStatus === 'error' ? ' error' : state.workerStatus === 'ready' && !availableWorkers ? ' missing' : '';
  const workerList = $('#worker-list');
  const keepWorkerStatusFocus = workerList.contains(document.activeElement) &&
    (document.activeElement.matches('.worker-status') || document.activeElement.matches('[data-act="check-workers"]'));
  workerList.innerHTML = `${workerMessage ? `<p class="worker-status${messageKind}" role="${state.workerStatus === 'error' ? 'alert' : 'status'}" tabindex="-1">${esc(workerMessage)}</p>` : ''}
    ${state.workers.map((w) => `
      <div class="worker-row ${w.available ? 'on' : ''}">
        <span class="dot ${w.available ? 'running' : ''}" aria-hidden="true"></span>
        <span class="w-name">${esc(w.label)}</span>
        <span class="w-state">${w.available ? '就绪' : '未检测到'}</span>
      </div>`).join('')}
    <button class="btn sm ghost worker-refresh" type="button" data-act="check-workers" ${state.workerStatus === 'checking' ? 'disabled' : ''}>${state.workerStatus === 'checking' ? '正在检测…' : '重新检测'}</button>`;
  if (keepWorkerStatusFocus) {
    const nextFocus = state.workerStatus === 'checking' ? workerList.querySelector('.worker-status') : workerList.querySelector('[data-act="check-workers"]');
    nextFocus?.focus({ preventScroll: true });
  }
}

/* ---------------- main ---------------- */

function renderMain(force = false) {
  const main = $('#main');
  if (!state.initialLoaded) {
    main.innerHTML = state.initialLoadError
      ? `<section class="overview-load-error" role="alert"><div><h1>工作区暂时无法读取</h1><p>${esc(state.initialLoadError)}</p><button class="btn sm primary" data-act="refresh">重新连接</button></div></section>`
      : `<section class="overview-loading" aria-busy="${state.initialLoading}" aria-labelledby="overview-loading-title">
          <div class="overview-loading-copy"><span class="spin" aria-hidden="true"></span><div><h1 id="overview-loading-title">正在读取工作区</h1><p role="status">正在加载会话和待处理事项…</p></div></div>
          <div class="overview-loading-lines" aria-hidden="true"><span></span><span></span><span></span></div>
        </section>`;
    state.mainSig = '';
    return;
  }
  if (state.roomLoading || state.roomError) {
    main.innerHTML = state.roomError
      ? `<div class="center"><p>${esc(state.roomError)}</p><button class="btn sm" data-act="refresh">重新加载</button></div>`
      : '<div class="center" role="status">正在打开会话…</div>';
    state.mainSig = '';
    return;
  }
  if (!state.room) {
    const sig = JSON.stringify(['overview', state.showArchived, state.rooms, state.inbox]);
    if (!force && state.mainSig === sig) return;
    const focused = main.contains(document.activeElement) ? document.activeElement.dataset : null;
    main.innerHTML = renderOverview();
    state.mainSig = sig;
    if (focused?.inboxId) {
      $$('[data-inbox-id]', main).find((button) => button.dataset.inboxId === focused.inboxId)?.focus({ preventScroll: true });
    }
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
  const oldField = $('.flow-side', main)?.contains(document.activeElement) ? document.activeElement : null;
  const fieldFocus = oldField ? { data: { ...oldField.dataset }, start: oldField.selectionStart, end: oldField.selectionEnd } : null;
  const focusedView = main.contains(document.activeElement) && document.activeElement.matches('button[data-act="tab"]')
    ? document.activeElement.dataset.tab : null;
  const focusedTaskId = main.contains(document.activeElement) && document.activeElement.matches('button.card[data-act="open-task"]')
    ? document.activeElement.dataset.id : null;

  main.innerHTML = renderRoom();

  const newBoard = $('.board', main);
  if (newBoard && scrollTop) newBoard.scrollTop = scrollTop;
  const newCanvas = $('.flow-canvas', main);
  if (newCanvas && scrollLeft) newCanvas.scrollLeft = scrollLeft;
  wireFlow();
  if (focusedView) {
    $$('button[data-act="tab"]', main).find((button) => button.dataset.tab === focusedView)?.focus({ preventScroll: true });
  }
  if (focusedTaskId) {
    $$('.card[data-act="open-task"]', main).find((button) => button.dataset.id === focusedTaskId)?.focus({ preventScroll: true });
  }
  if (state.tab === 'flow') {
    syncFlowStatus();
    if (fieldFocus) {
      const next = $$('.flow-side [data-field], .flow-side [data-next], .flow-side [data-artifact]', main)
        .find((el) => Object.entries(fieldFocus.data).every(([key, value]) => el.dataset[key] === value));
      next?.focus({ preventScroll: true });
      if (next && typeof fieldFocus.start === 'number' && next.setSelectionRange && next.type !== 'number') {
        next.setSelectionRange(fieldFocus.start, fieldFocus.end);
      }
    }
  }
}

function renderInbox() {
  const labels = {
    failed: ['运行未完成', '打开后查看原因，再决定是否重试。', '查看原因'],
    changes_requested: ['需要修改', '查看检查意见，再安排修改。', '查看意见'],
    escalated: ['需要你决定', '打回次数已到上限，请查看成果和意见。', '查看任务'],
    review: ['成果已准备好', '检查改动后，决定是否合并。', '查看成果'],
    approved: ['检查已通过', '查看成果，再决定是否合并。', '查看成果'],
    planning: ['计划待确认', '检查任务安排，确认后再开始。', '检查计划'],
  };
  if (!state.inbox.length) {
    const active = state.running.length;
    return `<section class="inbox" aria-labelledby="inbox-title">
      <div class="inbox-heading"><h2 id="inbox-title">需要你处理</h2></div>
      <p class="inbox-empty">${active ? `有 ${active} 项任务正在执行，成果准备好后会显示在这里。` : '暂时没有需要确认的事项。可以打开下方会话，或开始一个新任务。'}</p>
    </section>`;
  }
  return `<section class="inbox" aria-labelledby="inbox-title">
    <div class="inbox-heading"><h2 id="inbox-title">需要你处理</h2><span>${state.inbox.length} 项</span></div>
    <p class="field-help">先处理异常，再确认计划和成果。</p>
    <ul class="inbox-list">${state.inbox.map((item) => {
      const [label, hint, action] = labels[item.status] || ['需要确认', '打开查看当前状态。', '查看任务'];
      return `<li class="inbox-item ${item.kind === 'problem' ? 'inbox-problem' : ''}">
        <div class="inbox-copy">
          <p class="inbox-context"><span class="inbox-status">${esc(label)}</span><span>${esc(item.roomName)}</span></p>
          <h3>${esc(item.kind === 'plan' ? '确认任务安排' : item.title)}</h3>
          <p class="inbox-hint">${hint}</p>
        </div>
        <button class="btn sm" data-act="open-inbox" data-inbox-id="${esc(item.id)}">${action}</button>
      </li>`;
    }).join('')}</ul>
  </section>`;
}

async function openInboxItem(id) {
  const item = state.inbox.find((entry) => entry.id === id);
  if (!item) {
    toast('这项待办已更新，请重新选择。');
    return;
  }
  const opening = openRoom(item.roomId);
  const navigation = state.roomNavigation;
  await opening;
  if (navigation !== state.roomNavigation || state.room?.id !== item.roomId) return;
  if (state.room.status === 'archived') {
    toast('这个会话已归档，恢复后可以继续操作。');
    return;
  }
  if (item.kind === 'plan') {
    if (Array.isArray(state.room.plan?.tasks) && state.room.plan.tasks.length &&
        state.tasks.every((task) => ['backlog', 'ready'].includes(task.status) && !task.branch && !task.worktree)) {
      openPlanModal(state.room.plan, item.roomId);
    } else {
      toast('计划状态已更新，已打开当前会话。');
    }
    return;
  }
  const task = state.tasks.find((entry) => entry.id === item.taskId);
  if (!task) {
    toast('这项任务已更新，已打开当前会话。');
    return;
  }
  const showResult = item.kind === 'result' && ['review', 'approved', 'escalated'].includes(task.status);
  openTask(task.id, showResult ? 'diff' : 'overview');
}

function renderOverview() {
  const rooms = state.rooms.filter((room) => state.showArchived || room.status !== 'archived');
  if (!rooms.length) return `<section class="overview welcome">
    <div class="welcome-copy">
      <h1>从一个项目开始</h1>
      <p>选择电脑上的项目，告诉 DevHub 你想做什么。等你确认计划，再开始执行。</p>
      <button class="btn sm primary" data-act="new-room">开始一个项目</button>
    </div>
    <ol class="welcome-steps" aria-label="使用步骤">
      <li><b>选择项目</b><span>打开电脑上已有的项目文件夹</span></li>
      <li><b>描述要做的事</b><span>用自己的话说明需要什么</span></li>
      <li><b>确认计划并执行</b><span>检查任务，决定什么时候开始</span></li>
      <li><b>查看成果</b><span>看清改动，再决定是否合并</span></li>
    </ol>
  </section>`;
  const cards = rooms.map((r) => `
    <button class="ov-card" data-act="open-room" data-id="${esc(r.id)}">
      <strong>${esc(r.name)}</strong>
      ${r.status === 'paused' ? '<span class="ov-status paused">已暂停</span>' : ''}
      <span class="ov-req">${esc(r.requirement || '（没有填写需求）')}</span>
      <span class="ov-metrics">
        <span><b>${r.counts.total}</b>任务</span>
        <span><b>${r.counts.running}</b>运行</span>
        <span><b>${r.counts.review}</b>待处理</span>
        <span><b>${r.counts.done}</b>完成</span>
      </span>
    </button>`).join('');
  return `<div class="overview">
    <header class="overview-heading"><h1>协作总览</h1><button class="btn sm primary" data-act="new-room">开始一个项目</button></header>
    ${renderInbox()}
    <section class="overview-rooms" aria-labelledby="rooms-title">
      <h2 id="rooms-title">所有会话</h2>
      <div class="ov-grid">${cards}</div>
    </section>
  </div>`;
}

function renderRoom() {
  const r = state.room;
  const archived = r.status === 'archived';
  return `
  <div class="room-head">
    <div>
      <h1>${esc(r.name)}</h1>
      <div class="room-req">${esc(r.requirement || '还没有填写需求')}</div>
    </div>
    <div class="room-actions">
      ${r.status === 'running' ? '<button class="btn sm" data-act="toggle-run">暂停</button>' : ''}
      <button class="btn sm" data-act="room-settings">设置</button>
      <details class="room-more"><summary>更多操作</summary><div class="room-more-menu">
        ${archived ? '' : '<button class="btn sm ghost" data-act="add-task">手动添加任务</button>'}
        ${!archived && r.status !== 'running' && state.tasks.some((task) => ['backlog', 'ready'].includes(task.status)) ? `<button class="btn sm ghost" data-act="toggle-run">${r.status === 'paused' ? '继续执行' : '开始执行'}</button>` : ''}
        ${!archived && state.tasks.length && state.tasks.every((t) => ['backlog', 'ready'].includes(t.status) && !t.worktree) ? '<button class="btn sm ghost" data-act="plan-room">重新生成计划</button>' : ''}
        <button class="btn sm ghost" data-act="decisions">查看决策</button>
        <button class="btn sm ghost" data-act="refresh">刷新</button>
      </div></details>
    </div>
  </div>
  ${renderRoomNext()}
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
    <div class="tabs" role="group" aria-label="会话视图">
      <button type="button" class="tab ${state.tab === 'board' ? 'active' : ''}" data-act="tab" data-tab="board" aria-pressed="${state.tab === 'board'}">任务板</button>
      <button type="button" class="tab ${state.tab === 'flow' ? 'active' : ''}" data-act="tab" data-tab="flow" aria-pressed="${state.tab === 'flow'}">流程</button>
    </div>
  </div>
  ${state.members.length > 1 || state.tasks.some((task) => task.status === 'running') ? renderMembers() : ''}
  ${state.tab === 'flow' ? renderFlow() : renderBoard()}`;
}

function runPhase(taskId) {
  const phase = state.running.find((entry) => entry.taskId === taskId)?.phase;
  if (phase === 'starting' || phase === 'preparing') return '正在准备工作区…';
  if (phase === 'collecting') return '正在整理改动…';
  return '';
}

function waitingFor(task) {
  const deps = Array.isArray(task.deps) ? task.deps : [];
  return deps.filter((key) => !state.tasks.some((candidate) => candidate.key === key && ['merged', 'done'].includes(candidate.status)));
}

function renderRoomNext() {
  const { room } = state;
  const action = (label, hint, button, act, taskId = '') => `<section class="next-action" aria-label="下一步">
    <div><b>${esc(label)}</b><p>${esc(hint)}</p></div>
    ${act ? `<button class="btn sm primary" data-act="${act}" data-id="${esc(taskId)}">${button}</button>` : ''}
  </section>`;
  if (room.status === 'archived') return action('会话已归档', '恢复后可以继续操作。', '恢复会话', 'restore-room');
  if (state.generatingPlans.has(room.id)) return `<section class="next-action" role="status">
    <div><b>正在生成计划</b><p>计划生成后会打开确认页。</p></div>
  </section>`;
  if (state.startErrors.has(room.id)) {
    const reason = state.startErrors.get(room.id);
    return `<section class="next-action plan-retry" aria-label="执行未开始">
      <div><h3>任务已准备好，但没有开始</h3>
        <details><summary>查看原因</summary><p>${esc(reason)}</p></details>
      </div>
      <button class="btn sm primary" data-act="toggle-run">开始执行</button>
    </section>`;
  }
  if (state.startingRooms.has(room.id)) return `<section class="next-action" role="status"><div><b>正在启动任务</b><p>正在准备执行队列。</p></div></section>`;
  if (state.room.plan?.validationErrors?.length) {
    const errors = state.room.plan.validationErrors.map((error) => esc(error)).join('；');
    return `<section class="next-action plan-retry" aria-label="计划校验" role="status">
      <div><h3>计划需要确认</h3><p>${errors}</p></div>
      <button class="btn sm primary" data-act="view-plan">检查计划</button>
    </section>`;
  }
  if (room.plan?.tasks) return action('计划已准备好', '确认后会创建任务。', '确认计划', 'view-plan');
  if (!state.tasks.length) {
    const previous = state.events.findLast((event) => ['plan.started', 'plan.failed', 'plan.cancelled', 'plan.ready'].includes(event.type));
    const error = state.planErrors.get(room.id) || (previous?.type === 'plan.failed' ? previous.payload?.error : '');
    if (error || previous?.type === 'plan.cancelled') {
      const cancelled = previous?.type === 'plan.cancelled' || /已取消/.test(error);
      const label = cancelled ? '计划已停止' : '计划没生成出来';
      return `<section class="next-action plan-retry" aria-label="生成计划">
        <div><h3 role="status">${label}</h3><p>需求已保存，可以直接重试。</p>
          ${error && !cancelled ? `<details><summary>查看原因</summary><p>${esc(String(error).slice(0, 500))}</p></details>` : ''}
        </div>
        <button class="btn sm primary" data-act="plan-room">重新生成计划</button>
      </section>`;
    }
    return action('先生成一份计划', '看看需要完成哪些任务。', '生成计划', 'plan-room');
  }
  const result = state.tasks.find((task) => ['review', 'approved', 'escalated'].includes(task.status));
  if (result) return action('有成果可以检查', '查看改动，决定合并或退回修改。', '查看成果', 'open-result', result.id);
  const issue = state.tasks.find((task) => ['failed', 'changes_requested'].includes(task.status));
  if (issue) return action('有任务需要处理', '打开任务查看失败原因或修改意见。', '查看任务', 'open-task', issue.id);
  if (room.status === 'paused') {
    const active = state.tasks.some((task) => task.status === 'running');
    const cancelled = state.tasks.some((task) => task.status === 'cancelled');
    const hint = active
      ? '正在执行的任务会继续；恢复后才会启动队列中的其他任务。'
      : cancelled
        ? '继续执行只会启动等待队列；已取消的任务不会自动重跑，请从任务详情中单独启动。'
        : '恢复后会从等待队列继续执行。';
    return action('会话已暂停', hint, '继续执行', 'toggle-run');
  }
  if (room.status === 'completed') return action('会话已完成', '你可以打开任务查看成果和记录。');
  const current = state.tasks.find((task) => task.status === 'running');
  const unblocked = state.tasks.filter((task) => ['backlog', 'ready'].includes(task.status) && !waitingFor(task).length);
  const hasAssignee = (task) => state.members.some((member) => member.id === task.owner_id && member.enabled);
  if (unblocked.length && !unblocked.some(hasAssignee) && !current) {
    return action('没有可用的负责人', '在设置中启用这些任务的负责人，再继续执行。', '打开设置', 'room-settings');
  }
  if (current) return action(runPhase(current.id) || '正在执行', room.status === 'running'
    ? '你可以稍后回来查看成果。' : '当前任务正在单独执行；其他任务不会随之自动开始。');
  if (room.status !== 'running' && unblocked.length) return action('任务已准备好', room.mode === 'serial' ? 'DevHub 会逐个执行任务。' : '没有前置依赖的任务可以同时执行。', '开始执行', 'toggle-run');
  if (unblocked.some((task) => task.status === 'ready' && hasAssignee(task))) {
    return action('等待执行', '有空闲名额后会自动开始。');
  }
  const manual = unblocked.find((task) => task.status === 'backlog' && hasAssignee(task));
  if (manual) return action('有任务尚未启动', '这项任务还未开始。打开详情后，可点击「运行任务」单独启动。', '查看任务', 'open-task', manual.id);
  const cancelled = state.tasks.find((task) => task.status === 'cancelled');
  if (cancelled) return action('有任务已取消', '已取消的任务不会自动重跑。打开详情后，可查看记录或重新运行。', '查看任务', 'open-task', cancelled.id);
  const pending = state.tasks.find((task) => ['backlog', 'ready'].includes(task.status) && waitingFor(task).length);
  if (pending) return action('等待前置任务', '前置任务完成后，这项任务才能开始。', '查看任务', 'open-task', pending.id);
  return action('没有等待执行的任务', '可以查看已结束的记录，或手动添加新任务。', '添加任务', 'add-task');
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
            <span class="mc-doing">${esc(runPhase(task.id) || act?.line || '正在执行…')}</span>
          </div>` : ''}
      </div>
    </div>`;
  }).join('') || '<div class="small muted">还没有成员</div>'}</div>`;
}

const COLUMNS = [
  { key: 'todo', name: '待办', statuses: ['backlog', 'ready'] },
  { key: 'running', name: '运行中', statuses: ['running'] },
  { key: 'review', name: '待处理', statuses: ['review', 'changes_requested', 'approved', 'escalated', 'failed'] },
  { key: 'done', name: '已结束', statuses: ['merged', 'done', 'cancelled'] },
];

function memberName(id) {
  return state.members.find((m) => m.id === id)?.name || '未指派';
}

function renderBoard() {
  const failed = state.tasks.filter((t) => ['failed', 'escalated'].includes(t.status));
  const alert = failed.length ? `<div class="board-alert" style="grid-column:1/-1;background:var(--red-soft);border:1px solid #ecc9c4;border-radius:9px;padding:8px 12px;font-size:12px;color:var(--red);margin-bottom:2px">
      有 ${failed.length} 个任务异常：${failed.map((t) => esc(t.key)).join('、')} —— 打开任务查看原因
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
    <div class="board">${alert}${cols}</div>
    ${renderTimeline()}
  </div>`;
}

function taskCard(t) {
  const cls = ['failed', 'escalated'].includes(t.status) ? 'failed' : t.status === 'running' ? 'running' : ['review', 'changes_requested', 'approved'].includes(t.status) ? 'review' : '';
  const badge = t.status === 'cancelled' ? '<span class="badge mute">已取消</span>'
    : t.status === 'changes_requested' ? '<span class="badge warn">待修改</span>'
    : t.status === 'escalated' ? '<span class="badge err">需人工</span>'
      : t.status === 'failed' ? '<span class="badge err">失败</span>'
        : t.status === 'approved' ? '<span class="badge ok">已通过</span>'
          : t.status === 'ready' ? '<span class="badge mute">就绪</span>' : '';
  const member = state.members.find((m) => m.id === t.owner_id);
  const worker = member ? workerLabel(member.worker) : '';
  const act = state.activity.get(t.id);
  const live = t.status === 'running'
    ? `<span class="c-live">
         <span class="pulse"></span>
         <span class="c-actor">${esc(member?.name || '未指派')}${worker ? ` · ${esc(worker)}` : ''}</span>
         <span class="c-elapsed" data-since="${esc(t.updated_at)}">0:00</span>
         <span class="c-doing">${esc(runPhase(t.id) || act?.line || '正在执行…')}</span>
       </span>`
    : '';
  return `<button class="card ${cls}" data-act="open-task" data-id="${esc(t.id)}">
    <span class="c-key">${esc(t.key)} · ${esc(t.type)}</span>
    <span class="c-title">${esc(t.title)}</span>
    <span class="c-spec">${esc(t.spec || '（无说明）')}</span>
    ${live}
    <span class="c-foot">
      <span class="owner">${esc(member?.name || '未指派')}</span>
      ${badge}
      ${t.diff_stat ? `<span class="small muted right">${esc((t.diff_stat || '').split('\n').pop() || '')}</span>` : ''}
    </span>
  </button>`;
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
    case 'room.updated': return p.baseBranch ? `基准分支改为 ${p.baseBranch}` : '会话设置已更新';
    case 'room.recovered': return '服务重启，已暂停会话，可以继续执行';
    case 'task.interrupted': return '服务重启中断了任务，可以重新运行';
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
    case 'review.done': return `评审完成 · ${p.verdict === 'approve' ? '通过' : p.escalated ? `要求修改（已达 ${p.maxLoop || 2} 次，转人工）` : '要求修改'}${p.round ? `（第 ${p.round} 轮）` : ''}`;
    case 'review.failed': return `评审失败 · ${String(p.error || '').slice(0, 80)}`;
    case 'review.cancelled': return '评审已取消';
    case 'gate.waiting': return `${p.key || ''} 等待${p.gate === 'human' ? '人工确认' : '评审'}`;
    case 'gate.passed': return `${p.key || ''} 检查通过 · ${p.gate === 'auto' ? '自动通过' : '人工确认'}`;
    case 'gate.escalated': return `${p.key || ''} 已打回 ${p.rejectCount || 0} 次，达到上限，转人工决定`;
    case 'decision.added': return `新增决策 · ${p.text || ''}`;
    case 'member.added': return `新增成员 · ${p.name || ''}`;
    case 'member.updated': return `成员更新 · ${p.name || ''}`;
    case 'member.removed': return `移除成员 · ${p.name || ''}`;
    default: return e.type;
  }
}

function eventRunMetrics(event) {
  if (event.type !== 'task.finished') return [];
  const payload = event.payload || {};
  const metrics = [];
  let hasTokenUsage = false;
  if (typeof payload.cost === 'number' && Number.isFinite(payload.cost) && payload.cost >= 0) {
    const amount = payload.cost > 0 && payload.cost < 0.000001
      ? '<$0.000001'
      : '$' + payload.cost.toLocaleString('en-US', { maximumFractionDigits: 6, useGrouping: false });
    metrics.push(`费用 ${amount} USD`);
  }
  const usage = payload.usage;
  if (usage && typeof usage === 'object' && !Array.isArray(usage)) {
    const numberFrom = (keys) => keys.map((key) => usage[key]).find((value) => Number.isSafeInteger(value) && value >= 0);
    const total = numberFrom(['total_tokens', 'totalTokens', 'total']);
    const input = numberFrom(['input_tokens', 'inputTokens', 'prompt_tokens', 'input']);
    const output = numberFrom(['output_tokens', 'outputTokens', 'completion_tokens', 'output']);
    // Only a reported total is a total; missing or separately counted categories
    // must not be silently treated as zero and added together.
    const reported = total !== undefined ? [['用量', total]] : [['输入', input], ['输出', output]];
    for (const [label, tokens] of reported) {
      if (tokens !== undefined) {
        metrics.push(`${label} ${tokens.toLocaleString('zh-CN')} tokens`);
        hasTokenUsage = true;
      }
    }
  }
  const endAt = Date.parse(event.created_at || '');
  if (!hasTokenUsage && event.task_id) {
    const started = state.events.findLast((candidate) => candidate.type === 'task.started' &&
      candidate.task_id === event.task_id && (event.run_id
        ? candidate.run_id === event.run_id
        : Date.parse(candidate.created_at || '') <= endAt));
    const startAt = Date.parse(started?.created_at || '');
    if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt < startAt) return metrics;
    let seconds = Math.floor((endAt - startAt) / 1000);
    const hours = Math.floor(seconds / 3600);
    seconds %= 3600;
    const minutes = Math.floor(seconds / 60);
    seconds %= 60;
    const elapsed = hours ? `${hours}小时 ${minutes}分` : minutes ? `${minutes}分 ${seconds}秒` : `${seconds}秒`;
    metrics.push(`耗时 ${elapsed}`);
  }
  return metrics;
}

function renderTimeline() {
  const items = state.events.slice(-80).reverse();
  return `<div class="timeline">
    <div class="tl-head"><b>时间线</b><span class="small muted right">${state.events.length} 条</span></div>
    <div class="tl-list">
      ${items.map((e) => {
    const cls = e.type.startsWith('plan') ? 'ev-plan' : e.type.startsWith('review') ? 'ev-review' : e.type.includes('fail') || e.type.includes('error') ? 'ev-error' : e.type.startsWith('task') ? 'ev-task' : '';
    const metrics = eventRunMetrics(e);
    return `<div class="tl-item ${cls}"><span class="tl-time">${fmtTime(e.created_at)}</span><span class="tl-dot"></span><div class="tl-body">${esc(eventText(e))}${metrics.length ? `<small class="tl-metric">${metrics.map((metric) => `<span>${esc(metric)}</span>`).join('')}</small>` : ''}</div></div>`;
  }).join('') || '<div class="small muted">还没有事件</div>'}
    </div>
  </div>`;
}

/* ---------------- flow ---------------- */

function flowEntry() {
  if (!state.room) return null;
  const saved = state.room.flow && Array.isArray(state.room.flow.nodes) ? state.room.flow : { nodes: [], edges: [] };
  let draft = flowDrafts.get(state.room.id);
  if (!draft || !Array.isArray(draft.flow?.nodes) || !Array.isArray(draft.base?.nodes) ||
      (!draft.dirty && !sameValue(draft.base, saved))) {
    draft = { base: cloneDraft(saved), flow: cloneDraft(saved), dirty: false, error: '' };
    flowDrafts.set(state.room.id, draft);
  }
  return draft;
}

function editableFlow() {
  return flowEntry()?.flow || { nodes: [], edges: [] };
}

function flowReadOnly() {
  return state.room?.status === 'archived' || state.tasks.some((task) => task.status === 'running') ||
    Boolean(state.roomLive) || state.generatingPlans.has(state.roomId) || flowSaves.has(state.roomId);
}

function rememberFlowEdit() {
  const draft = flowEntry();
  if (!draft) return;
  draft.dirty = !sameValue(draft.flow, draft.base);
  draft.error = '';
  flowDrafts.set(state.roomId, draft);
  syncFlowStatus();
}

function flowConflict(draft = flowEntry()) {
  return Boolean(draft && (draft.conflict || (draft.dirty && !sameValue(draft.base, state.room.flow))));
}

function syncFlowStatus() {
  const draft = flowEntry();
  const note = $('#flow-draft-status');
  const save = $('[data-act="flow-save"]');
  if (!draft || !note) return;
  const conflict = flowConflict(draft);
  note.textContent = conflict ? '流程已在其他地方更新。草稿保留，请加载已保存流程后再调整。'
    : draft.dirty ? '草稿已保留，尚未保存到会话。' : '当前显示已保存的流程。';
  if (save) save.disabled = flowReadOnly() || conflict || !draft.dirty;
  const error = $('#flow-save-error');
  if (error) { error.hidden = !draft.error; error.textContent = draft.error || ''; }
}

async function saveFlow() {
  const roomId = state.roomId;
  const draft = flowEntry();
  if (!draft || !draft.dirty || flowReadOnly()) return;
  if (flowConflict(draft)) { syncFlowStatus(); return; }
  const sent = cloneDraft(draft.flow);
  flowSaves.add(roomId);
  renderMain(true);
  try {
    await api(`/api/rooms/${roomId}`, { method: 'PATCH', body: { flow: sent, expectedFlow: draft.base } });
    draft.base = cloneDraft(sent);
    draft.flow = cloneDraft(sent);
    draft.dirty = false;
    draft.error = '';
    draft.conflict = false;
    flowDrafts.set(roomId, draft);
    if (state.room?.id === roomId) state.room.flow = cloneDraft(sent);
  } catch (failure) {
    draft.error = failure.message;
    if (failure.statusCode === 409 && /其他地方更新|最新流程/.test(failure.message)) draft.conflict = true;
    flowDrafts.set(roomId, draft);
    return;
  } finally {
    flowSaves.delete(roomId);
    if (state.roomId === roomId) renderMain(true);
  }
  toast('流程已保存');
  await refreshState().catch(() => toast('流程已保存，状态更新失败，可刷新查看。', 'err'));
}

async function reloadFlow() {
  const roomId = state.roomId;
  const navigation = state.roomNavigation;
  const draft = flowEntry();
  if (!draft || flowSaves.has(roomId)) return;
  if (draft.dirty && !confirm('重新加载会放弃流程草稿，显示已保存的流程。继续？')) return;
  try {
    const latest = await api(`/api/rooms/${roomId}`);
    if (state.roomNavigation !== navigation || state.roomId !== roomId) return;
    flowDrafts.delete(roomId);
    state.room.flow = latest.room.flow;
    state.flowSelected = null;
    renderMain(true);
  } catch (failure) {
    draft.error = failure.message;
    flowDrafts.set(roomId, draft);
    syncFlowStatus();
  }
}

function renderFlow() {
  const flow = editableFlow();
  const nodes = flow.nodes || [];
  const sel = nodes.find((n) => n.id === state.flowSelected);
  const busy = state.tasks.some((t) => t.status === 'running') || state.roomLive || state.generatingPlans.has(state.roomId);
  const readOnly = flowReadOnly();
  const draft = flowEntry();
  const conflict = flowConflict(draft);
  return `<div class="flow-toolbar">
      <b style="font-size:12px">${esc(flow.name || '流程')}</b>
      <span class="small muted">拖拽节点调整位置 · 点节点编辑</span>
      <span class="spacer"></span>
      ${state.room.status === 'archived' ? '<span class="badge warn">会话已归档，流程只读</span>' : busy ? '<span class="badge warn">有任务运行中，流程只读</span>' : ''}
      <button class="btn sm ghost" data-act="flow-mode">${state.flowAdvanced ? '简单模式' : '高级设置'}</button>
      <button class="btn sm" data-act="flow-add" ${readOnly ? 'disabled' : ''}>＋ 阶段</button>
      <button class="btn sm" data-act="flow-reload" ${flowSaves.has(state.roomId) ? 'disabled' : ''}>加载已保存流程</button>
      <button class="btn sm primary" data-act="flow-save" ${readOnly || conflict || !draft.dirty ? 'disabled' : ''}>${flowSaves.has(state.roomId) ? '正在保存…' : '保存流程'}</button>
    </div>
    <div class="flow-draft-feedback"><p id="flow-draft-status" role="status"></p><p class="form-error" id="flow-save-error" role="alert" ${draft.error ? '' : 'hidden'}>${esc(draft.error || '')}</p></div>
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
            <button type="button" class="fnode ${n.id === state.flowSelected ? 'selected' : ''}" data-node="${esc(n.id)}"
                 data-act="select-node" data-id="${esc(n.id)}" aria-pressed="${n.id === state.flowSelected}"
                 style="left:${n.x ?? 40}px;top:${n.y ?? 80}px">
              <span class="fn-name">${esc(n.name || '未命名阶段')}</span>
              <span class="fn-meta">
                <span class="badge ${n.gate === 'human' ? 'warn' : n.gate === 'agent' ? 'ok' : 'mute'}">${gateLabel(n.gate)}</span>
                ${(n.outputs || []).map((o) => `<span class="badge mute">${esc(artifactLabel(o))}</span>`).join('')}
                ${n.maxLoop ? `<span class="badge err">打回≤${n.maxLoop}</span>` : ''}
              </span>
              <span class="fn-owner">${esc(n.owner ? '负责人：' + n.owner : '负责人：由 Planner 分配')}</span>
            </button>`).join('')}
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

const DEFAULT_MAX_LOOP = 2;

/** 任务绑定的流程阶段（没有绑定或阶段已删除时为 null）。 */
function taskPhase(task) {
  const nodes = Array.isArray(state.room?.flow?.nodes) ? state.room.flow.nodes : [];
  return nodes.find((node) => node && node.type === 'phase' && node.id === task?.phase_id) || null;
}

/** 与服务端一致：没绑阶段的任务按「评审通过」处理，上限默认 2 次。 */
function taskGate(task) {
  const phase = taskPhase(task);
  const gate = phase && ['auto', 'agent', 'human'].includes(phase.gate) ? phase.gate : 'agent';
  const maxLoop = phase && Number.isInteger(phase.maxLoop) && phase.maxLoop >= 1 ? phase.maxLoop : DEFAULT_MAX_LOOP;
  return { gate, maxLoop, phase };
}

const GATE_HINT = {
  auto: '自动通过：这次有产出就算通过，不用评审，可以直接合并。',
  agent: '评审通过：由评审者检查改动后给出结论，不通过会打回给执行者。',
  human: '人工确认：等你看完改动后点「通过」，再决定是否合并。',
};

function artifactLabel(key) {
  return ARTIFACT_TYPES.find((a) => a.key === key)?.label || key;
}

/** 画布上的「打回≤N」徽标跟着 maxLoop 走，改完不用整页重渲染。 */
function syncFlowLoopBadge(n) {
  const meta = $(`.fnode[data-node="${CSS.escape(n.id)}"] .fn-meta`);
  if (!meta) return;
  const existing = meta.querySelector('.badge.err');
  if (!(Number(n.maxLoop) >= 1)) { existing?.remove(); return; }
  const badge = existing || meta.appendChild(Object.assign(document.createElement('span'), { className: 'badge err' }));
  badge.textContent = `打回≤${n.maxLoop}`;
}

function flowSide(n) {
  const flow = editableFlow();
  const busy = flowReadOnly();
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
      <div class="field"><label for="flow-name">阶段名称</label><input class="input" id="flow-name" name="flow-name" autocomplete="off" data-field="name" value="${esc(n.name)}" ${dis}></div>
      <div class="field"><label for="flow-owner">谁来做（建议负责人）</label>
        <select class="select" id="flow-owner" name="flow-owner" data-field="owner" ${dis}>${ownerOptions}</select>
        <div class="hint">留空也没关系：生成计划时 Planner 会按成员角色分配。</div>
      </div>
      <div class="field"><label for="flow-gate">怎么算完成</label>
        <select class="select" id="flow-gate" name="flow-gate" data-field="gate" ${dis}>
          <option value="human" ${n.gate === 'human' ? 'selected' : ''}>人工确认 —— 你点通过</option>
          <option value="agent" ${n.gate === 'agent' ? 'selected' : ''}>评审通过 —— 评审者看过 diff</option>
          <option value="auto" ${n.gate === 'auto' ? 'selected' : ''}>自动通过 —— 有产出即可</option>
        </select>
        <div class="hint">只有计划里明确选了这个阶段的任务才按它执行；没选阶段的任务仍按「评审通过」。</div>
      </div>
    </div>
    <div class="fs-section">
      <h4>下一步</h4>
      <div class="field"><label>通过后流向（可多选）</label>
        <div class="check-list">${others.length ? others.map((o) => `<label class="check-row"><input type="checkbox" data-next="${esc(o.id)}" ${passed.has(o.id) ? 'checked' : ''} ${dis}><span>${esc(o.name)}</span></label>`).join('') : '<div class="small muted">没有其他阶段</div>'}</div>
        <div class="hint">不勾选 = 这是最后一个阶段。</div>
      </div>
      <div class="field"><label for="flow-reject">被打回时回到</label>
        <select class="select" id="flow-reject" name="flow-reject" data-field="reject" ${dis}>
          <option value="">不回退</option>
          ${others.map((o) => `<option value="${esc(o.id)}" ${rejected === o.id ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}
        </select>
        <div class="hint">设了回退会占用「最多打回几次」的额度，没设过时自动填 2 次。</div>
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
      <div class="field"><label for="flow-max-loop">最多打回几次</label>
        <input class="input" id="flow-max-loop" name="flow-max-loop" type="number" inputmode="numeric" min="0" max="9" data-field="maxLoop" value="${n.maxLoop || 0}" ${dis}>
        <div class="hint">0 = 不允许回边；设了打回目标至少填 1，默认 2 次。达到这个次数仍不通过，任务会升级到总览的收件箱。</div>
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
    if (drag.roomId !== state.roomId || flowReadOnly()) { onUp(); return; }
    const n = editableFlow().nodes.find((x) => x.id === drag.id);
    if (!n) return;
    n.x = Math.max(0, drag.x + (e.clientX - drag.sx));
    n.y = Math.max(0, drag.y + (e.clientY - drag.sy));
    drag.el.style.left = n.x + 'px';
    drag.el.style.top = n.y + 'px';
    drawEdges();
  };
  const onUp = () => {
    if (drag?.roomId === state.roomId) rememberFlowEdit();
    drag = null;
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  };
  inner.addEventListener('mousedown', (e) => {
    if (flowReadOnly()) return;
    const el = e.target.closest('.fnode');
    if (!el) return;
    const n = editableFlow().nodes.find((x) => x.id === el.dataset.node);
    if (!n) return;
    drag = { roomId: state.roomId, id: n.id, el, sx: e.clientX, sy: e.clientY, x: n.x ?? 40, y: n.y ?? 80 };
    e.preventDefault();
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  const applyField = (el) => {
    if (flowReadOnly()) return;
    const n = editableFlow().nodes.find((x) => x.id === state.flowSelected);
    if (!n) return;
    const f = el.dataset.field;
    const flow = editableFlow();
    if (!Array.isArray(flow.edges)) flow.edges = [];

    if (f === 'maxLoop') { n.maxLoop = Number(el.value) || 0; syncFlowLoopBadge(n); }
    else if (f === 'reject') {
      flow.edges = flow.edges.filter((e) => !(e.from === n.id && e.condition === 'rejected'));
      if (el.value && el.value !== n.id) {
        flow.edges.push({ from: n.id, to: el.value, condition: 'rejected' });
        // 回边必须带上限，否则服务端会拒绝保存；没设过时按模板默认填 2 次
        if (!(Number(n.maxLoop) >= 1)) {
          n.maxLoop = 2;
          const loopInput = $('#flow-max-loop');
          if (loopInput) loopInput.value = '2';
          syncFlowLoopBadge(n);
        }
      }
      drawEdges();
    } else {
      n[f] = el.value;
      if (f === 'name') {
        const nameEl = $(`.fnode[data-node="${CSS.escape(n.id)}"] .fn-name`);
        if (nameEl) nameEl.textContent = n.name || '未命名阶段';
      }
    }
    rememberFlowEdit();
  };

  $$('.flow-side [data-field]').forEach((el) => {
    el.addEventListener('input', () => applyField(el));
    el.addEventListener('change', () => applyField(el));
  });

  // 下一步用复选框，不用 Ctrl/⌘ 多选：鼠标点一下就能改。
  $$('.flow-side [data-next]').forEach((el) => {
    el.addEventListener('change', () => {
      if (flowReadOnly()) return;
      const n = editableFlow().nodes.find((x) => x.id === state.flowSelected);
      if (!n) return;
      const flow = editableFlow();
      if (!Array.isArray(flow.edges)) flow.edges = [];
      const targets = $$('.flow-side [data-next]:checked')
        .map((x) => x.dataset.next)
        .filter((v) => v && v !== n.id);
      flow.edges = flow.edges.filter((e) => !(e.from === n.id && e.condition !== 'rejected'));
      for (const to of targets) flow.edges.push({ from: n.id, to, condition: 'passed' });
      rememberFlowEdit();
      drawEdges();
    });
  });

  // 产物是可选标签，勾选即可；重绘一次让节点上的 badge 同步。
  $$('.flow-side [data-artifact]').forEach((el) => {
    el.addEventListener('change', () => {
      if (flowReadOnly()) return;
      const n = editableFlow().nodes.find((x) => x.id === state.flowSelected);
      if (!n) return;
      n.outputs = $$('.flow-side [data-artifact]:checked').map((x) => x.dataset.artifact);
      rememberFlowEdit();
      renderMain(true);
    });
  });
}

function drawEdges() {
  const svg = $('#flow-svg');
  if (!svg) return;
  const flow = editableFlow();
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

let drawerRequest;
let logFrame = null;
function cancelLogFrame() {
  if (logFrame !== null) cancelAnimationFrame(logFrame);
  logFrame = null;
}

function openTask(id, tab = 'overview', invoker = null) {
  drawerRequest?.abort();
  cancelLogFrame();
  state.drawerInvokerTaskId = id;
  state.drawerInvoker = invoker ? { element: invoker, data: { ...invoker.dataset }, card: invoker.classList.contains('card') } : null;
  state.selectedTaskId = id;
  state.drawerTab = 'overview';
  state.log = '';
  state.logMeta = null;
  state.logTruncated = false;
  state.logFollow = true;
  state.inputMeta = null;
  state.inputRunId = null;
  state.inputFocus = false;
  state.diff = '';
  state.resultSha = '';
  state.drawerNotice = '';
  setDrawerTab(tab);
}

function closeDrawer(returnFocus = true) {
  drawerRequest?.abort();
  cancelLogFrame();
  $('#drawer-root dialog[open]')?.close();
  state.selectedTaskId = null;
  state.inputFocus = false;
  state.drawerSig = '';
  $('#drawer-root').replaceChildren();
  const taskId = state.drawerInvokerTaskId;
  const invoker = state.drawerInvoker;
  state.drawerInvokerTaskId = null;
  state.drawerInvoker = null;
  if (returnFocus && taskId) {
    const main = $('#main');
    const replacement = invoker && $$('button[data-act]', main).find((button) =>
      button.classList.contains('card') === invoker.card &&
      Object.entries(invoker.data).every(([key, value]) => button.dataset[key] === value));
    const target = invoker?.element.isConnected ? invoker.element : replacement ||
      $$('.card[data-act="open-task"]', main).find((button) => button.dataset.id === taskId);
    target?.focus({ preventScroll: true });
  }
}

/** 执行依据按选中的运行读取；没选时交给后端取最新一次。 */
function taskPromptPath(taskId) {
  return `/api/tasks/${taskId}/prompt${state.inputRunId ? `?runId=${encodeURIComponent(state.inputRunId)}` : ''}`;
}

async function setDrawerTab(tab) {
  const taskId = state.selectedTaskId;
  if (!taskId) return;
  drawerRequest?.abort();
  cancelLogFrame();
  if (tab === 'log' && state.drawerTab !== 'log') state.logFollow = true;
  if (tab !== 'input') state.inputFocus = false;
  state.drawerTab = tab;
  state.drawerLoad = tab === 'log' || tab === 'diff' || tab === 'input' ? 'loading' : '';
  state.drawerError = '';
  if (tab === 'diff') state.resultSha = '';
  renderDrawer(true);
  if (!state.drawerLoad) return;
  const request = new AbortController();
  drawerRequest = request;
  try {
    const result = await api(tab === 'input' ? taskPromptPath(taskId) : `/api/tasks/${taskId}/${tab}`, { signal: request.signal });
    if (request.signal.aborted) return;
    if (tab === 'input') {
      state.inputMeta = result;
    } else if (tab === 'log') {
      const recent = limitLog(result.log);
      state.log = recent.text;
      state.logMeta = result;
      state.logTruncated = Boolean(result.truncated || recent.truncated);
    } else {
      state.diff = result.diff || '';
      state.resultSha = result.resultSha || '';
    }
    state.drawerLoad = 'loaded';
  } catch (e) {
    if (request.signal.aborted) return;
    state.drawerLoad = 'error';
    state.drawerError = e.message;
    // 选中的运行记录已经不存在时回到最新一次，否则重试只会一直失败
    if (tab === 'input' && e.statusCode === 404) state.inputRunId = null;
  }
  renderDrawer(true);
}
function logEmptyText(meta) {
  if (meta?.readError) return '日志暂时无法读取，请重试。';
  if (meta?.status === 'running') return '任务已启动，等待第一条输出…';
  if (meta?.runId) return '这次运行没有留下日志。';
  return '任务还未开始，执行后会在这里显示日志。';
}

function inputRunLabel(run, index, total) {
  return [`第 ${total - index} 次`, STATUS[run.status] || run.status || '已结束', fmtTime(run.startedAt)]
    .filter(Boolean).join(' · ');
}

/** 快照里连线的条件文案。 */
const FLOW_EDGE_LABELS = { passed: '通过', rejected: '打回', timeout: '超时', always: '总是' };

function flowEdgeLabel(condition) {
  if (Object.hasOwn(FLOW_EDGE_LABELS, condition)) return FLOW_EDGE_LABELS[condition];
  return typeof condition === 'string' ? condition : '';
}

/** 快照里的阶段名：优先 name，缺失时退回 id。 */
function flowSnapshotName(node) {
  return typeof node?.name === 'string' && node.name.trim() ? node.name : (node?.id ?? '');
}

/** 只读地列出这次运行启动时保存的流程：阶段顺序、完成条件、负责人、产出和连线。 */
function flowSnapshotBody(flow) {
  if (!flow || typeof flow !== 'object' || Array.isArray(flow)) {
    return '<p class="small muted">这次运行没有留下流程快照（旧运行）。</p>';
  }
  const nodes = (Array.isArray(flow.nodes) ? flow.nodes : [])
    .filter((node) => node && typeof node === 'object' && !Array.isArray(node));
  if (!nodes.length) return '<p class="small muted">这张流程没有阶段。</p>';
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const phases = nodes.map((node, index) => {
    const parts = [`${index + 1}. ${esc(flowSnapshotName(node))}`, esc(gateLabel(node.gate))];
    parts.push(`负责人：${esc(node.owner ? node.owner : '由 Planner 分配')}`);
    const outputs = (Array.isArray(node.outputs) ? node.outputs : []).filter((key) => typeof key === 'string');
    if (outputs.length) parts.push(`产出：${outputs.map((key) => esc(artifactLabel(key))).join('、')}`);
    if (Number(node.maxLoop) >= 1) parts.push(`打回≤${esc(node.maxLoop)}`);
    return `<li>${parts.join(' · ')}</li>`;
  }).join('');
  const edges = (Array.isArray(flow.edges) ? flow.edges : [])
    .filter((edge) => edge && typeof edge === 'object' && !Array.isArray(edge))
    .map((edge) => {
      const from = flowSnapshotName(byId.get(edge.from) || { id: edge.from });
      const to = flowSnapshotName(byId.get(edge.to) || { id: edge.to });
      const condition = flowEdgeLabel(edge.condition);
      return `<li>${esc(from)} → ${esc(to)}${condition ? `（${esc(condition)}）` : ''}</li>`;
    }).join('');
  return `<ol class="flow-snapshot-list flow-snapshot-phases">${phases}</ol>${edges ? `<ul class="flow-snapshot-list flow-snapshot-links small muted">${edges}</ul>` : ''}`;
}

/** 只读的流程快照区块：每次运行各存一份，改房间流程不会改写历史。 */
function renderFlowSnapshot(meta) {
  return `<section class="section flow-snapshot" aria-label="这次运行用的流程快照">
    <h4>流程快照</h4>
    <p class="input-note">这是这次运行启动时保存的流程，之后改流程不会改变它。</p>
    ${flowSnapshotBody(meta.flow)}
  </section>`;
}

/** 只读的「执行依据」：显示运行当时保存的输入原文和流程，不用当前设置重建。 */
function renderTaskInput() {
  const meta = state.inputMeta;
  if (!meta) return '<div class="center" role="status">正在加载…</div>';
  const runs = Array.isArray(meta.runs) ? meta.runs : [];
  const selected = state.inputRunId || meta.runId || '';
  const picker = runs.length
    ? `<select class="select input-run-select" id="input-run-select" aria-label="选择运行记录">${runs.map((run, index) =>
      `<option value="${esc(run.runId)}"${run.runId === selected ? ' selected' : ''}>${esc(inputRunLabel(run, index, runs.length))}</option>`).join('')}</select>`
    : '';
  const head = `<section class="section input-section" aria-label="执行依据">
    <div class="input-toolbar"><h3>执行依据</h3>${picker}<button class="btn sm" data-act="reload-drawer">刷新</button></div>
    <p class="input-note">这里显示的是每次执行时保存的输入原文和当时的流程，不会按当前设置重新生成。</p>
    ${meta.runsTruncated ? '<p class="input-notice">只列出最近 50 次运行，更早的运行不在这里。</p>' : ''}`;
  if (!runs.length) {
    return `${head}<div class="center">任务还没有运行过，执行后会在这里留下当时使用的输入。</div></section>`;
  }
  const metaParts = [`本次运行：${STATUS[meta.status] || meta.status || '已结束'}`];
  if (meta.startedAt) metaParts.push(`开始于 ${fmtTime(meta.startedAt)}`);
  if (meta.exitCode != null) metaParts.push(`退出码 ${esc(meta.exitCode)}`);
  let detail;
  if (meta.readError) {
    detail = `<p class="form-error" role="alert">${esc(meta.readError)}</p>
      <button class="btn sm" data-act="reload-drawer">重新读取</button>`;
  } else if (!meta.available) {
    detail = '<div class="center">这次运行没有留下可读取的输入记录。</div>';
  } else {
    const shown = Math.min(meta.totalBytes || 0, new TextEncoder().encode(meta.prompt || '').length);
    detail = `${meta.truncated ? `<p class="input-notice">输入文件共 ${fmtBytes(meta.totalBytes)} 字节，这里只显示开头的 ${fmtBytes(shown)} 字节。</p>` : ''}
      <div class="input-box" tabindex="0" aria-label="当时保存的执行输入">${esc(meta.prompt)}</div>`;
  }
  return `${head}<p class="input-meta">${metaParts.join('，')}</p>${detail}</section>${renderFlowSnapshot(meta)}`;
}

function syncLogControls() {
  const button = $('[data-act="follow-log"]');
  if (button) {
    button.setAttribute('aria-pressed', String(state.logFollow));
    button.textContent = state.logFollow ? '跟随最新' : '回到最新';
  }
  const notice = $('#log-tail-note');
  if (notice) notice.hidden = !state.logTruncated;
}

function renderFailureSummary(task) {
  if (!['failed', 'cancelled', 'changes_requested', 'escalated'].includes(task.status)) return '';
  const gate = taskGate(task);
  const rejectCount = Number(task.reject_count) || 0;
  const info = {
    failed: ['任务未完成', '先查看执行结果和日志，处理原因后可以重新运行。'],
    cancelled: ['运行已取消', '已有文件仍保留在任务工作区，需要时可以重新运行。'],
    changes_requested: ['需要修改', '检查意见已保留，重新运行时会自动带给执行者。'],
    escalated: ['需要你决定', `已经打回 ${rejectCount} 次，达到本阶段上限（${gate.maxLoop} 次）。可以按意见重跑、人工通过，或取消任务。`],
  }[task.status];
  return `<section class="task-recovery" aria-label="任务处理建议">
    <h3>${info[0]}</h3><p>${info[1]}</p>
    ${task.status === 'failed' && task.summary ? `<p class="prose">${esc(task.summary)}</p>` : ''}
    ${['failed', 'cancelled'].includes(task.status) ? '<button class="btn sm" data-act="drawer-tab" data-tab="log">查看执行日志</button>' : '<button class="btn sm" data-act="drawer-tab" data-tab="review">查看检查意见</button>'}
  </section>`;
}

function renderDrawer(force = false) {
  const t = state.tasks.find((x) => x.id === state.selectedTaskId);
  const root = $('#drawer-root');
  if (!t) { closeDrawer(); return; }
  const sig = drawerSignature(t);
  if (!force && sig === state.drawerSig) return;
  state.drawerSig = sig;
  const reviews = state.reviews.filter((r) => r.task_id === t.id);
  const gate = taskGate(t);
  const rejectCount = Number(t.reject_count) || 0;
  const viewingResult = state.drawerTab === 'diff' && state.drawerLoad === 'loaded' && state.resultSha &&
    (!t.result_sha || t.result_sha === state.resultSha);
  const pending = state.taskAction.get(t.id);
  let body = '';
  if (state.drawerLoad === 'loading') {
    body = '<div class="center" role="status">正在加载…</div>';
  } else if (state.drawerLoad === 'error') {
    body = `<div class="center"><p>${esc(state.drawerError)}</p><button class="btn sm" data-act="reload-drawer">重新加载</button></div>`;
  } else if (state.drawerTab === 'overview') {
    body = `${renderFailureSummary(t)}
      <div class="section"><h4>任务说明</h4><div class="prose">${esc(t.spec || '（无）')}</div></div>
      <div class="section"><h4>验收标准</h4><div class="prose">${(t.acceptance || []).map((a) => '· ' + esc(a)).join('\n') || '（无）'}</div></div>
      <div class="section"><h4>完成条件</h4><div class="prose">${GATE_HINT[gate.gate]}</div>
        <p class="small muted">${gate.phase
          ? `阶段：${esc(gate.phase.name || gate.phase.id)} · 最多打回 ${gate.maxLoop} 次${rejectCount ? `，已打回 ${rejectCount} 次` : ''}`
          : `没有绑定流程阶段，按「评审通过」处理，最多打回 ${gate.maxLoop} 次${rejectCount ? `，已打回 ${rejectCount} 次` : ''}`}</p>
      </div>
      ${t.feedback ? `<div class="section"><h4>评审意见</h4><div class="prose" style="color:var(--amber)">${esc(t.feedback)}</div></div>` : ''}
      ${t.status === 'escalated' ? `<div class="section"><h4>已到打回上限</h4><div class="prose" style="color:var(--red)">这个任务已经打回 ${rejectCount} 次，达到本阶段上限（${gate.maxLoop} 次），系统不会继续自动检查。请按意见重跑、人工通过，或取消任务。</div></div>` : ''}
      ${t.status !== 'failed' ? `<div class="section"><h4>执行摘要</h4><div class="prose">${esc(t.summary || '（还没有运行）')}</div></div>` : ''}
      <div class="section"><h4>元信息</h4><dl class="kv">
        <dt>负责人</dt><dd>${esc(memberName(t.owner_id))}</dd>
        <dt>分支</dt><dd class="mono" style="font-family:var(--mono);font-size:11.5px">${esc(t.branch || '—')}</dd>
        <dt>工作区</dt><dd style="font-family:var(--mono);font-size:11px">${esc(t.worktree || '—')}</dd>
        <dt>改动统计</dt><dd style="font-family:var(--mono);font-size:11px;white-space:pre-wrap">${esc(t.diff_stat || '—')}</dd>
      </dl></div>`;
  } else if (state.drawerTab === 'input') {
    body = renderTaskInput();
  } else if (state.drawerTab === 'log') {
    const meta = state.logMeta;
    const finished = ['review', 'approved', 'merged', 'done', 'changes_requested', 'escalated'].includes(t.status);
    const status = meta?.status === 'running' && t.status !== 'running' ? (finished ? 'completed' : t.status) : meta?.status;
    body = `<section class="section log-section" aria-label="执行日志">
      <div class="log-toolbar"><h3>执行日志</h3>
        <button class="btn sm" data-act="reload-log">刷新日志</button>
        <button class="btn sm" data-act="follow-log" aria-pressed="${state.logFollow}">${state.logFollow ? '跟随最新' : '回到最新'}</button>
      </div>
      ${meta?.runId ? `<p class="log-meta">本次运行：${esc(STATUS[status] || status || '已结束')}${meta.startedAt ? `，开始于 ${fmtTime(meta.startedAt)}` : ''}${meta.exitCode != null ? `，退出码 ${esc(meta.exitCode)}` : ''}</p>` : ''}
      ${meta?.error ? `<p class="form-error" role="status">${esc(meta.error)}</p>` : ''}
      ${meta?.readError ? `<p class="form-error" role="alert">${esc(meta.readError)}</p>` : ''}
      <p class="log-tail-note" id="log-tail-note" ${state.logTruncated ? '' : 'hidden'}>仅显示最近的日志，较早内容仍保存在本机。</p>
      <div class="log-box" id="log-box" tabindex="0" aria-label="最近执行日志" aria-live="off">${esc(state.log || logEmptyText(meta))}</div>
    </section>`;
  } else if (state.drawerTab === 'diff') {
    body = state.diff
      ? `<div class="diff-box" tabindex="0" aria-label="任务改动">${colorDiff(state.diff)}</div>`
      : `<div class="center">这个任务还没有可查看的改动。</div>`;
  } else {
    body = reviews.length ? reviews.map((rv) => {
      const p = rv.payload || {};
      return `<div class="review">
        <div class="r-head"><span class="badge ${rv.verdict === 'approve' ? 'ok' : 'warn'}">${rv.verdict === 'approve' ? '通过' : '要求修改'}</span>
          <span class="small muted">第 ${rv.round} 轮 · ${fmtTime(rv.created_at)}</span></div>
        <div class="prose" style="margin-top:6px">${esc(p.notes || '')}</div>
        ${(Array.isArray(p.blocking) ? p.blocking.filter(Boolean) : []).map((b) => `<div class="small" style="margin-top:6px;color:var(--red)">· ${esc(b.file || '')}:${esc(b.line || '?')} ${esc(b.issue || '')} → ${esc(b.suggestion || '')}</div>`).join('')}
      </div>`;
    }).join('') : `<div class="center">${gate.gate === 'agent' ? '还没有检查记录。可在「改动」中点「自动检查」。'
      : gate.gate === 'human' ? '人工确认不需要评审记录：看完改动后点「通过」即可。'
        : '自动通过不需要评审记录：有产出就算通过，可以直接合并。'}</div>`;
  }

  const buttons = [];
  const available = !pending ? '' : 'disabled';
  const canReview = gate.gate === 'agent' && rejectCount < gate.maxLoop
    && ['review', 'approved', 'changes_requested'].includes(t.status) && Boolean(t.diff_stat);
  const canApprove = ['review', 'escalated'].includes(t.status) && Boolean(t.result_sha) && Boolean(t.diff_stat);
  const canReject = ['review', 'approved', 'escalated'].includes(t.status);
  const canMerge = ['review', 'approved', 'escalated'].includes(t.status) && Boolean(t.diff_stat);
  if (state.room?.status === 'archived') {
    buttons.push('<span class="small muted">恢复会话后可以继续操作</span>');
  } else {
    const dependencies = waitingFor(t);
    const canRun = ['backlog', 'ready', 'failed', 'cancelled', 'changes_requested', 'escalated'].includes(t.status);
    if (canRun && dependencies.length) {
      buttons.push(`<span class="small muted">等待 ${esc(dependencies.join('、'))} 完成</span>`);
    } else if (canRun && !canMerge) {
      const label = t.status === 'changes_requested' ? '按意见重跑' : ['failed', 'cancelled'].includes(t.status) ? '重新运行' : '运行任务';
      buttons.push(`<button class="btn sm primary" data-act="run-task" ${available}>${pending === 'run' ? '正在启动…' : label}</button>`);
    }
    if (t.status === 'running') {
      buttons.push('<button class="btn sm danger" data-act="cancel-task">取消运行</button>');
    }
    if ((canReview || canApprove || canMerge) && !viewingResult && state.drawerTab !== 'diff') {
      buttons.push('<button class="btn sm primary" data-act="drawer-tab" data-tab="diff">查看改动</button>');
    }
    if ((canReview || canMerge) && state.drawerTab === 'diff' && state.drawerLoad === 'loaded' && state.diff && !viewingResult) {
      buttons.push('<button class="btn sm" data-act="reload-drawer">重新加载改动</button>');
    }
    if (viewingResult && state.diff) {
      // 人工门禁的「通过」是主要动作；评审门禁仍以合并为主要动作，人工通过是覆盖。
      const approvePrimary = gate.gate === 'human' && t.status === 'review';
      if (canApprove) buttons.push(`<button class="btn sm${approvePrimary ? ' primary' : ''}" data-act="approve-task" ${available}>${pending === 'approve' ? '正在确认…' : gate.gate === 'human' ? '通过' : '人工通过'}</button>`);
      if (canReview) buttons.push(`<button class="btn sm" data-act="review-task" ${available}>${pending === 'review' ? '正在检查…' : '自动检查'}</button>`);
      if (canMerge) buttons.push(`<button class="btn sm${approvePrimary ? '' : ' primary'}" data-act="merge-task" ${available}>${pending === 'merge' ? '正在合并…' : '合并到项目'}</button>`);
      if (canReject) buttons.push(`<button class="btn sm" data-act="reject-task" ${available}>退回修改</button>`);
    }
    if (t.status === 'escalated') {
      buttons.push(`<button class="btn sm" data-act="run-task" ${available}>按意见重跑</button>`);
      buttons.push(`<button class="btn sm danger" data-act="cancel-task" ${available}>取消任务</button>`);
    }
  }
  if (t.status === 'merged') buttons.push('<span class="small muted">改动已合并到项目</span>');
  if (t.status === 'done') buttons.push('<span class="small muted">任务已完成，没有文件改动</span>');

  let dialog = root.querySelector('dialog');
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.className = 'drawer';
    dialog.setAttribute('aria-labelledby', 'task-title');
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); closeDrawer(); });
    dialog.addEventListener('change', (event) => {
      if (event.target.id !== 'input-run-select') return;
      const runId = event.target.value;
      if (!runId || runId === (state.inputRunId || state.inputMeta?.runId)) return;
      state.inputRunId = runId;
      state.inputFocus = true;
      setDrawerTab('input');
    });
    root.appendChild(dialog);
  }
  const viewKey = JSON.stringify([t.id, state.drawerTab, state.drawerLoad,
    state.drawerTab === 'input' ? state.inputMeta?.runId : state.drawerTab === 'diff' ? state.resultSha : null]);
  const sameView = dialog.dataset.viewKey === viewKey;
  const readingPositions = sameView ? ['.drawer-body', '.input-box', '.diff-box'].flatMap((selector) => {
    const element = $(selector, dialog);
    return element ? [{ selector, top: element.scrollTop, left: element.scrollLeft }] : [];
  }) : [];
  const inputHadFocus = sameView && document.activeElement === $('.input-box', dialog);
  const diffHadFocus = sameView && document.activeElement === $('.diff-box', dialog);
  dialog.dataset.viewKey = viewKey;
  const focused = dialog.contains(document.activeElement) ? document.activeElement.dataset : null;
  const focusedInput = dialog.contains(document.activeElement) && document.activeElement.id === 'input-run-select';
  const oldLog = $('#log-box', dialog);
  const logPosition = oldLog?.scrollTop || 0;
  const logHadFocus = oldLog && document.activeElement === oldLog;
  dialog.innerHTML = `
      <div class="drawer-head">
        <div class="d-top">
          <span class="badge mute">${esc(t.key)}</span>
          <h2 id="task-title">${esc(t.title)}</h2>
          <button class="btn sm ghost right" data-act="close-drawer" autofocus aria-label="关闭任务详情">✕</button>
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
            <span id="drawer-doing">${esc(runPhase(t.id) || state.activity.get(t.id)?.line || '正在执行…')}</span>
          </div>` : ''}
        <div class="drawer-tabs" role="group" aria-label="任务详情视图">
          ${['overview|概览', 'log|日志', 'input|依据', 'diff|改动', 'review|评审'].map((x) => {
    const [k, n] = x.split('|');
    return `<button type="button" class="tab ${state.drawerTab === k ? 'active' : ''}" data-act="drawer-tab" data-tab="${k}" aria-pressed="${state.drawerTab === k}"${k === 'input' ? ' aria-label="任务执行依据"' : ''}>${n}</button>`;
  }).join('')}
        </div>
      </div>
      <div class="drawer-body">${state.drawerNotice ? `<p class="form-error" role="alert">${esc(state.drawerNotice)}</p>` : ''}${body}</div>
      <div class="drawer-foot">${buttons.join('')}</div>`;
  if (!dialog.open) dialog.showModal();
  else if (focused?.act) {
    $$('button[data-act]', dialog).find((button) =>
      button.dataset.act === focused.act && button.dataset.tab === focused.tab)?.focus({ preventScroll: true });
  } else if (focusedInput || state.inputFocus) {
    const select = $('#input-run-select', dialog);
    if (select) {
      state.inputFocus = false;
      select.focus({ preventScroll: true });
    }
  } else if (inputHadFocus) {
    $('.input-box', dialog)?.focus({ preventScroll: true });
  } else if (diffHadFocus) {
    $('.diff-box', dialog)?.focus({ preventScroll: true });
  }
  for (const position of readingPositions) {
    const element = $(position.selector, dialog);
    if (element) {
      element.scrollTop = position.top;
      element.scrollLeft = position.left;
    }
  }

  if (state.drawerTab === 'log') {
    const box = $('#log-box');
    if (box) {
      box.scrollTop = state.logFollow ? box.scrollHeight : logPosition;
      box.addEventListener('scroll', () => {
        state.logFollow = box.scrollHeight - box.clientHeight - box.scrollTop <= 40;
        syncLogControls();
      }, { passive: true });
      if (logHadFocus) box.focus({ preventScroll: true });
    }
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

function appendLog(line, stream, runId) {
  // The log endpoint is the task run history. Reviewer output has its own activity UI.
  if (state.drawerTab !== 'log' || state.drawerLoad !== 'loaded') return;
  if (state.logMeta?.runId && runId && state.logMeta.runId !== runId) return;
  if (!state.logMeta?.runId) return;
  const recent = appendRecentLog(state.log, line);
  state.log = recent.text;
  state.logTruncated ||= recent.truncated;
  if (logFrame !== null) return;
  const taskId = state.selectedTaskId;
  logFrame = requestAnimationFrame(() => {
    logFrame = null;
    if (state.selectedTaskId !== taskId || state.drawerTab !== 'log') return;
    const box = $('#log-box');
    if (!box) return;
    const previous = box.scrollTop;
    box.textContent = state.log || logEmptyText(state.logMeta);
    box.scrollTop = state.logFollow ? box.scrollHeight : previous;
    syncLogControls();
  });
}

/* ---------------- modals ---------------- */

function closeModal() {
  settingsRequest++;
  state.settingsEditor = null;
  const root = $('#modal-root');
  root.querySelector('dialog[open]')?.close();
  state.repoPicker = null;
  state.planDraft = null;
  state.planRoomId = null;
  state.planSource = null;
  state.planBase = null;
  state.planDraftRecovered = false;
  state.planDraftStale = false;
  root.replaceChildren();
}

function showDialog() {
  const dialog = $('#modal-root dialog');
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeModal();
  });
  dialog.showModal();
}

async function loadRepoPicker(path) {
  const input = $('#nr-repo');
  const previous = state.repoPicker?.loading ? null : state.repoPicker;
  const pending = { loading: true };
  state.repoPicker = pending;
  renderRepoPicker();
  try {
    const result = await api('/api/fs' + (path ? `?path=${encodeURIComponent(path)}` : ''));
    if ($('#nr-repo') !== input || state.repoPicker !== pending) return;
    state.repoPicker = result;
  } catch (e) {
    if ($('#nr-repo') !== input || state.repoPicker !== pending) return;
    state.repoPicker = previous;
    renderRepoPicker();
    throw e;
  }
  renderRepoPicker();
}

let workerCheck;
function refreshWorkers(force = false) {
  if (workerCheck) return workerCheck;
  state.workerStatus = 'checking';
  state.workerError = '';
  syncRoomToolStatus();
  renderRail();
  workerCheck = api('/api/workers' + (force ? '?refresh=1' : ''))
    .then((response) => {
      state.workers = response.workers || [];
      state.workerStatus = 'ready';
      state.workerError = '';
    })
    .catch((error) => {
      state.workerStatus = 'error';
      state.workerError = String(error.message || '').slice(0, 180);
    })
    .finally(() => {
      workerCheck = null;
      const defaultWorker = state.workers.find((w) => w.available)?.key;
      for (const select of $$('#nr-members [data-m="worker"]')) {
        const current = state.workers.find((w) => w.key === select.value && w.available);
        select.innerHTML = workerOptions(current?.key || defaultWorker);
      }
      renderRail();
      syncRoomToolStatus();
    });
  return workerCheck;
}

function syncRoomToolStatus() {
  const status = $('#nr-tool-status');
  if (!status) return;
  const firstWorker = state.workers.find((w) => w.available);
  const checking = state.workerStatus === 'checking';
  status.textContent = checking ? '正在检测电脑上的协作工具…'
    : state.workerStatus === 'error' ? '检测失败，请重新检测。'
      : firstWorker ? `执行工具：${workerLabel($('[data-m="worker"]', $('#nr-members'))?.value || firstWorker.key)}`
        : '没有找到可用工具。确认支持的 CLI 已安装或可执行路径已配置，然后重新检测。';
  $('#nr-check-tools').hidden = Boolean(firstWorker) && state.workerStatus !== 'error';
  $('#nr-check-tools').disabled = checking;
  $('#nr-submit').disabled = checking || !firstWorker || $('#new-room-form').dataset.saving === 'true';
}

function newMemberRow(index) {
  const worker = state.workers.find((w) => w.available)?.key;
  return `<div class="member-row" data-mrow>
    <input class="input" data-m="name" aria-label="成员名" value="${index === 0 ? '协作助手' : `成员 ${index + 1}`}">
    <select class="select" data-m="worker" aria-label="执行工具">${workerOptions(worker)}</select>
    <input class="input" data-m="role_name" aria-label="角色" placeholder="角色（选填）">
    <input class="input" data-m="role_brief" aria-label="分工" placeholder="分工（选填）">
    <input class="input" data-m="concurrency" type="number" min="1" max="10" value="1" aria-label="并发数">
    <button class="rm" type="button" data-act="rm-member" aria-label="移除成员">✕</button>
  </div>`;
}

function suggestTitle(requirement) {
  const first = String(requirement || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '新项目';
  return [...first].slice(0, 36).join('');
}

function recentProjects() {
  const paths = [...new Set(state.rooms.map((room) => room.repo_path).filter(Boolean))].slice(0, 4);
  if (!paths.length) return '';
  return `<div class="recent-projects" role="group" aria-label="最近使用的项目">
    <span>最近使用</span>
    ${paths.map((path) => {
      const folder = path.split(/[\\/]/).filter(Boolean).at(-1) || path;
      return `<button class="btn sm" type="button" data-act="recent-project" data-path="${esc(path)}" title="${esc(path)}">${esc(folder)}</button>`;
    }).join('')}
  </div>`;
}

function selectProject(path) {
  $('#nr-repo').value = path;
  $('#nr-error').hidden = true;
  state.repoPicker = null;
  renderRepoPicker();
  $('#nr-req').focus();
}

function openRoomModal() {
  closeModal();
  const recentProject = state.rooms.find((room) => room.status !== 'archived')?.repo_path || '';
  $('#modal-root').innerHTML = `<dialog class="modal new-room-modal" aria-labelledby="nr-title">
    <form id="new-room-form">
      <div class="modal-head"><h2 id="nr-title">开始一个项目</h2><button class="btn sm ghost x" type="button" data-act="close-modal" aria-label="关闭">✕</button></div>
      <div class="modal-body">
        <div class="field"><label for="nr-repo">项目文件夹</label>
          <div class="repo-field">
            <input class="input" id="nr-repo" value="${esc(recentProject)}" placeholder="选择一个已有的项目" aria-describedby="nr-repo-hint" required>
            <button class="btn sm" type="button" data-act="browse-repo">选择文件夹…</button>
          </div>
          <p class="field-help" id="nr-repo-hint">${recentProject ? '已选择最近使用的项目；要换项目，点「选择文件夹」。' : '选择已有 Git 记录的项目，也可以直接粘贴路径。'}</p>
          ${recentProjects()}
          <div id="repo-picker"></div>
        </div>
        <div class="field"><label for="nr-req">你想做什么？</label>
          <textarea class="textarea" id="nr-req" placeholder="例如：给订单列表加一个按状态筛选的选项" aria-describedby="nr-plan-hint" required autofocus></textarea>
          <p class="field-help" id="nr-plan-hint">DevHub 会整理任务、验收条件和执行顺序。你确认后再开始。</p>
        </div>
        <div class="setup-tool"><p id="nr-tool-status" role="status"></p><button class="btn sm" id="nr-check-tools" type="button" data-act="check-workers">重新检测</button></div>
        <details class="setup-advanced">
          <summary>高级设置</summary>
          <div class="setup-advanced-body">
            <div class="field"><label for="nr-name">会话名（选填）</label><input class="input" id="nr-name" placeholder="默认根据任务描述命名"></div>
            <div class="row">
              <div class="field"><label for="nr-mode">执行方式</label>
                <select class="select" id="nr-mode"><option value="serial">一次一个任务</option><option value="parallel">按依赖并行执行</option></select></div>
              <div class="field"><label for="nr-auto">工具权限</label>
                <select class="select" id="nr-auto"><option value="0">保留工具权限限制</option><option value="1">允许工具自动批准操作</option></select></div>
            </div>
            <div class="field"><label for="nr-flow">流程</label>
              <select class="select" id="nr-flow">
                <option value="tpl:generic">通用协作</option>
                ${state.flowTemplates.filter((t) => t.key !== 'generic').map((t) => `<option value="tpl:${esc(t.key)}">${esc(t.name)}（${esc(t.desc)}）</option>`).join('')}
                ${state.rooms.map((r) => `<option value="room:${esc(r.id)}">复制：${esc(r.name)}</option>`).join('')}
              </select>
              <div class="hint" id="nr-flow-hint"></div>
            </div>
            <div class="field"><label id="nr-members-label">成员与分工</label>
              <div class="member-editor" id="nr-members" role="group" aria-labelledby="nr-members-label">${newMemberRow(0)}</div>
              <button class="btn sm setup-add-member" type="button" data-act="add-member">添加成员</button>
            </div>
            <div class="row">
              <div class="field"><label for="nr-planner">谁做计划</label><select class="select" id="nr-planner"></select></div>
              <div class="field"><label for="nr-reviewer">谁做评审</label><select class="select" id="nr-reviewer"></select></div>
            </div>
          </div>
        </details>
        <p class="form-error" id="nr-error" role="alert" hidden></p>
      </div>
      <div class="modal-foot">
        <button class="btn sm" type="button" data-act="close-modal">取消</button>
        <button class="btn sm primary" id="nr-submit" type="submit">创建并生成计划</button>
      </div>
    </form>
  </dialog>`;
  refreshRoleSelects();
  renderFlowHint();
  syncRoomToolStatus();
  showDialog();
}

async function createRoom(form) {
  if (form.dataset.saving === 'true') return;
  const error = $('#nr-error', form);
  const button = $('#nr-submit', form);
  const repoPath = $('#nr-repo', form).value.trim();
  const requirement = $('#nr-req', form).value.trim();
  error.hidden = true;
  if (!repoPath || !requirement) {
    error.textContent = '请选择项目文件夹，并填写你想做什么。';
    error.hidden = false;
    $(repoPath ? '#nr-req' : '#nr-repo', form).focus();
    return;
  }
  const members = collectMembers();
  if (members.some((member) => !state.workers.some((w) => w.available && w.key === member.worker))) {
    error.textContent = '请为成员选择已检测到的执行工具。';
    error.hidden = false;
    return;
  }
  form.dataset.saving = 'true';
  button.disabled = true;
  button.textContent = '正在创建…';
  const flow = $('#nr-flow', form).value;
  try {
    const { room } = await api('/api/rooms', { method: 'POST', body: {
      name: $('#nr-name', form).value.trim() || suggestTitle(requirement),
      repoPath, requirement,
      mode: $('#nr-mode', form).value,
      autoApprove: $('#nr-auto', form).value === '1',
      flowTemplate: flow.startsWith('tpl:') ? flow.slice(4) : undefined,
      flowFromRoomId: flow.startsWith('room:') ? flow.slice(5) : undefined,
      members,
      plannerName: members[Number($('#nr-planner', form).value)]?.name,
      reviewerName: members[Number($('#nr-reviewer', form).value)]?.name,
    } });
    if (form.isConnected) {
      const opened = openRoom(room.id);
      const navigation = state.roomNavigation;
      await opened;
      if (state.roomNavigation === navigation) await generateRoomPlan(room.id);
    } else {
      await refreshState();
      toast('会话已创建');
    }
  } catch (e) {
    if (!form.isConnected) return toast(e.message, 'err');
    error.textContent = e.message;
    error.hidden = false;
  } finally {
    delete form.dataset.saving;
    button.textContent = '创建并生成计划';
    if (form.isConnected) syncRoomToolStatus();
  }
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
  const roots = (p.roots || []).map((r) => `<button class="chip" type="button" data-act="picker-go" data-path="${esc(r.path)}" title="${esc(r.path)}">${esc(r.name)}</button>`).join('');
  const rows = (p.dirs || []).map((d) => `<button class="picker-row" type="button" data-act="picker-go" data-path="${esc(d.path)}" title="${esc(d.path)}">
      <span class="picker-folder">▸</span>
      <span class="picker-name">${esc(d.name)}</span>
      ${d.repo ? '<span class="badge ok">git</span>' : ''}
    </button>`).join('');
  root.innerHTML = `<div class="picker">
    <div class="picker-head">
      <button class="btn sm" type="button" data-act="picker-up" ${p.parent ? '' : 'disabled'}>↑ 上一级</button>
      <span class="picker-path" title="${esc(p.path)}">${esc(p.path)}</span>
      <button class="btn ghost sm" type="button" data-act="picker-close">收起</button>
    </div>
    <div class="picker-roots">
      ${roots}
      <button class="chip" type="button" data-act="picker-go" data-path="${esc(p.home)}">主目录</button>
    </div>
    <div class="picker-list">${rows || '<div class="picker-empty">这个目录下没有子目录</div>'}</div>
    <div class="picker-foot">
      <span>${p.isRepo ? '<span class="badge ok">git 仓库</span>' : '<span class="badge mute">不是 git 仓库</span>'}</span>
      <span class="small muted">${(p.dirs || []).length} 个子目录${p.truncated ? ' · 仅显示前 400 个' : ''}</span>
      <button class="btn primary sm" type="button" data-act="picker-pick" ${p.isRepo ? '' : 'disabled'}>使用此目录</button>
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
  const key = m.key;
  const fieldId = `sm-${encodeURIComponent(key)}`;
  const worker = state.workers.some((w) => w.key === m.worker)
    ? workerOptions(m.worker)
    : `<option value="${esc(m.worker)}" selected>${esc(m.worker)}（未检测到）</option>${workerOptions('')}`;
  return `<section class="settings-member" data-mrow data-key="${esc(key)}" data-mid="${esc(m.id || '')}" aria-label="成员 ${i + 1}">
    <div class="settings-member-head"><h3>成员 ${i + 1}</h3>
      <button class="btn sm ghost" type="button" data-act="settings-rm-member">移除成员</button></div>
    <div class="row">
      <div class="field"><label for="${fieldId}-name">名字</label><input class="input" id="${fieldId}-name" name="member-name" autocomplete="off" data-m="name" value="${esc(m.name)}" required></div>
      <div class="field"><label for="${fieldId}-worker">执行工具</label><select class="select" id="${fieldId}-worker" name="member-worker" data-m="worker">${worker}</select></div>
    </div>
    <div class="row">
      <div class="field"><label for="${fieldId}-role">角色（选填）</label><input class="input" id="${fieldId}-role" name="member-role" autocomplete="off" data-m="role_name" value="${esc(m.role_name)}"></div>
      <div class="field"><label for="${fieldId}-brief">分工（选填）</label><textarea class="textarea" id="${fieldId}-brief" name="member-brief" autocomplete="off" data-m="role_brief">${esc(m.role_brief)}</textarea></div>
    </div>
    <div class="row">
      <div class="field"><label for="${fieldId}-concurrency">同时执行的任务数</label><input class="input" id="${fieldId}-concurrency" name="member-concurrency" data-m="concurrency" type="number" inputmode="numeric" min="1" max="10" step="1" value="${m.concurrency}"></div>
      <div class="field"><label for="${fieldId}-model">模型（选填）</label><input class="input" id="${fieldId}-model" name="member-model" autocomplete="off" spellcheck="false" data-m="model" value="${esc(m.model)}" placeholder="使用工具默认模型"></div>
    </div>
    <label class="check-row"><input type="checkbox" data-m="enabled" ${m.enabled ? 'checked' : ''}>启用这位成员</label>
  </section>`;
}

async function openRoomSettings() {
  const roomId = state.roomId;
  if (!roomId) return;
  closeModal();
  const request = ++settingsRequest;
  const navigation = state.roomNavigation;
  $('#modal-root').innerHTML = `<dialog class="modal" aria-labelledby="settings-title">
    <div class="modal-head"><h2 id="settings-title">会话设置</h2><button class="btn sm ghost x" data-act="close-modal" aria-label="关闭">✕</button></div>
    <div class="modal-body" id="settings-loading" role="status">正在读取设置…</div>
  </dialog>`;
  showDialog();
  try {
    const response = await api(`/api/rooms/${roomId}/settings`);
    if (request !== settingsRequest || navigation !== state.roomNavigation || !$('#settings-loading')) return;
    let draft = settingsDrafts.get(roomId);
    const validDraft = draft && typeof draft.version === 'string' && draft.base && Array.isArray(draft.settings?.members);
    if (!validDraft || sameValue(draft.settings, draft.base) || response.archived) {
      draft = { roomId, version: response.version, base: cloneDraft(response.settings), settings: cloneDraft(response.settings) };
      if (!response.archived) settingsDrafts.delete(roomId);
    }
    state.settingsEditor = {
      ...draft, roomId, archived: response.archived, saving: false, reloading: false,
      recovered: validDraft && !sameValue(draft.settings, draft.base) && !response.archived,
      conflict: !response.archived && draft.version !== response.version,
      repoPath: state.room?.repo_path || '',
    };
    renderRoomSettings();
  } catch (error) {
    if (request !== settingsRequest || navigation !== state.roomNavigation || !$('#settings-loading')) return;
    $('#settings-loading').innerHTML = `<p class="form-error" role="alert">${esc(error.message)}</p><button class="btn sm" data-act="room-settings">重新读取设置</button>`;
  }
}

function renderRoomSettings() {
  const editor = state.settingsEditor;
  if (!editor) return;
  const s = editor.settings;
  const archived = editor.archived;
  const root = $('#modal-root');
  root.querySelector('dialog[open]')?.close();
  root.innerHTML = `<dialog class="modal settings-modal" aria-labelledby="settings-title">
    <form id="room-settings-form">
      <div class="modal-head"><h2 id="settings-title">会话设置</h2><button class="btn sm ghost x" type="button" data-act="close-modal" aria-label="关闭">✕</button></div>
      <div class="modal-body">
        <p class="field-help">修改会保留为草稿，保存后一起生效。</p>
        <p class="settings-draft-note" id="settings-draft-note" role="status"></p>
        <p class="form-error" id="settings-error" role="alert" hidden></p>
        <fieldset id="settings-fields" class="plain-fieldset" ${archived ? 'disabled' : ''}>
          <div class="field"><label for="rs-name">会话名</label><input class="input" id="rs-name" name="room-name" autocomplete="off" value="${esc(s.name)}" required autofocus></div>
          <div class="field"><label for="rs-req">想完成的事</label><textarea class="textarea" id="rs-req" name="requirement" autocomplete="off">${esc(s.requirement)}</textarea></div>
          <details class="setup-advanced" id="settings-advanced"><summary>成员、执行方式与权限</summary>
            <div class="setup-advanced-body">
              <div class="row">
                <div class="field"><label for="rs-mode">执行方式</label><select class="select" id="rs-mode"><option value="serial" ${s.mode === 'serial' ? 'selected' : ''}>一次一个任务</option><option value="parallel" ${s.mode === 'parallel' ? 'selected' : ''}>按依赖并行执行</option></select></div>
                <div class="field"><label for="rs-auto">工具权限</label><select class="select" id="rs-auto"><option value="0" ${!s.autoApprove ? 'selected' : ''}>保留工具权限限制</option><option value="1" ${s.autoApprove ? 'selected' : ''}>允许工具自动批准操作</option></select></div>
              </div>
              <div id="rs-members">${s.members.map(settingsMemberRow).join('')}</div>
              <button class="btn sm" type="button" data-act="settings-add-member">添加成员</button>
              <div class="row settings-role-selects">
                <div class="field"><label for="rs-planner">谁做计划</label><select class="select" id="rs-planner"></select></div>
                <div class="field"><label for="rs-reviewer">谁做评审</label><select class="select" id="rs-reviewer"></select></div>
              </div>
              <p class="field-help">名下已有任务的成员可以停用；保留该成员可继续追溯历史任务。</p>
            </div>
          </details>
          <details class="setup-advanced"><summary>项目与归档</summary><div class="setup-advanced-body">
            <p class="prose">${esc(editor.repoPath)}</p>
            <p class="field-help">归档会保留任务和日志，恢复后可继续操作。</p>
            <button class="btn sm danger" type="button" data-act="archive-room">归档会话</button>
          </div></details>
        </fieldset>
      </div>
      <div class="modal-foot">
        ${archived ? '<span class="small muted">会话已归档，恢复后才能修改</span><button class="btn sm" type="button" data-act="close-modal">关闭</button><button class="btn sm primary" type="button" data-act="restore-room">恢复会话</button>' : `
          <button class="btn sm ghost" id="settings-discard" type="button" data-act="settings-discard">重新加载已保存设置</button>
          <button class="btn sm" type="button" data-act="close-modal">稍后继续</button>
          <button class="btn sm primary" id="settings-save" type="submit">保存设置</button>`}
      </div>
    </form>
  </dialog>`;
  refreshSettingsRoleSelects();
  syncSettingsStatus();
  showDialog();
}

function refreshSettingsRoleSelects() {
  const editor = state.settingsEditor;
  if (!editor) return;
  const selected = editor.settings;
  const rows = $$('#rs-members [data-mrow]');
  const options = rows.map((row) => {
    const key = row.dataset.key;
    const name = $('[data-m="name"]', row).value.trim() || '未命名成员';
    const enabled = $('[data-m="enabled"]', row).checked;
    return `<option value="${esc(key)}">${esc(name)}${enabled ? '' : '（已停用）'}</option>`;
  }).join('');
  for (const [selector, value] of [['#rs-planner', selected.plannerKey], ['#rs-reviewer', selected.reviewerKey]]) {
    const select = $(selector);
    if (!select) continue;
    select.innerHTML = '<option value="">请选择启用的成员</option>' + options;
    select.value = value;
  }
}

function collectSettingsMembers() {
  return $$('#rs-members [data-mrow]').map((row) => ({
    key: row.dataset.key, id: row.dataset.mid || null,
    name: $('[data-m="name"]', row).value.trim(), worker: $('[data-m="worker"]', row).value,
    role_name: $('[data-m="role_name"]', row).value.trim(), role_brief: $('[data-m="role_brief"]', row).value.trim(),
    model: $('[data-m="model"]', row).value.trim(), concurrency: Number($('[data-m="concurrency"]', row).value),
    enabled: $('[data-m="enabled"]', row).checked,
  }));
}

function syncSettingsStatus() {
  const editor = state.settingsEditor;
  if (!editor || !$('#room-settings-form')) return;
  const dirty = !sameValue(editor.settings, editor.base);
  const note = $('#settings-draft-note');
  note.textContent = editor.reloading ? '正在读取已保存设置…' : editor.archived ? '已归档，当前显示已保存的设置。' : editor.conflict
    ? '设置已在其他地方更新。草稿仍保留，请重新加载已保存设置后再调整。'
    : dirty ? (editor.recovered ? '已恢复未保存的草稿。保存后一起生效。' : '草稿已保留，尚未保存到会话。') : '当前显示已保存的设置。';
  const save = $('#settings-save');
  if (save) save.disabled = editor.saving || editor.reloading || editor.conflict || !dirty;
  const discard = $('#settings-discard');
  if (discard) discard.disabled = editor.saving || editor.reloading;
}

function updateSettingsDraft() {
  const editor = state.settingsEditor;
  if (!editor || editor.archived || editor.saving || editor.reloading || !$('#room-settings-form')) return;
  editor.settings = {
    name: $('#rs-name').value.trim(), requirement: $('#rs-req').value,
    mode: $('#rs-mode').value, autoApprove: $('#rs-auto').value === '1',
    plannerKey: $('#rs-planner').value, reviewerKey: $('#rs-reviewer').value, members: collectSettingsMembers(),
  };
  if (sameValue(editor.settings, editor.base)) settingsDrafts.delete(editor.roomId);
  else settingsDrafts.set(editor.roomId, { version: editor.version, base: editor.base, settings: editor.settings });
  syncSettingsStatus();
}

async function reloadRoomSettings() {
  const editor = state.settingsEditor;
  const form = $('#room-settings-form');
  if (!editor || editor.saving || editor.reloading || !form) return;
  if (!sameValue(editor.settings, editor.base) && !confirm('重新加载会放弃当前草稿，显示已保存的设置。继续？')) return;
  const request = ++settingsRequest;
  const navigation = state.roomNavigation;
  const error = $('#settings-error', form);
  editor.reloading = true;
  error.hidden = true;
  $('#settings-fields', form).disabled = true;
  syncSettingsStatus();
  try {
    const response = await api(`/api/rooms/${editor.roomId}/settings`);
    if (request !== settingsRequest || navigation !== state.roomNavigation || editor !== state.settingsEditor) return;
    settingsDrafts.delete(editor.roomId);
    state.settingsEditor = {
      roomId: editor.roomId, version: response.version, base: cloneDraft(response.settings), settings: cloneDraft(response.settings),
      archived: response.archived, saving: false, reloading: false, recovered: false, conflict: false, repoPath: editor.repoPath,
    };
    renderRoomSettings();
  } catch (failure) {
    if (request === settingsRequest && editor === state.settingsEditor && form.isConnected) {
      error.textContent = failure.message;
      error.hidden = false;
    }
  } finally {
    editor.reloading = false;
    if (editor === state.settingsEditor && form.isConnected) {
      $('#settings-fields', form).disabled = editor.archived;
      syncSettingsStatus();
    }
  }
}

async function saveRoomSettings(form = $('#room-settings-form')) {
  const editor = state.settingsEditor;
  if (!form?.isConnected || !editor || editor.archived || editor.saving || editor.reloading || editor.conflict) return;
  updateSettingsDraft();
  const error = $('#settings-error', form);
  const button = $('#settings-save', form);
  error.hidden = true;
  editor.saving = true;
  $('#settings-fields', form).disabled = true;
  button.disabled = true;
  button.textContent = '正在保存…';
  const sent = cloneDraft(editor.settings);
  try {
    await api(`/api/rooms/${editor.roomId}/settings`, { method: 'PATCH', body: { version: editor.version, settings: sent } });
  } catch (failure) {
    if (failure.statusCode === 409 && /其他地方更新|最新设置/.test(failure.message)) editor.conflict = true;
    if (form.isConnected && editor === state.settingsEditor) {
      error.textContent = failure.message;
      error.hidden = false;
    } else toast(failure.message, 'err');
    return;
  } finally {
    editor.saving = false;
    if (form.isConnected && editor === state.settingsEditor) {
      $('#settings-fields', form).disabled = false;
      button.textContent = '保存设置';
      syncSettingsStatus();
    }
  }
  const cached = settingsDrafts.get(editor.roomId);
  if (cached && sameValue(cached.settings, sent)) settingsDrafts.delete(editor.roomId);
  if (form.isConnected && editor === state.settingsEditor) closeModal();
  toast('会话设置已保存');
  await refreshState().catch(() => toast('设置已保存，状态更新失败，可刷新查看。', 'err'));
}

function openTaskModal() {
  const member = state.members.find((item) => item.enabled) || state.members[0];
  const opts = state.members.filter((item) => item.enabled).map((item) => `<option value="${esc(item.id)}" ${item.id === member?.id ? 'selected' : ''}>${esc(item.name)}</option>`).join('');
  $('#modal-root').innerHTML = `<dialog class="modal" aria-labelledby="task-create-title">
    <form id="task-create-form">
      <div class="modal-head"><h2 id="task-create-title">添加一项任务</h2><button class="btn sm ghost x" type="button" data-act="close-modal" aria-label="关闭">✕</button></div>
      <div class="modal-body">
        <div class="field"><label for="nt-spec">要完成什么？</label><textarea class="textarea" id="nt-spec" placeholder="例如：在订单列表增加按状态筛选的选项" required autofocus></textarea></div>
        <details class="setup-advanced"><summary>调整自动生成的标题、类型或负责人</summary>
          <div class="setup-advanced-body">
            <div class="field"><label for="nt-title">标题</label><input class="input" id="nt-title" placeholder="根据说明自动生成"></div>
            <div class="row">
              <div class="field"><label for="nt-type">任务类型</label><select class="select" id="nt-type"><option value="code">改代码</option><option value="document">写文档</option><option value="research">调研</option></select></div>
              <div class="field"><label for="nt-owner">负责人</label><select class="select" id="nt-owner">${opts}</select></div>
            </div>
          </div>
        </details>
        <p class="form-error" id="nt-error" role="alert" hidden></p>
      </div>
      <div class="modal-foot">
        <button class="btn sm" type="button" data-act="close-modal">取消</button>
        <button class="btn sm primary" type="submit" data-act="create-task">添加任务</button>
      </div>
    </form>
  </dialog>`;
  $('#nt-type').dataset.auto = 'true';
  $('#nt-type').value = suggestTaskType('');
  showDialog();
}
async function createManualTask(form) {
  if (!form.isConnected || form.dataset.saving === 'true') return;
  const message = $('#nt-error', form);
  const spec = $('#nt-spec', form).value.trim();
  const ownerId = $('#nt-owner', form).value;
  message.hidden = true;
  if (!spec) {
    message.textContent = '写一句需要完成的事即可。';
    message.hidden = false;
    $('#nt-spec', form).focus();
    return;
  }
  if (!state.members.some((member) => member.id === ownerId && member.enabled)) {
    message.textContent = '请在设置中启用一位成员，再添加任务。';
    message.hidden = false;
    return;
  }
  const roomId = state.roomId;
  const body = {
    roomId, spec, ownerId,
    title: $('#nt-title', form).value.trim() || suggestTaskTitle(spec),
    type: $('#nt-type', form).value,
    acceptance: [],
  };
  const button = $('[data-act="create-task"]', form);
  form.dataset.saving = 'true';
  button.disabled = true;
  button.textContent = '正在添加…';
  try {
    await api('/api/tasks', { method: 'POST', body });
  } catch (error) {
    if (form.isConnected) {
      message.textContent = error.message;
      message.hidden = false;
    } else toast(error.message, 'err');
    return;
  } finally {
    delete form.dataset.saving;
    if (form.isConnected) {
      button.disabled = false;
      button.textContent = '添加任务';
    }
  }
  if (form.isConnected) closeModal();
  toast('任务已添加');
  // The write has succeeded. A failed refresh must not invite another creation.
  await refreshState().catch(() => toast('任务已添加，状态更新失败，可刷新查看。', 'err'));
}

function isCachedPlanDraft(draft) {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft) ||
      typeof draft.summary !== 'string' || !Array.isArray(draft.decisions) || !draft.decisions.every((item) => typeof item === 'string') ||
      !Array.isArray(draft.risks) || !draft.risks.every((item) => typeof item === 'string') ||
      !Array.isArray(draft.tasks) || !Number.isSafeInteger(draft.nextId) || draft.nextId < 1) return false;
  const ids = new Set();
  for (const task of draft.tasks) {
    if (!task || typeof task !== 'object' || !Number.isSafeInteger(task.id) || task.id < 1 || ids.has(task.id) ||
        typeof task.title !== 'string' || typeof task.spec !== 'string' || typeof task.owner !== 'string' ||
        !['code', 'document', 'research'].includes(task.type) || typeof task.phase !== 'string' ||
        !Array.isArray(task.acceptance) || !task.acceptance.every((item) => typeof item === 'string') ||
        !Array.isArray(task.dependencies) || !task.dependencies.every(Number.isSafeInteger) ||
        typeof task.invalidDependencies !== 'boolean') return false;
    ids.add(task.id);
  }
  const maxId = Math.max(0, ...ids);
  return draft.nextId > maxId && draft.tasks.every((task) =>
    task.dependencies.every((id) => id !== task.id && ids.has(id)));
}

function samePlanDraft(left, right) {
  const comparable = cloneDraft(left);
  comparable.nextId = right.nextId;
  return sameValue(comparable, right);
}

function planDraftStatus() {
  if (!state.planDraft || !state.planBase) return '';
  if (state.planDraftRecovered) return '已恢复未确认的修改；确认前不会执行。';
  if (!samePlanDraft(state.planDraft, state.planBase)) return '修改已暂存；确认前不会执行。';
  if (state.planDraftStale) return '计划已更新，旧草稿已清除。';
  return '';
}

function syncPlanDraftStatus() {
  const note = $('#plan-form .plan-notice');
  if (!note) return;
  note.textContent = planDraftStatus();
  note.hidden = !note.textContent;
}

function rememberPlanEdit() {
  const { planRoomId, planSource, planDraft, planBase } = state;
  if (!planRoomId || !planSource || !planDraft || !planBase) return;
  state.planDraftRecovered = false;
  state.planDraftStale = false;
  if (samePlanDraft(planDraft, planBase)) {
    planDrafts.delete(planRoomId);
    return;
  }
  planDrafts.set(planRoomId, { source: planSource, draft: cloneDraft(planDraft) });
}

function openPlanModal(plan, roomId) {
  closeModal();
  state.planRoomId = roomId;
  state.planSource = JSON.stringify(plan);
  const cached = planDrafts.get(roomId);
  const restored = cached?.source === state.planSource && isCachedPlanDraft(cached.draft);
  state.planDraftRecovered = Boolean(restored);
  state.planDraftStale = Boolean(cached && !restored);
  if (cached && !restored) planDrafts.delete(roomId);
  const owner = state.members.find((member) => member.enabled)?.name || '';
  const baseDraft = createPlanDraft(plan, owner);
  state.planBase = cloneDraft(baseDraft);
  state.planDraft = restored ? cloneDraft(cached.draft) : cloneDraft(baseDraft);
  $('#modal-root').innerHTML = `<dialog class="modal wide plan-modal" aria-labelledby="plan-title">
    <form id="plan-form">
      <div class="modal-head"><h2 id="plan-title">确认计划</h2><button class="btn sm ghost x" type="button" data-act="close-modal" aria-label="关闭">✕</button></div>
      <div class="modal-body" id="plan-body"></div>
      <div class="modal-foot"><button class="btn sm" type="button" data-act="close-modal">稍后确认</button>
        <button class="btn sm primary" id="plan-submit" type="submit">确认并开始执行</button></div>
    </form>
  </dialog>`;
  renderPlanModal();
  showDialog();
}

function renderPlanModal(notice = '') {
  const p = state.planDraft;
  const body = $('#plan-body');
  const scrollTop = body.scrollTop;
  const members = state.members.filter((m) => m.enabled);
  const phases = (state.room.flow?.nodes || []).filter((node) => node?.type === 'phase');
  const owners = (name) => `<option value="" disabled ${members.some((m) => m.name === name) ? '' : 'selected'}>请选择负责人</option>` +
    members.map((m) => `<option value="${esc(m.name)}" ${m.name === name ? 'selected' : ''}>${esc(m.name)}</option>`).join('');
  const status = notice || planDraftStatus();
  body.innerHTML = `<p class="field-help">计划已生成，请检查任务标题、分工和验收条件；按需展开调整执行顺序。</p>
    <div class="plan-summary-row">
      ${p.summary ? `<p class="prose plan-summary">${esc(p.summary)}</p>` : ''}
      <button class="btn sm ghost" type="button" data-act="close-modal">稍后处理</button>
    </div>
    <p class="plan-progress">${p.tasks.length} 项任务 · ${p.tasks.filter((task) => task.dependencies.length).length} 项等待前置任务</p>
    <p class="plan-notice" role="status" ${status ? '' : 'hidden'}>${esc(status)}</p>
    <p class="form-error" id="plan-error" role="alert" hidden></p>
    ${p.tasks.map((t, i) => `<section class="plan-task" data-pt="${t.id}" aria-label="任务 ${i + 1}">
      <div class="pt-head"><span class="pt-key">任务 ${i + 1}</span>
        <input class="input pt-title" data-p="title" value="${esc(t.title)}" aria-label="任务 ${i + 1} 标题" placeholder="任务标题" required>
        <button class="btn sm ghost" type="button" data-act="rm-plan-task" data-id="${t.id}" aria-label="移除任务 ${i + 1}">移除</button>
      </div>
      <textarea class="textarea" data-p="spec" aria-label="任务 ${i + 1} 说明" placeholder="任务说明">${esc(t.spec)}</textarea>
      <details class="plan-details" ${t.invalidDependencies || !members.some((m) => m.name === t.owner) || (t.phase && !phases.some((phase) => phase.name === t.phase)) ? 'open' : ''}>
        <summary>负责人、验收与执行顺序</summary>
        <div class="row">
          <div class="field"><label for="pt-owner-${t.id}">负责人</label><select class="select" id="pt-owner-${t.id}" data-p="owner">${owners(t.owner)}</select></div>
          <div class="field"><label for="pt-type-${t.id}">任务类型</label><select class="select" id="pt-type-${t.id}" data-p="type">
            ${[['code', '改代码'], ['document', '写文档'], ['research', '调研']].map(([key, label]) => `<option value="${key}" ${t.type === key ? 'selected' : ''}>${label}</option>`).join('')}
          </select></div>
        </div>
        ${phases.length || t.phase ? `<div class="field"><label for="pt-phase-${t.id}">所属阶段</label>
          <select class="select" id="pt-phase-${t.id}" data-p="phase">
            <option value="">不指定（按评审通过）</option>
            ${t.phase && !phases.some((phase) => phase.name === t.phase) ? `<option value="${esc(t.phase)}" selected disabled>${esc(t.phase)}（已不在流程中）</option>` : ''}
            ${phases.map((phase) => `<option value="${esc(phase.name)}" ${phase.name === t.phase ? 'selected' : ''}>${esc(phase.name)}</option>`).join('')}
          </select>
          <div class="hint">选了阶段就按该阶段的门禁决定怎么算完成：人工确认、评审通过或有产出即可。</div></div>` : ''}
        <div class="field"><label for="pt-accept-${t.id}">验收条件（自动生成，可修改）</label><textarea class="textarea" id="pt-accept-${t.id}" data-p="acceptance">${esc(t.acceptance.join('\n'))}</textarea></div>
        ${t.invalidDependencies ? `<div class="plan-notice">原计划里有无效的依赖。<button class="btn sm" type="button" data-act="clear-plan-invalid" data-id="${t.id}">移除无效依赖</button></div>` : ''}
        ${p.tasks.length > 1 ? `<fieldset class="plan-deps"><legend>等待这些任务完成后再执行</legend>
          ${p.tasks.map((other, number) => other.id === t.id ? '' : `<label class="check-row"><input type="checkbox" data-dep="${other.id}" ${t.dependencies.includes(other.id) ? 'checked' : ''}><span>${esc(other.title || `任务 ${number + 1}`)}</span></label>`).join('')}
        </fieldset>` : ''}
      </details>
    </section>`).join('')}
    <button class="btn sm" type="button" data-act="plan-add-task">添加任务</button>
    ${p.decisions.length || p.risks.length ? `<details class="setup-advanced"><summary>补充说明</summary>${[...p.decisions, ...p.risks].map((note) => `<p>${esc(note)}</p>`).join('')}</details>` : ''}`;
  body.scrollTop = scrollTop;
  $('#plan-submit').disabled = !p.tasks.length || state.applyingPlan;
}

function updatePlanTask(input) {
  const row = input.closest('[data-pt]');
  const task = state.planDraft?.tasks.find((t) => t.id === Number(row?.dataset.pt));
  if (!task) return;
  if (input.dataset.dep) {
    const id = Number(input.dataset.dep);
    task.dependencies = task.dependencies.filter((dep) => dep !== id);
    if (input.checked) task.dependencies.push(id);
  } else if (input.dataset.p === 'acceptance') {
    task.acceptance = input.value.split('\n').map((line) => line.trim()).filter(Boolean);
  } else if (['title', 'spec', 'owner', 'type', 'phase'].includes(input.dataset.p)) {
    task[input.dataset.p] = input.value;
  } else return;
  rememberPlanEdit();
  syncPlanDraftStatus();
}

async function startRoomExecution(roomId) {
  if (!roomId || state.startingRooms.has(roomId)) return;
  state.startErrors.delete(roomId);
  state.startingRooms.add(roomId);
  renderMain(true);
  try {
    await api(`/api/rooms/${roomId}/start`, { method: 'POST' });
    await refreshState();
  } catch (error) {
    state.startErrors.set(roomId, error.message);
    if (state.roomId === roomId) {
      await refreshState().catch(() => {});
      renderMain(true);
    }
  } finally {
    state.startingRooms.delete(roomId);
    if (state.roomId === roomId) renderMain(true);
  }
}

async function applyPlan(form) {
  const { planDraft, planRoomId } = state;
  if (!planDraft || planRoomId !== state.roomId || state.applyingPlan) return;
  const error = $('#plan-error', form);
  const button = $('#plan-submit', form);
  const enabledNames = new Set(state.members.filter((member) => member.enabled).map((member) => member.name));
  error.hidden = true;
  if (planDraft.tasks.some((task) => !task.title.trim() || !enabledNames.has(task.owner) || task.invalidDependencies)) {
    error.textContent = '请补齐任务标题和负责人，并处理标出的无效依赖。';
    error.hidden = false;
    return;
  }
  if (state.tasks.length && !confirm('应用新计划会替换当前待执行的任务。确认应用？')) return;
  state.applyingPlan = true;
  button.disabled = true;
  button.textContent = '正在确认并开始…';
  try {
    await api(`/api/rooms/${planRoomId}/plan/apply`, { method: 'POST', body: { plan: serializePlan(planDraft) } });
    planDrafts.delete(planRoomId);
    if (form.isConnected) closeModal();
    await refreshState();
    await startRoomExecution(planRoomId);
  } catch (e) {
    if (form.isConnected) {
      error.textContent = e.message;
      error.hidden = false;
      error.scrollIntoView({ block: 'nearest' });
    } else toast(e.message, 'err');
  } finally {
    state.applyingPlan = false;
    button.disabled = false;
    button.textContent = '确认并开始执行';
  }
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

async function performTaskAction(action, resultSha) {
  const taskId = state.selectedTaskId;
  if (!taskId || (action !== 'cancel' && state.taskAction.has(taskId))) return;
  if (action !== 'cancel') state.taskAction.set(taskId, action);
  state.drawerNotice = '';
  renderDrawer(true);
  try {
    await api(`/api/tasks/${taskId}/${action}`, { method: 'POST', body: resultSha ? { resultSha } : undefined });
    await refreshState();
    if (action === 'review' && state.selectedTaskId === taskId) await setDrawerTab('review');
  } catch (error) {
    if (state.selectedTaskId === taskId) state.drawerNotice = error.message;
    else toast(error.message, 'err');
  } finally {
    if (action !== 'cancel') state.taskAction.delete(taskId);
    if (state.selectedTaskId === taskId) renderDrawer(true);
  }
}

async function generateRoomPlan(roomId) {
  if (!roomId || state.room?.id !== roomId || state.generatingPlans.has(roomId)) return;
  const navigation = state.roomNavigation;
  state.generatingPlans.add(roomId);
  state.planErrors.delete(roomId);
  renderMain(true);
  try {
    const { plan } = await api(`/api/rooms/${roomId}/plan`, { method: 'POST' });
    if (!Array.isArray(plan?.tasks)) throw new Error('协作工具没有返回可用的计划。');
    planDrafts.delete(roomId);
    if (state.room?.id === roomId) state.room.plan = plan;
    if (state.roomNavigation === navigation && !state.selectedTaskId && !$('#modal-root').children.length) {
      openPlanModal(plan, roomId);
    }
  } catch (error) {
    state.planErrors.set(roomId, error.message);
    if (state.roomNavigation === navigation && (state.tasks.length || state.room?.plan)) toast(error.message, 'err');
  } finally {
    state.generatingPlans.delete(roomId);
    if (state.roomId === roomId) {
      renderMain(true);
      refreshState().catch(() => {});
    }
  }
}

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
    if (a === 'picker-go') return await loadRepoPicker(el.dataset.path || '');
    if (a === 'picker-up') {
      const p = state.repoPicker;
      if (p && p.parent) await loadRepoPicker(p.parent);
      return;
    }
    if (a === 'recent-project') return selectProject(el.dataset.path);
    if (a === 'picker-pick') {
      const p = state.repoPicker;
      if (!p || p.loading) return;
      return selectProject(p.path);
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
      const editor = state.settingsEditor;
      if (!editor || editor.saving || editor.reloading || editor.archived) return;
      updateSettingsDraft();
      const n = editor.settings.members.length;
      let number = n + 1;
      while (editor.settings.members.some((member) => member.name === `成员 ${number}`)) number++;
      const member = { key: `draft:${Date.now()}:${++newMemberSequence}`, id: null, name: `成员 ${number}`,
        worker: state.workers.find((worker) => worker.available)?.key || editor.settings.members[0]?.worker || '',
        role_name: '', role_brief: '', model: '', concurrency: 1, enabled: true };
      editor.settings.members.push(member);
      $('#rs-members').insertAdjacentHTML('beforeend', settingsMemberRow(member, n));
      refreshSettingsRoleSelects();
      updateSettingsDraft();
      $('#rs-members [data-mrow]:last-child [data-m="name"]').focus();
      return;
    }
    if (a === 'settings-rm-member') {
      const editor = state.settingsEditor;
      if (!editor || editor.saving || editor.reloading || editor.archived) return;
      updateSettingsDraft();
      const row = el.closest('[data-mrow]');
      const member = editor.settings.members.find((item) => item.key === row.dataset.key);
      const error = $('#settings-error');
      if (editor.settings.members.length <= 1 || (member.id && state.tasks.some((task) => task.owner_id === member.id))) {
        error.textContent = editor.settings.members.length <= 1 ? '至少保留一位成员。' : `「${member.name}」名下已有任务，可以停用，保留成员以追溯任务。`;
        error.hidden = false;
        return;
      }
      editor.settings.members = editor.settings.members.filter((item) => item.key !== member.key);
      const fallback = editor.settings.members.find((item) => item.enabled)?.key || '';
      if (editor.settings.plannerKey === member.key) editor.settings.plannerKey = fallback;
      if (editor.settings.reviewerKey === member.key) editor.settings.reviewerKey = fallback;
      row.remove();
      refreshSettingsRoleSelects();
      updateSettingsDraft();
      return;
    }
    if (a === 'settings-discard') return await reloadRoomSettings();
    if (a === 'open-room') { await openRoom(id); return; }
    if (a === 'open-overview') { await openRoom(null); return; }
    if (a === 'open-inbox') return await openInboxItem(el.dataset.inboxId);
    if (a === 'refresh') {
      if (!state.initialLoaded && !state.roomId) {
        state.initialLoadError = '';
        state.initialLoading = true;
        renderMain(true);
        renderRail();
      }
      await refreshState();
      return;
    }
    if (a === 'tab') { state.tab = el.dataset.tab; return renderMain(); }
    if (a === 'select-node') {
      if (state.flowSelected === id) return;
      state.flowSelected = id;
      renderMain();
      $('.flow-side [data-field="name"]')?.focus({ preventScroll: true });
      return;
    }
    if (a === 'drawer-tab') return setDrawerTab(el.dataset.tab);
    if (a === 'reload-drawer') return setDrawerTab(state.drawerTab);
    if (a === 'open-task') return openTask(id, 'overview', el);
    if (a === 'open-result') return openTask(id, 'diff', el);
    if (a === 'plan-room') {
      const roomId = state.roomId;
      await generateRoomPlan(roomId);
      return;
    }
    if (a === 'view-plan') return openPlanModal(state.room.plan, state.roomId);
    if (a === 'rm-plan-task') {
      const taskId = Number(id);
      const affected = state.planDraft.tasks.filter((task) => task.dependencies.includes(taskId)).length;
      removePlanTask(state.planDraft, taskId);
      rememberPlanEdit();
      renderPlanModal(affected ? `已更新 ${affected} 项任务的等待关系。` : '任务已移除。');
      $('[data-act="plan-add-task"]').focus();
      return;
    }
    if (a === 'clear-plan-invalid') {
      state.planDraft.tasks.find((t) => t.id === Number(id)).invalidDependencies = false;
      rememberPlanEdit();
      renderPlanModal('已移除无效依赖。');
      return;
    }
    if (a === 'plan-add-task') {
      const task = addPlanTask(state.planDraft, state.members.find((m) => m.enabled)?.name || '');
      rememberPlanEdit();
      renderPlanModal();
      $(`[data-pt="${task.id}"] [data-p="title"]`).focus();
      return;
    }

    if (a === 'add-task') return openTaskModal();
    if (a === 'stop-all') {
      if (state.stoppingAll || state.stopPending || state.activeWorkers === 0) return;
      state.stoppingAll = true;
      state.stopPending = true;
      renderRail();
      try {
        const result = await api('/api/stop-all', { method: 'POST' });
        const stopped = Number(result.stopped) || 0;
        toast(stopped ? `已请求停止 ${stopped} 项运行。会话已暂停，等待任务和工作区会保留。` : '当前没有运行中的协作工具。');
      } catch (error) {
        state.stopPending = false;
        toast(`停止请求失败：${error.message}`, 'err');
      } finally {
        state.stoppingAll = false;
        await refreshState().catch(() => {});
        renderRail();
      }
      return;
    }
    if (a === 'check-workers') return refreshWorkers(true);
    if (a === 'add-member') {
      $('#nr-members').insertAdjacentHTML('beforeend', newMemberRow($$('#nr-members [data-mrow]').length));
      refreshRoleSelects();
      return;
    }
    if (a === 'rm-member') {
      if ($$('#nr-members [data-mrow]').length <= 1) return toast('请保留至少一个成员');
      el.closest('[data-mrow]').remove();
      refreshRoleSelects();
      syncRoomToolStatus();
      return;
    }

    if (a === 'toggle-run') {
      if (state.room.status === 'running') {
        await api(`/api/rooms/${state.roomId}/pause`, { method: 'POST' });
        await refreshState();
      } else {
        await startRoomExecution(state.roomId);
      }
      return;
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
    if (a === 'run-task') return performTaskAction('run');
    if (a === 'review-task') return performTaskAction('review', state.resultSha);
    if (a === 'approve-task') return performTaskAction('approve');
    if (a === 'merge-task') {
      if (!state.resultSha || !confirm(`确认把当前看到的改动合并到项目的「${state.room.base_branch}」分支？`)) return;
      return performTaskAction('merge', state.resultSha);
    }
    if (a === 'reject-task') {
      const note = prompt('打回原因（会带回给执行者）：', '请按评审意见修改');
      if (note === null) return;
      await api(`/api/tasks/${state.selectedTaskId}/reject`, { method: 'POST', body: { note } });
      await refreshState();
      return;
    }
    if (a === 'cancel-task') { await api(`/api/tasks/${state.selectedTaskId}/cancel`, { method: 'POST' }); return refreshState(); }
    if (a === 'reload-log') return setDrawerTab('log');
    if (a === 'follow-log' || a === 'scroll-log') {
      const box = $('#log-box');
      state.logFollow = true;
      if (box) box.scrollTop = box.scrollHeight;
      syncLogControls();
      return;
    }
    if (a === 'flow-mode') {
      state.flowAdvanced = !state.flowAdvanced;
      try { localStorage.setItem('devhub.flowAdvanced', state.flowAdvanced ? '1' : '0'); } catch {}
      return renderMain();
    }
    if (a === 'flow-add') {
      if (flowReadOnly()) return;
      const f = editableFlow();
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
      rememberFlowEdit();
      return renderMain(true);
    }
    if (a === 'flow-del') {
      if (flowReadOnly()) return;
      if (!confirm('删除这个阶段？和它相连的线也会一起删掉，上下游会自动接上。')) return;
      const f = editableFlow();
      const gone = state.flowSelected;
      const incoming = f.edges.filter((e) => e.to === gone);
      const outgoing = f.edges.filter((e) => e.from === gone && e.condition !== 'rejected');
      f.nodes = f.nodes.filter((n) => n.id !== gone);
      f.edges = f.edges.filter((e) => e.from !== gone && e.to !== gone);
      // 删掉中间阶段后把上下游接起来，避免保存时被「没有连到起始阶段」拒绝
      for (const before of incoming) {
        for (const after of outgoing) {
          if (before.from === after.to) continue;
          if (f.edges.some((e) => e.from === before.from && e.to === after.to && e.condition === before.condition)) continue;
          f.edges.push({ from: before.from, to: after.to, condition: before.condition });
        }
      }
      state.flowSelected = null;
      rememberFlowEdit();
      return renderMain(true);
    }
    if (a === 'flow-save') return await saveFlow();
    if (a === 'flow-reload') return await reloadFlow();
  } catch (e) {
    console.error(e);
    toast(e.message || String(e), 'err');
    setTimeout(() => { try { renderMain(); if (state.selectedTaskId) renderDrawer(); } catch {} }, 30);
  }
}

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  if (el.dataset.act === 'create-task' && el.form?.id === 'task-create-form') return;
  // 弹窗内容区标了 data-stop：点在内容区时，被冒泡命中的外层遮罩（close-modal）不算数
  const stop = e.target.closest('[data-stop]');
  if (stop && !stop.contains(el)) return;
  if (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') return;
  act(el).catch((error) => toast(error.message || String(error), 'err'));
});

document.addEventListener('input', (e) => {
  if (e.target.matches('#nr-members [data-m="name"]')) refreshRoleSelects();
  if (e.target.closest('#room-settings-form')) {
    updateSettingsDraft();
    if (e.target.matches('[data-m="name"], [data-m="enabled"]')) refreshSettingsRoleSelects();
  }
  if (e.target.id === 'nr-flow') renderFlowHint();
  if (e.target.id === 'nt-spec') {
    const title = $('#nt-title');
    const type = $('#nt-type');
    if (title.dataset.auto !== 'false') {
      title.dataset.auto = 'true';
      title.value = suggestTaskTitle(e.target.value);
    }
    if (type.dataset.auto !== 'false') {
      type.dataset.auto = 'true';
      type.value = suggestTaskType(e.target.value);
    }
  }
  if (e.target.id === 'nt-title') e.target.dataset.auto = 'false';
  if (e.target.id === 'nt-type') e.target.dataset.auto = 'false';
  if (e.target.closest('#nr-members')) syncRoomToolStatus();
  if (e.target.closest('#plan-form')) updatePlanTask(e.target);
});

document.addEventListener('submit', (event) => {
  if (event.target.id === 'new-room-form') {
    event.preventDefault();
    createRoom(event.target);
  } else if (event.target.id === 'plan-form') {
    event.preventDefault();
    applyPlan(event.target);
  } else if (event.target.id === 'task-create-form') {
    event.preventDefault();
    createManualTask(event.target);
  } else if (event.target.id === 'room-settings-form') {
    event.preventDefault();
    saveRoomSettings(event.target);
  }
});

boot();
