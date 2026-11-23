import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const enginePath = fileURLToPath(new URL('../server/engine.js', import.meta.url));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function settle() {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

async function createHarness({ rooms = [{}], members = [{}], tasks = [{}], hooks = {}, stat = ' changed.txt | 1 +' } = {}) {
  let sequence = 0;
  const state = {
    rooms: new Map(rooms.map((room, i) => {
      const value = { id: i ? `r${i + 1}` : 'r', status: 'paused', mode: 'parallel', repo_path: 'repo', base_branch: 'main', auto_approve: 0, ...room };
      return [value.id, value];
    })),
    members: new Map(members.map((member, i) => {
      const value = { id: i ? `m${i + 1}` : 'm', room_id: 'r', name: `成员${i + 1}`, enabled: 1, concurrency: 1, worker: 'mock', ...member };
      return [value.id, value];
    })),
    tasks: new Map(tasks.map((task, i) => {
      const value = { id: `t${i + 1}`, room_id: 'r', owner_id: 'm', key: `T${i + 1}`, title: '任务', status: 'ready', type: 'code', worktree: '', branch: '', base_sha: '', result_sha: '', reject_count: 0, summary: '', diff_stat: '', deps_json: '[]', acceptance_json: '[]', ...task };
      return [value.id, value];
    })),
    runs: new Map(), reviews: [], workers: [], kills: [], events: [], timers: [], worktrees: new Set(),
    prepareCalls: [], commitCalls: [], diffCalls: [], resultCalls: [], mergeCalls: [],
    headSha: 'a'.repeat(40), resultDiff: 'diff --git a/change.txt b/change.txt\n+reviewed\n', tracked: '', stat,
  };
  const clone = (row) => row && { ...row };
  const safeJson = (value, fallback) => { try { return JSON.parse(value); } catch { return fallback; } };
  const taskPayload = (task) => ({ ...task, deps: safeJson(task.deps_json, []), acceptance: safeJson(task.acceptance_json, []) });
  const all = (sql, params = []) => {
    if (sql.includes('FROM rooms')) return [...state.rooms.values()].filter((room) => !sql.includes("status='running'") || room.status === 'running').map(clone);
    if (sql.includes('FROM tasks')) return [...state.tasks.values()].filter((task) => task.room_id === params[0] && (!sql.includes("status='ready'") || task.status === 'ready')).map(clone);
    if (sql.includes('FROM members')) return [...state.members.values()].filter((member) => member.room_id === params[0]).map(clone);
    return [];
  };
  const get = (sql, params = []) => {
    if (sql.includes('FROM reviews')) return { c: state.reviews.filter((review) => review.task_id === params[0]).length };
    if (sql.includes('FROM tasks')) return clone(state.tasks.get(params[0]));
    if (sql.includes('FROM rooms')) return clone(state.rooms.get(params[0]));
    if (sql.includes('FROM members')) return clone(state.members.get(params[0]));
    return undefined;
  };
  const run = (sql, params = []) => {
    const update = sql.match(/^UPDATE (tasks|rooms|runs) SET (.+) WHERE id=\?$/);
    if (update) {
      const row = state[update[1]].get(params[params.length - 1]);
      if (row) update[2].split(',').forEach((assignment, i) => { row[assignment.split('=')[0].trim()] = params[i]; });
      return { changes: row ? 1 : 0 };
    }
    const review = sql.match(/^INSERT INTO reviews \(([^)]+)\)/);
    if (review) {
      state.reviews.push(Object.fromEntries(review[1].split(',').map((column, i) => [column.trim(), params[i]])));
      return { changes: 1 };
    }
    const insert = sql.match(/^INSERT INTO runs \(([^)]+)\)/);
    if (insert) {
      const row = Object.fromEntries(insert[1].split(',').map((column, i) => [column.trim(), params[i]]));
      state.runs.set(row.id, row);
      return { changes: 1 };
    }
    throw new Error(`Unexpected mock SQL: ${sql}`);
  };
  const bus = new EventEmitter();
  const store = {
    all, get, run, transaction: (fn) => fn(), bus,
    emit: (roomId, taskId, runId, type, payload = {}) => {
      const event = { room_id: roomId, task_id: taskId, run_id: runId, type, payload };
      state.events.push(event);
      bus.emit('event', event);
    },
    now: () => new Date(++sequence * 1000).toISOString(), uid: (prefix) => `${prefix}_${++sequence}`,
    safeJson, taskPayload, roomPayload: (room) => room, memberPayload: (member) => member,
    defaultFlow: () => ({ nodes: [] }), starterFlow: () => ({ nodes: [] }), WORKTREES: 'mock-worktrees',
  };
  const git = {
    currentBranch: async () => hooks.currentBranch ? await hooks.currentBranch() : 'main',
    revParse: async (repo, ref) => hooks.revParse ? await hooks.revParse(repo, ref) : 'base',
    commitSha: async (repo, ref) => {
      state.resultCalls.push({ repo, ref });
      if (hooks.resolve) return await hooks.resolve(repo, ref);
      return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(ref) ? ref : state.headSha;
    },
    diffCommit: async (repo, base, sha) => hooks.resultDiff ? await hooks.resultDiff(repo, base, sha) : state.resultDiff,
    trackedStatus: async (repo) => hooks.tracked ? await hooks.tracked(repo) : state.tracked,
    mergeSquash: async (repo, base, sha) => {
      state.mergeCalls.push({ repo, base, sha });
      return await hooks.merge?.(repo, base, sha);
    },
    addWorktree: async (repo, path) => {
      state.prepareCalls.push(path);
      await hooks.prepare?.(path);
      state.worktrees.add(path);
    },
    commitAll: async (path) => {
      state.commitCalls.push(path);
      return hooks.commit ? await hooks.commit(path) : false;
    },
    git: async (path, args) => {
      state.diffCalls.push({ path, args });
      return hooks.diff ? await hooks.diff(path, args) : { stdout: state.stat };
    },
  };
  const adapters = {
    WORKER_DEFS: { mock: {} }, killTree: (pid) => state.kills.push(pid),
    runWorker: (options) => {
      hooks.spawn?.(options);
      const pid = state.workers.length + 1;
      state.workers.push({ pid, options, finish: (result = {}) => options.onExit({ code: 0, text: '已完成', session: '', logPath: 'mock.log', ...result }) });
      return { child: { pid }, logPath: 'mock.log' };
    },
  };
  const context = vm.createContext({
    console,
    setTimeout: (fn) => { const timer = { fn, cleared: false }; state.timers.push(timer); return timer; },
    clearTimeout: (timer) => { timer.cleared = true; },
  });
  const modules = {
    './store.js': store, './git.js': git, './adapters.js': adapters,
    './plan.js': { validatePlan: () => {}, PlanValidationError: class extends Error {} },
    './prompts.js': { buildTaskPrompt: () => 'mock prompt', buildPlanPrompt: () => '', buildReviewPrompt: () => '' },
    './settings.js': { readSettings: () => ({}), saveSettings: () => ({}) },
    'node:util': { isDeepStrictEqual },
    'node:path': pathModule,
    'node:fs': { existsSync: (path) => state.worktrees.has(pathModule.dirname(path)), readFileSync: () => '' },
  };
  const engine = new vm.SourceTextModule(engineSource, { context });
  await engine.link(async (specifier) => {
    const exports = modules[specifier];
    assert.ok(exports, `Unexpected import: ${specifier}`);
    const keys = Object.keys(exports);
    return new vm.SyntheticModule(keys, function () {
      for (const key of keys) this.setExport(key, exports[key]);
    }, { context });
  });
  await engine.evaluate();
  state.api = engine.namespace;
  state.bus = bus;
  return state;
}

