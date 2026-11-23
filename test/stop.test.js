import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const enginePath = fileURLToPath(new URL('../server/engine.js', import.meta.url));
const apiUrl = new URL('../server/api.js', import.meta.url).href;
const storeUrl = new URL('../server/store.js', import.meta.url).href;

function runChild(t, prefix, source) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const child = spawnSync(process.execPath, ['--experimental-vm-modules', '--input-type=module', '--eval', source], {
    env: { ...process.env, DEVHUB_DATA: directory }, encoding: 'utf8', windowsHide: true, timeout: 20_000,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stdout + child.stderr);
}

test('global stop signals task, plan and review workers but preserves queued, merge and read-only work', (t) => {
  const source = `
    import assert from 'node:assert/strict';
    import * as vm from 'node:vm';
    import * as pathModule from 'node:path';
    import { isDeepStrictEqual } from 'node:util';
    import { EventEmitter } from 'node:events';
    import { readFileSync } from 'node:fs';

    const engineSource = readFileSync(${JSON.stringify(enginePath)}, 'utf8');
    function deferred() {
      let resolve;
      const promise = new Promise((yes) => { resolve = yes; });
      return { promise, resolve };
    }
    async function settle() { for (let i = 0; i < 60; i++) await Promise.resolve(); }

    const shaA = 'a'.repeat(40), shaB = 'b'.repeat(40);
    const readGate = deferred(), mergeGate = deferred();
    const readReached = deferred(), mergeReached = deferred();
    let clock = 0;
    const state = {
      rooms: new Map([
        ['r_task', { id: 'r_task', status: 'running', mode: 'parallel', repo_path: 'repo-task', base_branch: 'main', auto_approve: 0 }],
        ['r_plan', { id: 'r_plan', status: 'draft', repo_path: 'repo-plan', base_branch: 'main', flow_json: '{"nodes":[],"edges":[]}', planner_id: 'm_plan', reviewer_id: 'm_review' }],
        ['r_read', { id: 'r_read', status: 'paused', repo_path: 'repo-read', base_branch: 'main' }],
        ['r_merge', { id: 'r_merge', status: 'paused', repo_path: 'repo-merge', base_branch: 'main' }],
      ]),
      members: new Map([
        ['m_task', { id: 'm_task', room_id: 'r_task', name: 'Task', worker: 'mock', enabled: 1, concurrency: 1 }],
        ['m_plan', { id: 'm_plan', room_id: 'r_plan', name: 'Planner', worker: 'mock', enabled: 1, concurrency: 1 }],
        ['m_review', { id: 'm_review', room_id: 'r_plan', name: 'Reviewer', worker: 'mock', enabled: 1, concurrency: 1 }],
        ['m_read', { id: 'm_read', room_id: 'r_read', name: 'Reader', worker: 'mock', enabled: 1, concurrency: 1 }],
        ['m_merge', { id: 'm_merge', room_id: 'r_merge', name: 'Merger', worker: 'mock', enabled: 1, concurrency: 1 }],
      ]),
      tasks: new Map([
        ['t_run', { id: 't_run', room_id: 'r_task', owner_id: 'm_task', key: 'T1', title: 'Active task', status: 'ready', type: 'code', worktree: 'wt/task', branch: 'branch/task', base_sha: shaA, deps_json: '[]', acceptance_json: '[]', summary: '', diff_stat: '' }],
        ['t_ready', { id: 't_ready', room_id: 'r_task', owner_id: 'm_task', key: 'T2', title: 'Queued ready', status: 'ready', type: 'code', worktree: '', branch: '', base_sha: '', deps_json: '[]', acceptance_json: '[]' }],
        ['t_backlog', { id: 't_backlog', room_id: 'r_task', owner_id: 'm_task', key: 'T3', title: 'Queued backlog', status: 'backlog', type: 'code', worktree: '', branch: '', base_sha: '', deps_json: '[]', acceptance_json: '[]' }],
        ['t_review', { id: 't_review', room_id: 'r_plan', owner_id: 'm_review', key: 'T1', title: 'Active review', status: 'review', type: 'code', worktree: 'wt/review', branch: 'branch/review', base_sha: shaA, result_sha: shaB, deps_json: '[]', acceptance_json: '[]', diff_stat: ' change | 1 +' }],
        ['t_read', { id: 't_read', room_id: 'r_read', owner_id: 'm_read', key: 'T1', title: 'Read-only diff', status: 'review', type: 'code', worktree: 'wt/read', branch: 'branch/read', base_sha: shaA, result_sha: '', deps_json: '[]', acceptance_json: '[]', diff_stat: ' change | 1 +' }],
        ['t_merge', { id: 't_merge', room_id: 'r_merge', owner_id: 'm_merge', key: 'T1', title: 'Active merge', status: 'approved', type: 'code', worktree: 'wt/merge', branch: 'branch/merge', base_sha: shaA, result_sha: shaB, deps_json: '[]', acceptance_json: '[]', diff_stat: ' change | 1 +' }],
      ]),
      runs: new Map(), reviews: [], worktrees: new Set(['wt/task']), workers: [], kills: [], events: [], merges: [],
    };
    const clone = (row) => row && { ...row };
    const safeJson = (value, fallback) => { try { return JSON.parse(value); } catch { return fallback; } };
    const taskPayload = (task) => ({ ...task, deps: safeJson(task.deps_json, []), acceptance: safeJson(task.acceptance_json, []) });
    const all = (sql, params = []) => {
      if (sql.includes('FROM rooms')) return [...state.rooms.values()]
        .filter((room) => !sql.includes("status='running'") || room.status === 'running').map(clone);
      if (sql.includes('FROM members')) return [...state.members.values()].filter((member) => member.room_id === params[0]).map(clone);
      if (sql.includes('FROM tasks')) return [...state.tasks.values()].filter((task) => task.room_id === params[0]
        && (!sql.includes("status='ready'") || task.status === 'ready')).map(clone);
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
      const update = sql.match(/^UPDATE (tasks|rooms|runs) SET (.+) WHERE id=\\?$/);
      if (update) {
        const row = state[update[1]].get(params[params.length - 1]);
        if (row) update[2].split(',').forEach((assignment, index) => { row[assignment.split('=')[0].trim()] = params[index]; });
        return { changes: row ? 1 : 0 };
      }
      const insert = sql.match(/^INSERT INTO runs \\(([^)]+)\\)/);
      if (insert) {
        const row = Object.fromEntries(insert[1].split(',').map((column, index) => [column.trim(), params[index]]));
        state.runs.set(row.id, row);
        return { changes: 1 };
      }
      throw new Error('Unexpected mock SQL: ' + sql);
    };
    const bus = new EventEmitter();
    const store = {
      all, get, run, transaction: (fn) => fn(), bus,
      emit: (roomId, taskId, runId, type, payload = {}) => {
        const event = { room_id: roomId, task_id: taskId, run_id: runId, type, payload };
        state.events.push(event);
        bus.emit('event', event);
      },
      now: () => new Date(++clock * 1000).toISOString(), uid: (prefix) => prefix + '_' + (++clock),
      safeJson, taskPayload, roomPayload: (room) => room, memberPayload: (member) => member,
      defaultFlow: () => ({ nodes: [], edges: [] }), starterFlow: () => ({ nodes: [], edges: [] }), WORKTREES: 'mock-worktrees',
    };
    const git = {
      currentBranch: async () => 'main', revParse: async () => shaA,
      commitSha: async (repo, ref) => {
        if (repo === 'repo-read') { readReached.resolve(); await readGate.promise; return shaB; }
        if (repo === 'repo-merge') { mergeReached.resolve(); await mergeGate.promise; return shaB; }
        if (ref === 'HEAD') return shaB;
        return /^[a-f0-9]{40}$/i.test(ref) ? ref : shaB;
      },
      diffCommit: async () => 'diff content', trackedStatus: async () => '',
      mergeSquash: async (...args) => { state.merges.push(args); },
      addWorktree: async (_repo, path) => state.worktrees.add(path),
      commitAll: async () => true, git: async () => ({ stdout: ' change | 1 +' }),
    };
    const adapters = {
      WORKER_DEFS: { mock: {} }, killTree: (pid) => state.kills.push(pid),
      runWorker: (options) => {
        const pid = 700 + state.workers.length;
        const worker = { pid, options, finish: (result = {}) => options.onExit({
          code: 0, text: 'ok', session: '', logPath: 'mock.log', ...result,
        }) };
        state.workers.push(worker);
        return { child: { pid }, logPath: 'mock.log' };
      },
    };
    const context = vm.createContext({ console, setTimeout: () => 1, clearTimeout: () => {} });
    const modules = {
      './store.js': store, './git.js': git, './adapters.js': adapters,
      './plan.js': { validatePlan: () => {}, PlanValidationError: class extends Error {} },
      './prompts.js': { buildTaskPrompt: () => 'task', buildPlanPrompt: () => 'plan', buildReviewPrompt: () => 'review' },
      './settings.js': { readSettings: () => ({}), saveSettings: () => ({}) },
      'node:util': { isDeepStrictEqual }, 'node:path': pathModule,
      'node:fs': { existsSync: (path) => state.worktrees.has(pathModule.dirname(path)), readFileSync: () => '' },
    };
    const engine = new vm.SourceTextModule(engineSource, { context });
    await engine.link(async (specifier) => {
      const exports = modules[specifier];
      assert.ok(exports, 'Unexpected import: ' + specifier);
      const keys = Object.keys(exports);
      return new vm.SyntheticModule(keys, function () { for (const key of keys) this.setExport(key, exports[key]); }, { context });
    });
    await engine.evaluate();
    const api = engine.namespace;

    const taskRun = api.startTask('t_run');
    const planRun = api.generatePlan('r_plan').catch((error) => error);
    const reviewRun = api.reviewTask('t_review').catch((error) => error);
    const readRun = api.taskDiff('t_read');
    const mergeRun = api.mergeTask('t_merge');
    await Promise.all([readReached.promise, mergeReached.promise]);
    await settle();
    assert.equal(state.workers.length, 3);
    assert.deepEqual(state.workers.map((worker) => worker.options.prompt).sort(), ['plan', 'review', 'task']);
    assert.equal(api.activeWorkerCount(), 3, 'task run + plan + review are counted, merge and read-only are not');

    assert.equal(api.stopAll(), 3);
    assert.deepEqual(state.kills.slice().sort((a, b) => a - b), [700, 701, 702]);
    const roomCancelEvents = state.events.filter((event) => event.type === 'run.cancel.requested');
    assert.equal(roomCancelEvents.length, 1, 'plan and review in the same room share one cancelRoomRun request');
    assert.equal(roomCancelEvents[0].room_id, 'r_plan');
    assert.equal(roomCancelEvents[0].payload.count, 2);
    assert.equal(api.activeWorkerCount(), 3, 'operations remain active until their workers exit');
    assert.equal(state.rooms.get('r_task').status, 'paused', 'global stop pauses automatic dispatch for the active task room');
    assert.equal(state.rooms.get('r_plan').status, 'paused', 'global stop pauses the room with active plan/review work');
    assert.equal(state.tasks.get('t_run').status, 'cancelled');
    api.schedule();
    assert.equal(state.workers.length, 3, 'the preserved ready task did not start after global stop');
    assert.equal(state.tasks.get('t_ready').status, 'ready');
    assert.equal(state.tasks.get('t_backlog').status, 'backlog');
    assert.equal(state.tasks.get('t_merge').status, 'approved', 'global stop did not cancel an active merge');
    assert.equal(state.tasks.get('t_read').result_sha, '', 'global stop did not alter an active read-only operation');

    for (const worker of state.workers) worker.finish({
      code: 1, error: 'cancelled', text: worker.options.prompt === 'plan' ? '{"tasks":[]}'
        : worker.options.prompt === 'review' ? '{"verdict":"approve","blocking":[]}' : 'cancelled',
    });
    await Promise.all([taskRun, planRun, reviewRun]);
    await settle();
    assert.equal(api.activeWorkerCount(), 0);
    assert.equal(api.stopAll(), 0, 'no stopped-count increment without active cancellable workers');
    assert.equal(state.kills.length, 3);
    assert.equal(state.tasks.get('t_ready').status, 'ready');
    assert.equal(state.tasks.get('t_backlog').status, 'backlog');

    readGate.resolve();
    mergeGate.resolve();
    assert.equal((await readRun).diff, 'diff content');
    await mergeRun;
    assert.equal(state.tasks.get('t_merge').status, 'merged');
    assert.equal(state.merges.length, 1);
  `;
  runChild(t, 'devhub-stop-engine-', source);
});

test('POST /api/stop-all returns stopped count and GET /api/state exposes activeWorkers', (t) => {
  const source = `
    import assert from 'node:assert/strict';
    import { Readable } from 'node:stream';
    import { openStore } from ${JSON.stringify(storeUrl)};
    import { handleApi } from ${JSON.stringify(apiUrl)};
    openStore();
    async function request(method, path) {
      const req = Readable.from([]); req.method = method;
      let status, raw;
      const res = { writeHead(code) { status = code; }, end(value) { raw = value; } };
      assert.equal(await handleApi(req, res, new URL('http://127.0.0.1' + path)), true);
      return { status, body: JSON.parse(raw) };
    }
    const stopped = await request('POST', '/api/stop-all');
    assert.equal(stopped.status, 200);
    assert.deepEqual(stopped.body, { stopped: 0 });
    const state = await request('GET', '/api/state');
    assert.equal(state.status, 200);
    assert.equal(state.body.activeWorkers, 0);
    assert.deepEqual(state.body.running, []);
  `;
  runChild(t, 'devhub-stop-api-', source);
});
