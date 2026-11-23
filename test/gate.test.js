import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { regression } from './scheduler.test.js';

const storeUrl = new URL('../server/store.js', import.meta.url).href;

/** 在独立的 Node 进程里打开 store，避免 openStore 的单例和退出钩子影响其他用例。 */
function openIsolatedStore(directory, source) {
  const script = `
    import assert from 'node:assert/strict';
    import { openStore, all, get, run } from ${JSON.stringify(storeUrl)};
    openStore();
    ${source}
  `;
  return spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    env: { ...process.env, DEVHUB_DATA: directory }, encoding: 'utf8', windowsHide: true, timeout: 20_000,
  });
}

// 说明：regression() 会把每个用例的函数体原样放到子进程里执行，所以
// 流程/阶段/运行这些辅助函数必须在每个用例内部定义，不能提到模块顶层。

regression('自动门禁：有产出就算通过，不再跑评审，可以直接合并', async () => {
  const flow = (nodes, edges = []) => JSON.stringify({ nodes, edges });
  const phase = (id, gate, maxLoop = 0) => ({ id, type: 'phase', name: id, gate, maxLoop, owner: '', outputs: [], x: 40, y: 90 });
  const h = await createHarness({
    rooms: [{ status: 'running', flow_json: flow([phase('n1', 'auto')]) }],
    tasks: [{ phase_id: 'n1' }],
  });
  const running = h.api.startTask('t1');
  await settle();
  h.workers[0].finish();
  await running;
  assert.equal(h.tasks.get('t1').status, 'approved');
  assert.equal(h.tasks.get('t1').reject_count, 0);
  const finished = h.events.find((event) => event.type === 'task.finished');
  assert.equal(finished.payload.gate, 'auto');
  const passed = h.events.find((event) => event.type === 'gate.passed');
  assert.equal(passed.payload.gate, 'auto');
  assert.equal(passed.payload.checks.length, 1);
  assert.equal(passed.payload.checks[0], 'diff');
  await assert.rejects(h.api.reviewTask('t1'), /自动通过/);
  await h.api.mergeTask('t1');
  assert.equal(h.tasks.get('t1').status, 'merged');
  assert.equal(h.mergeCalls.length, 1);
});

regression('评审门禁：评审通过后进入已通过，可以直接合并', async () => {
  const flow = (nodes, edges = []) => JSON.stringify({ nodes, edges });
  const phase = (id, gate, maxLoop = 0) => ({ id, type: 'phase', name: id, gate, maxLoop, owner: '', outputs: [], x: 40, y: 90 });
  const h = await createHarness({
    rooms: [{ status: 'running', flow_json: flow([phase('n1', 'agent', 2)]) }],
    tasks: [{ phase_id: 'n1' }],
  });
  const running = h.api.startTask('t1');
  await settle();
  h.workers[0].finish();
  await running;
  assert.equal(h.tasks.get('t1').status, 'review');
  const review = h.api.reviewTask('t1');
  await settle();
  h.workers[1].finish({ text: JSON.stringify({ verdict: 'approve', blocking: [], notes: '检查通过' }) });
  await review;
  assert.equal(h.tasks.get('t1').status, 'approved');
  assert.equal(h.reviews.length, 1);
  assert.equal(h.events.filter((event) => event.type === 'review.done').at(-1).payload.verdict, 'approve');
  await h.api.mergeTask('t1');
  assert.equal(h.tasks.get('t1').status, 'merged');
});