// SourceTextModule needs a flag on supported Node versions. Each child executes the
// actual engine with memory-only imports; it cannot open .data or launch a worker.
export function regression(name, verify) {
  test(name, () => {
    const script = `
      import assert from 'node:assert/strict';
      import * as vm from 'node:vm';
      import * as pathModule from 'node:path';
      import { isDeepStrictEqual } from 'node:util';
      import { EventEmitter } from 'node:events';
      import { readFileSync } from 'node:fs';
      const engineSource = readFileSync(${JSON.stringify(enginePath)}, 'utf8');
      const deferred = ${deferred.toString()};
      const settle = ${settle.toString()};
      const createHarness = ${createHarness.toString()};
      await (${verify.toString()})();
    `;
    const child = spawnSync(process.execPath, ['--experimental-vm-modules', '--input-type=module', '--eval', script], {
      encoding: 'utf8', windowsHide: true, timeout: 15_000,
    });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stdout + child.stderr);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
regression('准备阶段同步占用成员、会话、串行和全局配额，重复调度不会多开', async () => {
  for (const [memberLimit, mode, expected] of [[1, 'parallel', 1], [10, 'parallel', 2], [10, 'serial', 1]]) {
    const h = await createHarness({ rooms: [{ status: 'running', mode }], members: [{ concurrency: memberLimit }], tasks: Array.from({ length: 6 }, () => ({})) });
    h.api.schedule();
    h.api.schedule();
    assert.equal(h.api.runningTasks().length, expected);
    assert.ok(h.api.runningTasks().every((entry) => entry.phase === 'starting'));
    await settle();
    assert.equal(h.workers.length, expected);
    await assert.rejects(h.api.startTask('t6'), /名额已满|并发已满/);
    assert.equal(h.tasks.get('t6').status, 'ready');
  }
  const h = await createHarness({
    rooms: [{ status: 'running' }, { id: 'r2', status: 'running' }],
    members: [{ concurrency: 10 }, { id: 'm2', room_id: 'r2', concurrency: 10 }],
    tasks: Array.from({ length: 6 }, (_, i) => i < 3 ? {} : { room_id: 'r2', owner_id: 'm2' }),
  });
  h.api.schedule();
  assert.equal(h.api.runningTasks().length, 3);
  await settle();
  assert.equal(h.workers.length, 3);
  await assert.rejects(h.api.startTask('t6'), /全局 3 个执行名额已满/);
});

regression('重复手动请求在准备、执行和收尾期间都不重建工作区或启动第二个 worker', async () => {
  const preparation = deferred();
  const collection = deferred();
  const h = await createHarness({ hooks: { prepare: () => preparation.promise, commit: () => collection.promise } });
  const run = h.api.startTask('t1');
  assert.equal((await h.api.startTask('t1')).already, true);
  preparation.resolve();
  await settle();
  assert.equal((await h.api.startTask('t1')).already, true);
  h.workers[0].finish();
  await settle();
  assert.equal(h.api.runningTasks()[0].phase, 'collecting');
  assert.equal((await h.api.startTask('t1')).already, true);
  assert.equal(h.workers.length, 1);
  assert.equal(h.prepareCalls.length, 1);
  collection.resolve(false);
  await run;
  assert.equal(h.api.runningTasks().length, 0);
});

regression('手动可运行 draft 和 paused，自动调度不会从这些会话开工', async () => {
  const h = await createHarness({
    rooms: [{ status: 'draft' }, { id: 'r2', status: 'paused' }],
    members: [{ concurrency: 2 }, { id: 'm2', room_id: 'r2' }],
    tasks: [{}, { room_id: 'r2', owner_id: 'm2' }, { room_id: 'r2', owner_id: 'm2' }], stat: '',
  });
  h.api.schedule();
  await settle();
  assert.equal(h.workers.length, 0);
  const first = h.api.startTask('t1');
  const second = h.api.startTask('t2');
  await settle();
  assert.equal(h.workers.length, 2);
  h.workers.forEach((worker) => worker.finish());
  await Promise.all([first, second]);
  assert.equal(h.rooms.get('r').status, 'draft');
  assert.equal(h.rooms.get('r2').status, 'paused');
  assert.equal(h.tasks.get('t3').status, 'ready');
  assert.equal(h.workers.length, 2);
});

regression('手动运行保留 backlog、ready、failed、cancelled 和评审退回任务的兼容性', async () => {
  for (const status of ['backlog', 'ready', 'failed', 'cancelled', 'changes_requested', 'escalated']) {
    const h = await createHarness({ tasks: [{ status }] });
    const run = h.api.startTask('t1');
    await settle();
    assert.equal(h.workers.length, 1, status);
    assert.equal(h.tasks.get('t1').status, 'running');
    h.workers[0].finish();
    assert.equal((await run).ok, true);
    assert.equal(h.tasks.get('t1').status, 'review');
    assert.equal(h.api.runningTasks().length, 0);
  }
  const queued = await createHarness({ tasks: [{ status: 'failed' }] });
  queued.api.retryTask('t1');
  assert.equal(queued.tasks.get('t1').status, 'ready');
  assert.equal(queued.api.runningTasks().length, 0);
  assert.equal(queued.rooms.get('r').status, 'paused');
});

regression('依赖未完成、无效成员和历史状态拒绝启动，不把排队任务改为失败', async () => {
  const h = await createHarness({ tasks: [{ status: 'review' }, { status: 'backlog', deps_json: '["T1"]' }] });
  await assert.rejects(h.api.startTask('t2'), /先完成上游任务/);
  assert.throws(() => h.api.retryTask('t2'), /先完成上游任务/);
  assert.equal(h.tasks.get('t2').status, 'backlog');
  h.rooms.get('r').status = 'running';
  h.tasks.get('t2').status = 'ready';
  h.api.schedule();
  await settle();
  assert.equal(h.tasks.get('t2').status, 'ready');
  assert.equal(h.workers.length, 0);
  h.rooms.get('r').status = 'paused';
  h.tasks.get('t1').status = 'merged';
  h.members.get('m').room_id = 'other-room';
  await assert.rejects(h.api.startTask('t2'), /不属于当前会话/);
  h.members.get('m').room_id = 'r';
  h.members.get('m').enabled = 0;
  await assert.rejects(h.api.startTask('t2'), /已停用/);
  h.members.get('m').enabled = 1;
  for (const status of ['review', 'approved', 'merged', 'done']) {
    h.tasks.get('t2').status = status;
    await assert.rejects(h.api.startTask('t2'), /不能.*运行|不能重复运行/);
    assert.throws(() => h.api.retryTask('t2'));
    assert.equal(h.tasks.get('t2').status, status);
  }
  assert.throws(() => h.api.cancelTask('t2'), /任务已经完成/);
  assert.equal(h.api.runningTasks().length, 0);
});

regression('准备期间暂停自动任务会退回就绪，随后仍允许手动运行', async () => {
  const gate = deferred();
  const h = await createHarness({ rooms: [{ status: 'running' }], hooks: { prepare: () => gate.promise } });
  h.api.schedule();
  await settle();
  h.api.pauseRoom('r');
  gate.resolve();
  await settle();
  assert.equal(h.tasks.get('t1').status, 'ready');
  assert.equal(h.api.runningTasks().length, 0);
  assert.equal(h.workers.length, 0);
  assert.ok(h.events.some((event) => event.type === 'task.deferred'));
  const manual = h.api.startTask('t1');
  await settle();
  assert.equal(h.workers.length, 1);
  h.workers[0].finish();
  await manual;
});

regression('准备期间取消不启动 worker，旧操作排空前不能通过 retry 复活', async () => {
  const gate = deferred();
  const h = await createHarness({ hooks: { prepare: () => gate.promise } });
  const run = h.api.startTask('t1');
  h.api.cancelTask('t1');
  assert.equal(h.tasks.get('t1').status, 'cancelled');
  assert.equal(h.api.runningTasks().length, 1);
  assert.throws(() => h.api.retryTask('t1'), /等待结束后再重试/);
  assert.equal((await h.api.startTask('t1')).already, true);
  gate.resolve();
  assert.equal((await run).cancelled, true);
  assert.equal(h.workers.length, 0);
  assert.equal(h.tasks.get('t1').status, 'cancelled');
  assert.equal(h.api.runningTasks().length, 0);
  assert.equal([...h.runs.values()][0].status, 'cancelled');
});

regression('取消覆盖执行和每个 Git 收尾窗口，晚到结果不覆盖取消状态', async () => {
  for (const stage of ['worker', 'commit', 'diff']) {
    const gate = deferred();
    const hooks = stage === 'commit' ? { commit: () => gate.promise } : stage === 'diff' ? { diff: () => gate.promise } : {};
    const h = await createHarness({ hooks });
    const run = h.api.startTask('t1');
    await settle();
    if (stage !== 'worker') { h.workers[0].finish(); await settle(); }
    h.api.cancelTask('t1');
    assert.equal(h.api.runningTasks().length, 1);
    assert.equal(h.tasks.get('t1').status, 'cancelled');
    assert.throws(() => h.api.retryTask('t1'), /等待结束后再重试/);
    if (stage === 'worker') h.workers[0].finish({ code: 1 });
    else gate.resolve(stage === 'diff' ? { stdout: ' changed | 1 +' } : false);
    assert.equal((await run).cancelled, true);
    assert.equal(h.tasks.get('t1').status, 'cancelled');
    assert.equal(h.api.runningTasks().length, 0);
    assert.ok(!h.events.some((event) => event.type === 'task.finished'));
    if (stage === 'worker') assert.equal(h.commitCalls.length, 0);
    if (stage === 'commit') assert.equal(h.diffCalls.length, 0);
  }
});

regression('工作区或同步启动失败释放配额，并继续调度下一任务', async () => {
  for (const stage of ['prepare', 'spawn']) {
    let attempts = 0;
    const failFirst = () => { if (++attempts === 1) throw new Error('simulated startup failure'); };
    const h = await createHarness({ rooms: [{ status: 'running' }], tasks: [{}, {}], hooks: { [stage]: failFirst } });
    await assert.rejects(h.api.startTask('t1'), /失败.*重试/);
    await settle();
    assert.equal(h.tasks.get('t1').status, 'failed');
    assert.equal([...h.runs.values()].find((run) => run.task_id === 't1').status, 'failed');
    assert.ok(!h.api.runningTasks().some((entry) => entry.taskId === 't1'));
    assert.equal(h.workers.length, 1);
    assert.equal(h.tasks.get('t2').status, 'running');
  }
});

regression('Git 提交或读取 diff 失败不会当作空改动成功，也不解锁下游', async () => {
  for (const stage of ['commit', 'diff']) {
    const h = await createHarness({ tasks: [{}, { status: 'backlog', deps_json: '["T1"]' }], hooks: { [stage]: () => { throw new Error('simulated git failure'); } } });
    const run = h.api.startTask('t1');
    await settle();
    h.workers[0].finish();
    await assert.rejects(run, /收集改动失败.*重试/);
    assert.equal(h.tasks.get('t1').status, 'failed');
    assert.equal(h.tasks.get('t2').status, 'backlog');
    assert.equal([...h.runs.values()][0].status, 'failed');
    assert.equal(h.api.runningTasks().length, 0);
  }
});

regression('超时后等待原 worker 真正退出再释放名额并调度下一任务', async () => {
  const h = await createHarness({ rooms: [{ status: 'running', mode: 'serial' }], tasks: [{}, {}] });
  const run = h.api.startTask('t1');
  await settle();
  h.timers[0].fn();
  await settle();
  assert.equal(h.kills.length, 1);
  assert.equal(h.api.runningTasks().length, 1);
  assert.equal(h.workers.length, 1);
  await assert.rejects(h.api.startTask('t2'), /名额已满/);
  h.workers[0].finish({ code: 1 });
  assert.equal((await run).code, -2);
  await settle();
  assert.equal(h.tasks.get('t1').status, 'failed');
  assert.equal(h.workers.length, 2);
  assert.equal(h.tasks.get('t2').status, 'running');
});

regression('Git 收尾期间任务状态被新操作改变时，旧运行不能覆盖新状态', async () => {
  const gate = deferred();
  const h = await createHarness({ hooks: { diff: () => gate.promise } });
  const run = h.api.startTask('t1');
  await settle();
  h.workers[0].finish();
  await settle();
  h.tasks.get('t1').status = 'merged';
  gate.resolve({ stdout: ' changed | 1 +' });
  assert.equal((await run).interrupted, true);
  assert.equal(h.tasks.get('t1').status, 'merged');
  assert.equal(h.api.runningTasks().length, 0);
});
}
