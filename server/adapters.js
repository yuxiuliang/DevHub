import { spawn, execFile } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { PROMPTS, LOGS, uid, workerEnv } from './store.js';
import { knownPaths } from './git.js';

const pexec = promisify(execFile);

const INSTRUCTION = (p) =>
  `Read the task file at ${p} and carry it out exactly. Do not ask questions.`;

export const WORKER_DEFS = {
  claude: {
    label: 'Claude Code',
    bins: ['claude'],
    note: 'stream-json / --resume',
  },
  codex: {
    label: 'Codex',
    bins: ['codex'],
    note: 'exec --json',
  },
  opencode: {
    label: 'OpenCode',
    bins: ['opencode'],
    note: 'run --format json',
  },
  agy: {
    label: 'Antigravity (agy)',
    bins: ['agy'],
    note: 'print / stream-json',
  },
  dsh: {
    label: 'DeepSeek Harness',
    bins: ['dsh'],
    note: 'headless --json',
  },
};

/**
 * 写进 .cmd 文件的参数转义。
 *
 * 不能把整条命令行交给 Node 的 spawn 去拼：Node 会用 \" 转义内层引号，
 * 而 cmd.exe 不认 \"，会在第一个内层引号处把参数截断。
 * 因此这里自己写一个 .cmd 文件，让 cmd 直接解析我们自己控制的引号。
 * 参数里不允许出现引号，其余 cmd 元字符只有在引号外才需要转义。
 */
function cmdQuote(s) {
  const v = String(s).replace(/"/g, '');
  if (v === '') return '""';
  if (!/[\s&|<>^()%!]/.test(v)) return v;
  return '"' + v + '"';
}

function writeLauncher(runId, exe, args) {
  const file = join(PROMPTS, `${runId}.cmd`);
  const line = [exe, ...args.map(cmdQuote)].join(' ');
  // 启动脚本必须保持纯 ASCII：cmd 按控制台 ANSI 代码页读取 .cmd，
  // 中文 prompt 走独立的 UTF-8 prompt 文件，不进命令行。
  writeFileSync(file, `@echo off\r\n${line}\r\n`, 'utf8');
  return file;
}

function stripAnsi(s) {
  return s.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '');
}

async function where(bin) {
  try {
    const cmd = process.platform === 'win32' ? 'where.exe' : 'which';
    const { stdout } = await pexec(cmd, [bin], { windowsHide: true });
    const lines = stdout.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    if (process.platform !== 'win32') return lines[0] || '';
    // where 可能先返回 npm 的无扩展名 shell 脚本，cmd 不能直接执行它
    return lines.find((l) => /\.(exe|cmd|bat)$/i.test(l)) || lines[0] || '';
  } catch {
    return '';
  }
}

const resolvedBins = new Map();

/** 同步取 worker 的可执行路径：优先已探测结果，其次已知绝对路径，最后退回 PATH 名。 */
export function getWorkerPath(key) {
  if (resolvedBins.has(key)) return resolvedBins.get(key);
  const known = knownPaths()[key];
  if (known && existsSync(known)) return known;
  return WORKER_DEFS[key]?.bins[0] || '';
}

export async function detectWorkers() {
  const out = [];
  for (const [key, def] of Object.entries(WORKER_DEFS)) {
    let found = await where(def.bins[0]);
    if (!found) {
      const fallback = knownPaths()[key];
      if (fallback && existsSync(fallback)) found = fallback;
    }
    if (found) resolvedBins.set(key, found);
    out.push({
      key,
      label: def.label,
      note: def.note,
      available: !!found,
      path: found,
    });
  }
  return out;
}

function buildCommand(worker, { instruction, model, autoApprove }) {
  const def = WORKER_DEFS[worker];
  if (!def) throw new Error(`未知 worker: ${worker}`);
  const exe = getWorkerPath(worker) || def.bins[0];
  let args = [];

  if (worker === 'claude') {
    args = ['-p', instruction, '--output-format', 'stream-json', '--verbose'];
    args.push('--permission-mode', autoApprove ? 'bypassPermissions' : 'acceptEdits');
    if (!autoApprove) args.push('--permission-prompts', 'none');
    if (model) args.push('--model', model);
  } else if (worker === 'codex') {
    args = ['exec', '--json', '--skip-git-repo-check'];
    if (autoApprove) args.push('--dangerously-bypass-approvals-and-sandbox');
    else args.push('-s', 'workspace-write');
    if (model) args.push('-m', model);
    args.push(instruction);
  } else if (worker === 'opencode') {
    args = ['run', '--format', 'json'];
    if (autoApprove) args.push('--auto');
    if (model) args.push('--model', model);
    args.push(instruction);
  } else if (worker === 'agy') {
    args = ['-p', instruction, '--output-format', 'stream-json'];
    if (autoApprove) args.push('--dangerously-skip-permissions');
    if (model) args.push('--model', model);
  } else if (worker === 'dsh') {
    args = ['--profile', 'headless', '--json', instruction];
  }

  return { exe, args };
}

