import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, '..');
export const DATA = join(ROOT, '.data');
export const PROMPTS = join(DATA, 'prompts');
export const LOGS = join(DATA, 'logs');
export const WORKTREES = join(DATA, 'worktrees');
for (const d of [DATA, PROMPTS, LOGS, WORKTREES]) mkdirSync(d, { recursive: true });

const db = new DatabaseSync(join(DATA, 'devhub.db'));
db.exec('PRAGMA journal_mode=WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  requirement TEXT NOT NULL DEFAULT '',
  repo_path TEXT NOT NULL,
  base_branch TEXT NOT NULL DEFAULT '',
  flow_json TEXT NOT NULL DEFAULT '{}',
  plan_json TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',
  mode TEXT NOT NULL DEFAULT 'parallel',
  auto_approve INTEGER NOT NULL DEFAULT 1,
  planner_id TEXT,
  reviewer_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  name TEXT NOT NULL,
  worker TEXT NOT NULL,
  role_name TEXT DEFAULT '',
  role_brief TEXT DEFAULT '',
  model TEXT DEFAULT '',
  concurrency INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  key TEXT NOT NULL,
  title TEXT NOT NULL,
  spec TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'code',
  owner_id TEXT,
  phase_id TEXT,
  status TEXT NOT NULL DEFAULT 'backlog',
  deps_json TEXT NOT NULL DEFAULT '[]',
  acceptance_json TEXT NOT NULL DEFAULT '[]',
  worktree TEXT DEFAULT '',
  branch TEXT DEFAULT '',
  base_sha TEXT DEFAULT '',
  feedback TEXT DEFAULT '',
  summary TEXT DEFAULT '',
  diff_stat TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  status TEXT NOT NULL,
  session_id TEXT DEFAULT '',
  exit_code INTEGER,
  log_path TEXT DEFAULT '',
  error TEXT DEFAULT '',
  started_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT,
  task_id TEXT,
  run_id TEXT,
  type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  text TEXT NOT NULL,
  rationale TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  round INTEGER NOT NULL DEFAULT 1,
  verdict TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_room ON tasks(room_id);
CREATE INDEX IF NOT EXISTS idx_events_room ON events(room_id, id);
`);

export const bus = new EventEmitter();
bus.setMaxListeners(0);

export const now = () => new Date().toISOString();
export const uid = (p) => `${p}_${randomUUID().slice(0, 8)}`;

export function all(sql, params = []) {
  return db.prepare(sql).all(...params);
}
export function get(sql, params = []) {
  return db.prepare(sql).get(...params);
}
export function run(sql, params = []) {
  return db.prepare(sql).run(...params);
}

export function emit(roomId, taskId, runId, type, payload = {}) {
  const evt = {
    id: 0,
    room_id: roomId || null,
    task_id: taskId || null,
    run_id: runId || null,
    type,
    payload,
    created_at: now(),
  };
  const r = run(
    `INSERT INTO events (room_id, task_id, run_id, type, payload, created_at) VALUES (?,?,?,?,?,?)`,
    [evt.room_id, evt.task_id, evt.run_id, evt.type, JSON.stringify(payload), evt.created_at],
  );
  evt.id = Number(r.lastInsertRowid);
  bus.emit('event', evt);
  return evt;
}

export function safeJson(text, fallback) {
  if (!text) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/**
 * 本地运行时环境变量。写在 .data/env.json，不进仓库、不进 UI、不进日志：
 *   { "WORKBUDDY_API_KEY": "...", "HTTPS_PROXY": "..." }
 * 只用于给子进程补齐凭据，DevHub 自己不读取、不展示、不落库。
 */
export function workerEnv() {
  const file = join(DATA, 'env.json');
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    const out = {};
    for (const [k, v] of Object.entries(parsed || {})) {
      if (typeof v === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * 流程起点（starter），不是固定流程：新建会话时选一个，之后整套可改。
 * 故意不写死角色，负责人留空，由用户按需填写。
 */
const FLOW_TEMPLATES = {
  generic: {
    name: '通用协作',
    desc: '不绑定代码：澄清 → 执行 → 评审 → 交付',
    phases: [
      { name: '需求澄清', gate: 'human', outputs: ['brief'] },
      { name: '执行', gate: 'auto', outputs: ['deliverable'] },
      { name: '评审', gate: 'agent', outputs: ['review_report'], maxLoop: 2, rejectTo: 1 },
      { name: '交付', gate: 'human', outputs: [] },
    ],
  },
  code: {
    name: '代码开发',
    desc: '澄清 → 方案 → 实现 → 评审 → 合并',
    phases: [
      { name: '需求澄清', gate: 'human', outputs: ['prd'] },
      { name: '方案设计', gate: 'agent', outputs: ['design'] },
      { name: '实现', gate: 'auto', outputs: ['code_diff'] },
      { name: '评审', gate: 'agent', outputs: ['review_report'], maxLoop: 2, rejectTo: 2 },
      { name: '合并', gate: 'human', outputs: [] },
    ],
  },
  document: {
    name: '文档撰写',
    desc: '澄清 → 收集 → 撰写 → 评审 → 定稿',
    phases: [
      { name: '需求澄清', gate: 'human', outputs: ['outline'] },
      { name: '资料收集', gate: 'auto', outputs: ['sources'] },
      { name: '撰写', gate: 'auto', outputs: ['draft'] },
      { name: '评审', gate: 'agent', outputs: ['review_report'], maxLoop: 2, rejectTo: 2 },
      { name: '定稿', gate: 'human', outputs: [] },
    ],
  },
  research: {
    name: '调研分析',
    desc: '问题定义 → 调研 → 交叉验证 → 结论',
    phases: [
      { name: '问题定义', gate: 'human', outputs: ['question'] },
      { name: '调研', gate: 'auto', outputs: ['findings'] },
      { name: '交叉验证', gate: 'agent', outputs: ['verification'], maxLoop: 2, rejectTo: 1 },
      { name: '结论', gate: 'human', outputs: [] },
    ],
  },
  blank: {
    name: '空白流程',
    desc: '从零开始画，一个阶段都不预置',
    phases: [],
  },
};

function buildFlow(key) {
  const tpl = FLOW_TEMPLATES[key];
  if (!tpl) return null;
  const nodes = tpl.phases.map((p, i) => ({
    id: `n${i + 1}`,
    type: 'phase',
    name: p.name,
    owner: '',
    gate: p.gate,
    outputs: p.outputs,
    x: 40 + i * 230,
    y: 90 + (i % 2 === 0 ? 0 : 40),
    maxLoop: p.maxLoop || 0,
  }));
  const edges = nodes.slice(0, -1).map((n, i) => ({ from: n.id, to: nodes[i + 1].id, condition: 'passed' }));
  for (const [i, p] of tpl.phases.entries()) {
    if (typeof p.rejectTo === 'number' && nodes[p.rejectTo]) {
      edges.push({ from: nodes[i].id, to: nodes[p.rejectTo].id, condition: 'rejected' });
    }
  }
  return { id: `flow-${key}`, name: tpl.name, template: key, nodes, edges };
}

export function flowTemplateList() {
  return Object.entries(FLOW_TEMPLATES).map(([key, t]) => ({
    key, name: t.name, desc: t.desc, phases: t.phases.map((p) => p.name),
  }));
}

export function starterFlow(key) {
  return key ? buildFlow(String(key)) : null;
}

export function defaultFlow() {
  return buildFlow('generic');
}

export function roomPayload(room) {
  if (!room) return null;
  return {
    ...room,
    auto_approve: !!room.auto_approve,
    flow: safeJson(room.flow_json, defaultFlow()),
    plan: safeJson(room.plan_json, null),
  };
}

export function taskPayload(t) {
  return {
    ...t,
    deps: safeJson(t.deps_json, []),
    acceptance: safeJson(t.acceptance_json, []),
  };
}

export function memberPayload(m) {
  return { ...m, enabled: !!m.enabled };
}