regression('评审门禁：打回次数按阶段上限升级，升级后人工仍可通过', async () => {
  const flow = (nodes, edges = []) => JSON.stringify({ nodes, edges });
  const phase = (id, gate, maxLoop = 0) => ({ id, type: 'phase', name: id, gate, maxLoop, owner: '', outputs: [], x: 40, y: 90 });
  const requestChanges = { verdict: 'request_changes', blocking: [{ file: 'a.js', line: 3, issue: '空实现', suggestion: '补上' }], notes: '需要修改' };
  const h = await createHarness({
    rooms: [{ status: 'running', flow_json: flow([phase('n1', 'agent', 2)]) }],
    tasks: [{ phase_id: 'n1' }],
  });
  const runOnce = async (index) => {
    const running = h.api.startTask('t1');
    await settle();
    h.workers[index].finish();
    await running;
  };
  const reviewOnce = async (index) => {
    const pending = h.api.reviewTask('t1');
    await settle();
    h.workers[index].finish({ text: JSON.stringify(requestChanges) });
    await pending;
  };
  await runOnce(0);
  assert.equal(h.tasks.get('t1').status, 'review');
  const waiting = h.events.find((event) => event.type === 'gate.waiting');
  assert.equal(waiting.payload.gate, 'agent');
  assert.equal(waiting.payload.maxLoop, 2);

  await reviewOnce(1);
  assert.equal(h.tasks.get('t1').status, 'changes_requested');
  assert.equal(h.tasks.get('t1').reject_count, 1);
  assert.ok(h.tasks.get('t1').feedback.includes('第 1 轮评审'));

  await runOnce(2);
  assert.equal(h.tasks.get('t1').status, 'review');
  await reviewOnce(3);
  assert.equal(h.tasks.get('t1').status, 'escalated');
  assert.equal(h.tasks.get('t1').reject_count, 2);
  const escalated = h.events.find((event) => event.type === 'gate.escalated');
  assert.equal(escalated.payload.gate, 'agent');
  assert.equal(escalated.payload.by, 'agent');
  assert.equal(escalated.payload.maxLoop, 2);
  const done = h.events.filter((event) => event.type === 'review.done').at(-1);
  assert.equal(done.payload.escalated, true);
  assert.equal(done.payload.maxLoop, 2);

  h.api.approveTask('t1');
  assert.equal(h.tasks.get('t1').status, 'approved');
  const manual = h.events.filter((event) => event.type === 'gate.passed').at(-1);
  assert.equal(manual.payload.by, 'human');
  assert.equal(manual.payload.manual, true);
  assert.throws(() => h.api.approveTask('t1'), /已经通过/);
  await h.api.mergeTask('t1');
  assert.equal(h.tasks.get('t1').status, 'merged');
});

regression('评审门禁：上限为 1 时第一次打回就升级，重跑会重新计一轮', async () => {
  const flow = (nodes, edges = []) => JSON.stringify({ nodes, edges });
  const phase = (id, gate, maxLoop = 0) => ({ id, type: 'phase', name: id, gate, maxLoop, owner: '', outputs: [], x: 40, y: 90 });
  const changes = { verdict: 'request_changes', blocking: [{ file: 'a.js', line: 1, issue: 'x', suggestion: 'y' }], notes: 'n' };
  const h = await createHarness({
    rooms: [{ status: 'running', flow_json: flow([phase('n1', 'agent', 1)]) }],
    tasks: [{ phase_id: 'n1' }],
  });
  const running = h.api.startTask('t1');
  await settle();
  h.workers[0].finish();
  await running;
  const review = h.api.reviewTask('t1');
  await settle();
  h.workers[1].finish({ text: JSON.stringify(changes) });
  await review;
  assert.equal(h.tasks.get('t1').status, 'escalated');
  assert.equal(h.tasks.get('t1').reject_count, 1);
  assert.equal(h.reviews.length, 1);

  // 人工点「按意见重跑」等于再给一轮完整机会：计数清零；这一轮第一次打回仍按上限升级。
  const rerun = h.api.startTask('t1');
  await settle();
  h.workers[2].finish();
  await rerun;
  assert.equal(h.tasks.get('t1').reject_count, 0);
  const second = h.api.reviewTask('t1');
  await settle();
  h.workers[3].finish({ text: JSON.stringify(changes) });
  await second;
  assert.equal(h.tasks.get('t1').status, 'escalated');
  assert.equal(h.tasks.get('t1').reject_count, 1);
});