/** 把一条事件压成一句“这个 agent 现在在干什么”，给看板和成员条用。 */
function brief(v, n = 100) {
  if (v == null) return '';
  let s;
  if (typeof v === 'string') s = v;
  else if (typeof v === 'object') {
    s = v.command || v.cmd || v.file_path || v.path || v.pattern || v.url || v.description || JSON.stringify(v);
  } else s = String(v);
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function handleClaudeLike(obj, acc) {
  if (obj.session_id) acc.session = obj.session_id;
  if (obj.type === 'system' && obj.subtype === 'init') {
    acc.activity.push('session ' + String(obj.session_id || '').slice(0, 8));
    acc.lastActivity = '会话已建立';
  }
  if (obj.type === 'assistant' && obj.message && Array.isArray(obj.message.content)) {
    for (const c of obj.message.content) {
      if (c.type === 'text' && c.text) {
        acc.text += c.text + '\n';
        acc.lastActivity = brief(c.text);
      } else if (c.type === 'tool_use') {
        acc.activity.push(`tool ${c.name}`);
        acc.lastActivity = `${c.name} ${brief(c.input)}`.trim();
      }
    }
  }
  if (obj.type === 'result') {
    if (typeof obj.result === 'string' && obj.result.trim()) acc.final = obj.result;
    if (obj.usage) acc.usage = obj.usage;
    if (typeof obj.total_cost_usd === 'number') acc.cost = obj.total_cost_usd;
  }
  if (obj.type === 'error') acc.errors.push(obj.message || JSON.stringify(obj).slice(0, 500));
}

function handleCodex(obj, acc) {
  if (obj.type === 'thread.started' && obj.thread_id) acc.session = obj.thread_id;
  if (obj.type === 'item.completed' && obj.item) {
    const it = obj.item;
    if (it.type === 'agent_message' && it.text) {
      acc.text += it.text + '\n';
      acc.lastActivity = brief(it.text);
    } else if (it.type === 'command_execution' && (it.command || it.command_line)) {
      const cmd = String(it.command || it.command_line);
      acc.activity.push('$ ' + cmd.slice(0, 160));
      acc.lastActivity = '$ ' + brief(cmd);
    } else if (it.type === 'file_change') {
      const p = String(it.path || it.file || '');
      acc.activity.push('± ' + p.slice(0, 160));
      acc.lastActivity = '修改 ' + brief(p);
    }
  }
  if (obj.type === 'turn.completed' && obj.usage) acc.usage = obj.usage;
  if (obj.type === 'error') acc.errors.push(String(obj.message || JSON.stringify(obj)).slice(0, 500));
}

function handleTolerant(obj, acc) {
  if (typeof obj !== 'object' || obj === null) return;
  for (const k of ['sessionID', 'session_id', 'thread_id', 'threadId', 'conversationId']) {
    if (typeof obj[k] === 'string' && obj[k]) acc.session = obj[k];
  }
  // opencode: {"type":"tool_use","part":{"tool":"read","state":{"input":{...}}}}
  if (obj.type === 'tool_use' && obj.part && obj.part.tool) {
    const tool = obj.part.tool;
    const input = obj.part.state?.input;
    acc.activity.push('tool ' + tool);
    acc.lastActivity = `${tool} ${brief(input)}`.trim();
    if (obj.part.state?.status === 'error') acc.errors.push(String(obj.part.state.error || `${tool} failed`).slice(0, 500));
    return;
  }
  if (obj.type === 'step_start') { acc.lastActivity = '思考中…'; return; }
  if (obj.type === 'step_finish') {
    if (obj.part?.tokens) acc.usage = obj.part.tokens;
    if (typeof obj.part?.cost === 'number') acc.cost = (acc.cost || 0) + obj.part.cost;
    return;
  }
  const direct = obj.text ?? obj.delta ?? obj.output;
  if (typeof direct === 'string' && direct) {
    acc.text += direct;
    if (obj.type === 'tool') acc.activity.push('tool ' + String(direct).slice(0, 80));
    acc.lastActivity = brief(direct);
  } else if (obj.part && typeof obj.part.text === 'string') {
    acc.text += obj.part.text;
    acc.lastActivity = brief(obj.part.text);
  } else if (obj.message && typeof obj.message === 'string') {
    acc.text += obj.message + '\n';
    acc.lastActivity = brief(obj.message);
  } else if (obj.content && typeof obj.content === 'string') {
    acc.text += obj.content;
    acc.lastActivity = brief(obj.content);
  }
  if (obj.usage) acc.usage = obj.usage;
  if (obj.type === 'error') acc.errors.push(String(obj.message || JSON.stringify(obj)).slice(0, 500));
}

function handleDsh(obj, acc) {
  const t = obj.type;
  if (t === 'session' && obj.sessionId) acc.session = obj.sessionId;
  if (t === 'text' && typeof obj.text === 'string') {
    acc.text += obj.text + '\n';
    acc.lastActivity = brief(obj.text);
  }
  if (t === 'tool_call' && obj.tool) {
    acc.activity.push('tool ' + obj.tool);
    acc.lastActivity = `${obj.tool} ${brief(obj.input)}`.trim();
  }
  if (t === 'final') {
    if (typeof obj.text === 'string' && obj.text.trim()) acc.final = obj.text;
  }
  if (t === 'status' && obj.phase === 'step_start') acc.lastActivity = '思考中…';
  if (t === 'status' && obj.phase === 'step_end' && obj.usage) acc.usage = obj.usage;
  if (t === 'status' && obj.phase === 'turn_end' && obj.reason?.kind === 'error') {
    acc.errors.push(String(obj.reason.error?.message || JSON.stringify(obj.reason)).slice(0, 800));
  }
  if (t === 'error') acc.errors.push(String(obj.message || JSON.stringify(obj)).slice(0, 800));
}

function makeHandler(worker, acc) {
  return (obj) => {
    if (worker === 'claude' || worker === 'agy') handleClaudeLike(obj, acc);
    else if (worker === 'codex') handleCodex(obj, acc);
    else if (worker === 'dsh') handleDsh(obj, acc);
    else handleTolerant(obj, acc);
  };
}

export function runWorker(opts) {
  const {
    worker, model = '', autoApprove = true, cwd,
    prompt, runId, onLine, onEvent, onExit,
  } = opts;

  const promptPath = join(PROMPTS, `${runId}.md`);
  writeFileSync(promptPath, prompt, 'utf8');
  const logPath = join(LOGS, `${runId}.log`);
  writeFileSync(logPath, '', 'utf8');

  const instruction = INSTRUCTION(promptPath);
  const { exe, args } = buildCommand(worker, { instruction, model, autoApprove });
  const launcher = writeLauncher(runId, exe, args);

  const acc = {
    text: '', final: '', session: '', usage: null, cost: null,
    errors: [], activity: [], stderr: '', lastActivity: '',
  };
  const handle = makeHandler(worker, acc);

  const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', launcher], {
    cwd,
    windowsHide: true,
    env: { ...process.env, ...workerEnv(), NO_COLOR: '1', FORCE_COLOR: '0', CI: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const writeLog = (prefix, s) => {
    try { appendFileSync(logPath, prefix + s + '\n', 'utf8'); } catch {}
  };

  const consume = (stream, prefix) => {
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const raw = stripAnsi(buf.slice(0, idx)).trimEnd();
        buf = buf.slice(idx + 1);
        if (!raw) continue;
        writeLog(prefix, raw);
        let obj = null;
        const t = raw.trim();
        if (t.startsWith('{') || t.startsWith('[')) {
          try { obj = JSON.parse(t); } catch {}
        }
        if (obj) {
          handle(obj);
          onEvent && onEvent(obj);
        } else if (prefix === 'err') {
          acc.stderr = (acc.stderr + raw + '\n').slice(-4000);
          acc.lastActivity = brief(raw, 120);
        }
        // activity 放在解析之后，确保给前端的是“最新一步”而不是上一行
        onLine && onLine(raw, prefix, obj, acc.lastActivity);
      }
    });
    stream.on('end', () => {
      const raw = stripAnsi(buf).trim();
      if (!raw) return;
      writeLog(prefix, raw);
      try {
        const obj = JSON.parse(raw);
        handle(obj);
        onLine && onLine(raw, prefix, obj, acc.lastActivity);
      } catch {
        if (prefix === 'err') acc.stderr = (acc.stderr + raw + '\n').slice(-4000);
        onLine && onLine(raw, prefix, null, acc.lastActivity);
      }
    });
  };

  consume(child.stdout, 'out');
  consume(child.stderr, 'err');

  let done = false;
  const finish = (result) => {
    if (done) return;
    done = true;
    const text = (acc.final || acc.text || '').trim();
    onExit && onExit({
      ...result,
      text,
      session: acc.session,
      usage: acc.usage,
      cost: acc.cost,
      errors: acc.errors,
      activity: acc.activity,
      logPath,
      promptPath,
    });
  };

  child.on('error', (e) => finish({ code: -1, error: String(e.message || e) }));
  child.on('close', (code) => {
    const error =
      code === 0
        ? ''
        : (acc.errors[0] || acc.stderr.trim().split(/\r?\n/).filter(Boolean).pop() || '').slice(0, 1200);
    finish({ code, error });
  });
  if (typeof child.pid === 'number') child.__pid = child.pid;

  return { child, logPath, promptPath, acc };
}

export function killTree(pid) {
  if (!pid) return;
  try {
    const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    killer.on('error', () => {});
  } catch {}
}

export { uid };
