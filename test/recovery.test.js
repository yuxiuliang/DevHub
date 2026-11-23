import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const storeUrl = new URL('../server/store.js', import.meta.url).href;
const engineUrl = new URL('../server/engine.js', import.meta.url).href;
const entry = fileURLToPath(new URL('../server/index.js', import.meta.url));
const old = '2000-01-01T00:00:00.000Z';

function fixture(t) {
  const data = mkdtempSync(join(tmpdir(), 'devhub-node-recovery-'));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  return data;
}

function runNode(data, args) {
  const child = spawnSync(process.execPath, args, {
    env: { ...process.env, DEVHUB_DATA: data, PORT: '0' },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000,
  });
  assert.ifError(child.error);
  return child;
}

function openStore(data, script = '') {
  const child = runNode(data, ['--input-type=module', '--eval', `
    import { openStore, get } from ${JSON.stringify(storeUrl)};
    import assert from 'node:assert/strict';
    openStore();
    ${script}
  `]);
  assert.equal(child.status, 0, child.stderr);
}

function seed(data) {
  openStore(data);
  const log = join(data, 'logs', 'run-active.log');
  const worktree = join(data, 'worktrees', 'task-active');
  mkdirSync(worktree);
  writeFileSync(log, 'worker output\n');
  writeFileSync(join(worktree, 'draft.txt'), 'unfinished work\n');
  const db = new DatabaseSync(join(data, 'devhub.db'));
  try {
    // Recreate a database written before the result_sha migration.
    db.exec('ALTER TABLE tasks DROP COLUMN result_sha');
    const insertRoom = db.prepare('INSERT INTO rooms (id, name, repo_path, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
    for (const [id, status] of [['room', 'running'], ['queue', 'running'], ['paused', 'paused'], ['archived', 'archived']]) {
      insertRoom.run(id, id, 'unused-fixture-repo', status, old, old);
    }
    db.exec("INSERT INTO members (id, room_id, name, worker) VALUES ('member', 'room', 'Fixture', 'opencode')");
    const insertTask = db.prepare(`INSERT INTO tasks (id, room_id, key, title, owner_id, status, summary, deps_json, worktree, branch, base_sha, created_at, updated_at)
                                   VALUES (?, ?, ?, ?, 'member', ?, 'previous summary', ?, ?, ?, 'old-base', ?, ?)`);
    insertTask.run('task-active', 'room', 'T1', 'Active', 'running', '[]', worktree, 'devhub/fixture', old, old);
    insertTask.run('task-ready', 'queue', 'T2', 'Ready', 'ready', '[]', '', '', old, old);
    insertTask.run('task-backlog', 'room', 'T3', 'Waiting', 'backlog', '["T1"]', '', '', old, old);
    insertTask.run('task-done', 'room', 'T4', 'Done', 'done', '[]', '', '', old, old);
    insertTask.run('task-no-run', 'paused', 'T1', 'No run row', 'running', '[]', '', '', old, old);
    const insertRun = db.prepare(`INSERT INTO runs (id, task_id, member_id, status, session_id, exit_code, log_path, error, started_at, ended_at)
                                  VALUES (?, ?, 'member', ?, ?, ?, ?, ?, ?, ?)`);
    insertRun.run('run-active', 'task-active', 'running', 'existing-session', null, log, '', old, null);
    insertRun.run('run-older', 'task-active', 'completed', '', 0, '', 'old details', old, old);
    insertRun.run('run-orphan', 'missing-task', 'running', '', null, '', '', old, null);
    return { log, worktree };
  } finally {
    db.close();
  }
}

test('同一数据目录拒绝启动且不恢复，不同目录正常；连接退出后可重新获取锁', (t) => {
  const data = fixture(t);
  const other = fixture(t);
  seed(data);
  const lock = new DatabaseSync(join(data, 'devhub.instance.sqlite'));
  const db = new DatabaseSync(join(data, 'devhub.db'));
  try {
    lock.exec('BEGIN EXCLUSIVE');
    const rejected = runNode(data, [entry]);
    assert.equal(rejected.status, 1, rejected.stderr);
    assert.match(rejected.stderr, /数据目录已被另一个 DevHub 实例使用/);
    assert.ok(rejected.stderr.includes(data));
    assert.equal(db.prepare("SELECT status FROM tasks WHERE id='task-active'").get().status, 'running');
    assert.ok(!db.prepare('PRAGMA table_info(tasks)').all().some((column) => column.name === 'result_sha'));
    openStore(other);
  } finally {
    db.close();
    lock.close();
  }
  openStore(data, `
    const { DatabaseSync } = await import('node:sqlite');
    const { join } = await import('node:path');
    const contender = new DatabaseSync(join(process.env.DEVHUB_DATA, 'devhub.instance.sqlite'));
    try {
      assert.throws(() => contender.exec('BEGIN EXCLUSIVE'), /database is locked/);
    } finally {
      contender.close();
    }
  `);
  openStore(data);
});

test('重启收尾遗留运行、保留队列及文件、迁移旧库，并允许显式重试', (t) => {
  const data = fixture(t);
  const { log, worktree } = seed(data);
  const db = new DatabaseSync(join(data, 'devhub.db'));
  const task = (id) => db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
  const room = (id) => db.prepare('SELECT * FROM rooms WHERE id=?').get(id);
  const run = (id) => db.prepare('SELECT * FROM runs WHERE id=?').get(id);
  const events = () => db.prepare('SELECT * FROM events ORDER BY id').all();
  try {
    const preserved = [task('task-ready'), task('task-backlog'), task('task-done')];
    const oldRun = run('run-older');
    const paused = room('paused');
    const archived = room('archived');
    openStore(data);

    const interrupted = run('run-active');
    assert.equal(interrupted.status, 'interrupted');
    assert.equal(interrupted.session_id, 'existing-session');
    assert.equal(interrupted.exit_code, null);
    assert.equal(interrupted.started_at, old);
    assert.ok(Date.parse(interrupted.ended_at) > Date.parse(old));
    assert.match(interrupted.error, /重启.*中断.*手动重试/);
    assert.equal(interrupted.log_path, log);
    assert.deepEqual(run('run-older'), oldRun);
    assert.equal(run('run-orphan').status, 'interrupted');

    const failed = task('task-active');
    assert.equal(failed.status, 'failed');
    assert.equal(failed.summary, interrupted.error);
    assert.equal(failed.updated_at, interrupted.ended_at);
    assert.equal(failed.worktree, worktree);
    assert.equal(failed.branch, 'devhub/fixture');
    assert.equal(failed.base_sha, 'old-base');
    assert.equal(failed.result_sha, '');
    assert.equal(task('task-no-run').status, 'failed');
    assert.equal(readFileSync(log, 'utf8'), 'worker output\n');
    assert.equal(readFileSync(join(worktree, 'draft.txt'), 'utf8'), 'unfinished work\n');
    for (const before of preserved) {
      const { result_sha, ...after } = task(before.id);
      assert.equal(result_sha, '');
      assert.deepEqual(after, { ...before });
    }
    assert.equal(room('room').status, 'paused');
    assert.equal(room('queue').status, 'paused');
    assert.deepEqual(room('paused'), paused);
    assert.deepEqual(room('archived'), archived);

    const recoveredEvents = events();
    assert.equal(recoveredEvents.length, 6);
    const expected = [
      ['run.interrupted', 'room', 'task-active', 'run-active', 'interrupted'],
      ['run.interrupted', null, 'missing-task', 'run-orphan', 'interrupted'],
      ['task.interrupted', 'room', 'task-active', null, 'failed'],
      ['task.interrupted', 'paused', 'task-no-run', null, 'failed'],
      ['room.recovered', 'room', null, null, 'paused'],
      ['room.recovered', 'queue', null, null, 'paused'],
    ];
    for (const [type, roomId, taskId, runId, status] of expected) {
      const event = recoveredEvents.find((e) => e.type === type && e.room_id === roomId && e.task_id === taskId && e.run_id === runId);
      assert.ok(event, `missing ${type} for ${taskId || roomId}`);
      const payload = JSON.parse(event.payload);
      assert.equal(payload.status, status);
      assert.match(payload.reason, /重启/);
      assert.equal(event.created_at, interrupted.ended_at);
    }

    db.prepare("UPDATE tasks SET result_sha='result-commit' WHERE id='task-done'").run();
    openStore(data);
    assert.deepEqual(events(), recoveredEvents);
    assert.equal(task('task-done').result_sha, 'result-commit');
    openStore(data, `
      const { retryTask, runningTasks } = await import(${JSON.stringify(engineUrl)});
      assert.equal(get("SELECT status FROM rooms WHERE id='room'").status, 'paused');
      retryTask('task-active');
      assert.deepEqual(runningTasks(), []);
    `);
    assert.equal(task('task-active').status, 'ready');
    assert.equal(task('task-ready').status, 'ready');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM runs').get().n, 3);
  } finally {
    db.close();
  }
});

test('恢复事务失败时回滚状态、事件与迁移，并释放实例锁', (t) => {
  const data = fixture(t);
  seed(data);
  const db = new DatabaseSync(join(data, 'devhub.db'));
  try {
    db.exec(`CREATE TRIGGER abort_recovery BEFORE INSERT ON events
             WHEN NEW.type='room.recovered' BEGIN SELECT RAISE(ABORT, 'recovery fixture'); END`);
    const rejected = runNode(data, [entry]);
    assert.equal(rejected.status, 1, rejected.stderr);
    assert.match(rejected.stderr, /recovery fixture/);
    assert.equal(db.prepare("SELECT status FROM runs WHERE id='run-active'").get().status, 'running');
    assert.equal(db.prepare("SELECT status FROM tasks WHERE id='task-active'").get().status, 'running');
    assert.equal(db.prepare("SELECT status FROM rooms WHERE id='room'").get().status, 'running');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 0);
    assert.ok(!db.prepare('PRAGMA table_info(tasks)').all().some((column) => column.name === 'result_sha'));
    db.exec('DROP TRIGGER abort_recovery');
    openStore(data);
    assert.equal(db.prepare("SELECT status FROM runs WHERE id='run-active'").get().status, 'interrupted');
  } finally {
    db.close();
  }
});