regression('评审门禁：上限为 3 时前两次打回仍可修改，第三次升级', async () => {
  const flow = (nodes, edges = []) => JSON.stringify({ nodes, edges });
  const phase = (id, gate, maxLoop = 0) => ({ id, type: 'phase', name: id, gate, maxLoop, owner: '', outputs: [], x: 40, y: 90 });
  const h = await createHarness({
    rooms: [{ status: 'running', flow_json: flow([phase('n1', 'agent', 3)]) }],
    tasks: [{ phase_id: 'n1' }],
  });
  const runOnce = async (index) => {
    const running = h.api.startTask('t1');
    await settle();
    h.workers[index].finish();
    await running;
  };
  const reviewOnce = async (index) => {
    const pending = h.api.reviewTask('t1');
    await settle();
    h.workers[index].finish({ text: JSON.stringify({ verdict: 'request_changes', blocking: [{ file: 'a.js', line: 1, issue: 'x', suggestion: 'y' }], notes: 'n' }) });
    await pending;
  };
  await runOnce(0);
  await reviewOnce(1);
  assert.equal(h.tasks.get('t1').status, 'changes_requested');
  await runOnce(2);
  await reviewOnce(3);
  assert.equal(h.tasks.get('t1').status, 'changes_requested');
  assert.equal(h.tasks.get('t1').reject_count, 2);
  await runOnce(4);
  await reviewOnce(5);
  assert.equal(h.tasks.get('t1').status, 'escalated');
  assert.equal(h.tasks.get('t1').reject_count, 3);
});

regression('人工门禁：等用户点通过，评审接口被拒绝，打回同样受上限约束', async () => {
  const flow = (nodes, edges = []) => JSON.stringify({ nodes, edges });
  const phase = (id, gate, maxLoop = 0) => ({ id, type: 'phase', name: id, gate, maxLoop, owner: '', outputs: [], x: 40, y: 90 });
  const h = await createHarness({
    rooms: [{ status: 'running', flow_json: flow([phase('n1', 'human', 2)]) }],
    tasks: [{ phase_id: 'n1' }],
  });
  const running = h.api.startTask('t1');
  await settle();
  h.workers[0].finish();
  await running;
  assert.equal(h.tasks.get('t1').status, 'review');
  await assert.rejects(h.api.reviewTask('t1'), /人工确认/);

  h.api.approveTask('t1');
  assert.equal(h.tasks.get('t1').status, 'approved');
  h.api.rejectTask('t1', '再补一行');
  assert.equal(h.tasks.get('t1').status, 'changes_requested');
  assert.equal(h.tasks.get('t1').reject_count, 1);
  assert.ok(h.tasks.get('t1').feedback.includes('再补一行'));

  const rerun = h.api.startTask('t1');
  await settle();
  h.workers[1].finish();
  await rerun;
  h.api.rejectTask('t1', '还是不对');
  assert.equal(h.tasks.get('t1').status, 'escalated');
  assert.equal(h.tasks.get('t1').reject_count, 2);
  const escalated = h.events.filter((event) => event.type === 'gate.escalated').at(-1);
  assert.equal(escalated.payload.by, 'human');
  assert.equal(escalated.payload.gate, 'human');

  h.api.rejectTask('t1', '最后再试一次');
  assert.equal(h.tasks.get('t1').status, 'changes_requested');
  // 人工从升级状态再给机会时，打回计数清零，重新按阶段上限计一轮。
  assert.equal(h.tasks.get('t1').reject_count, 0);
});

regression('没有绑定阶段的任务保持旧行为：评审通过，且人工确认接口有明确错误', async () => {
  const h = await createHarness({ rooms: [{ status: 'running' }], tasks: [{}] });
  const running = h.api.startTask('t1');
  await settle();
  h.workers[0].finish();
  await running;
  assert.equal(h.tasks.get('t1').status, 'review');
  const waiting = h.events.find((event) => event.type === 'gate.waiting');
  assert.equal(waiting.payload.gate, 'agent');
  assert.equal(waiting.payload.maxLoop, 2);

  h.api.approveTask('t1');
  assert.equal(h.tasks.get('t1').status, 'approved');
  assert.equal(h.events.filter((event) => event.type === 'gate.passed').at(-1).payload.manual, true);
  assert.throws(() => h.api.approveTask('t1'), /已经通过/);

  const archived = await createHarness({ rooms: [{ status: 'archived' }], tasks: [{ status: 'review', result_sha: 'a'.repeat(40) }] });
  assert.throws(() => archived.api.approveTask('t1'), /已归档/);

  const queued = await createHarness({ rooms: [{ status: 'paused' }], tasks: [{ status: 'backlog' }] });
  assert.throws(() => queued.api.approveTask('t1'), /没有可确认的成果/);

  const active = await createHarness({ rooms: [{ status: 'paused' }], tasks: [{ status: 'running' }] });
  assert.throws(() => active.api.approveTask('t1'), /正在执行/);

  const missing = await createHarness({ rooms: [{ status: 'paused' }], tasks: [{}] });
  assert.throws(() => missing.api.approveTask('t404'), /任务不存在/);
});


test('旧库启动时补 reject_count 并从评审记录回填，重复启动不覆盖运行期计数', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'devhub-gate-migration-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = new DatabaseSync(join(directory, 'devhub.db'));
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, room_id TEXT NOT NULL, key TEXT NOT NULL, title TEXT NOT NULL,
      spec TEXT NOT NULL DEFAULT '', type TEXT NOT NULL DEFAULT 'code', owner_id TEXT,
      phase_id TEXT, status TEXT NOT NULL DEFAULT 'backlog', deps_json TEXT NOT NULL DEFAULT '[]',
      acceptance_json TEXT NOT NULL DEFAULT '[]', worktree TEXT DEFAULT '', branch TEXT DEFAULT '',
      base_sha TEXT DEFAULT '', feedback TEXT DEFAULT '', summary TEXT DEFAULT '',
      diff_stat TEXT DEFAULT '', result_sha TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE reviews (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, round INTEGER NOT NULL DEFAULT 1,
      verdict TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
    );
    INSERT INTO tasks (id,room_id,key,title,created_at,updated_at)
      VALUES ('t1','r1','T1','legacy rejected','old','old'),('t2','r1','T2','never rejected','old','old');
    INSERT INTO reviews (id,task_id,round,verdict,created_at) VALUES
      ('rv1','t1',1,'request_changes','old'),
      ('rv2','t1',2,'request_changes','old'),
      ('rv3','t1',3,'approve','old');
  `);
  db.close();

  const first = openIsolatedStore(directory, `
    assert.equal(get("SELECT reject_count FROM tasks WHERE id='t1'").reject_count, 2);
    assert.equal(get("SELECT reject_count FROM tasks WHERE id='t2'").reject_count, 0);
    assert.ok(all('PRAGMA table_info(tasks)').some((column) => column.name === 'reject_count'));
    run("UPDATE tasks SET reject_count=1 WHERE id='t2'");
  `);
  assert.equal(first.status, 0, first.stdout + first.stderr);

  // 第二次启动只加列一次：已经存在的运行期计数不能被回填覆盖。
  const second = openIsolatedStore(directory, `
    assert.equal(get("SELECT reject_count FROM tasks WHERE id='t1'").reject_count, 2);
    assert.equal(get("SELECT reject_count FROM tasks WHERE id='t2'").reject_count, 1);
  `);
  assert.equal(second.status, 0, second.stdout + second.stderr);
});

regression('升级任务重跑在准备阶段被拦下时，打回计数要恢复原值', async () => {
  const flow = (nodes, edges = []) => JSON.stringify({ nodes, edges });
  const phase = (id, gate, maxLoop = 0) => ({ id, type: 'phase', name: id, gate, maxLoop, owner: '', outputs: [], x: 40, y: 90 });
  const blocker = {};
  const h = await createHarness({
    rooms: [{ status: 'running', flow_json: flow([phase('n1', 'agent', 2)]) }],
    tasks: [{ phase_id: 'n1', status: 'escalated', reject_count: 2, result_sha: 'a'.repeat(40) }],
    hooks: { prepare: () => { blocker.h.members.get('m').enabled = 0; } },
  });
  blocker.h = h;
  await assert.rejects(h.api.startTask('t1'), /已停用/);
  assert.equal(h.tasks.get('t1').status, 'escalated');
  assert.equal(h.tasks.get('t1').reject_count, 2);
  assert.ok(h.events.some((event) => event.type === 'task.deferred'));
});
