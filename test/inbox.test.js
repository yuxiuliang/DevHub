import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function withTempApi(t, check) {
  const data = mkdtempSync(join(tmpdir(), 'devhub-inbox-test-'));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const apiUrl = new URL('../server/api.js', import.meta.url).href;
  const storeUrl = new URL('../server/store.js', import.meta.url).href;
  const fixture = `
    import assert from 'node:assert/strict';
    import { handleApi } from ${JSON.stringify(apiUrl)};
    import { openStore, get, run } from ${JSON.stringify(storeUrl)};

    openStore();

    async function readState() {
      let status;
      let body;
      const res = {
        writeHead(code) { status = code; },
        end(payload) { body = payload; },
      };
      run('PRAGMA query_only=ON');
      const before = get('SELECT total_changes() AS count').count;
      const handled = await handleApi({ method: 'GET' }, res, new URL('http://127.0.0.1/api/state'));
      assert.equal(handled, true);
      assert.equal(status, 200, body);
      assert.equal(get('SELECT total_changes() AS count').count, before);
      return JSON.parse(body);
    }

    await (${check.toString()})(assert, run, readState);
  `;
  // The subprocess closes the isolated SQLite store before test cleanup on Windows.
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', fixture], {
    env: { ...process.env, DEVHUB_DATA: data },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20_000,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stdout + child.stderr);
}

test('GET /api/state returns an empty inbox when there are no rooms', (t) => {
  withTempApi(t, async (assert, _run, readState) => {
    const state = await readState();
    assert.deepEqual(state.rooms, []);
    assert.deepEqual(state.running, []);
    assert.deepEqual(state.inbox, []);
    assert.ok(Array.isArray(state.flowTemplates));
  });
});

test('GET /api/state classifies and sorts current inbox items with read-only queries', (t) => {
  withTempApi(t, async (assert, run, readState) => {
    const old = '2026-01-01T00:00:01.000Z';
    const recent = '2026-01-01T00:00:02.000Z';
    const newest = '2026-01-01T00:00:03.000Z';
    const validPlan = JSON.stringify({ tasks: [{ title: '生成的任务' }] });

    function room(id, { name = id, status = 'draft', planJson = validPlan, updatedAt = old } = {}) {
      run('INSERT INTO rooms (id, name, repo_path, status, plan_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
        [id, name, 'unused-fixture-path', status, planJson, old, updatedAt]);
    }

    function task(id, roomId, status, { title = id, updatedAt = old, worktree = '', branch = '' } = {}) {
      run('INSERT INTO tasks (id, room_id, key, title, status, worktree, branch, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
        [id, roomId, id, title, status, worktree, branch, old, updatedAt]);
    }

    room('r_active', { name: '正在处理的会话', status: 'running' });
    task('t_z_escalated', 'r_active', 'escalated', { title: '处理升级', updatedAt: recent });
    task('t_a_changes', 'r_active', 'changes_requested', { title: '按意见修改', updatedAt: recent });
    task('t_failed', 'r_active', 'failed', { title: '检查失败原因' });
    task('t_z_review', 'r_active', 'review', { title: '查看另一项成果', updatedAt: recent });
    task('t_a_approved', 'r_active', 'approved', { title: '合并已通过成果', updatedAt: recent });
    task('t_newest_review', 'r_active', 'review', { title: '查看最新成果', updatedAt: newest });
    for (const status of ['backlog', 'ready', 'running', 'done', 'merged', 'cancelled']) {
      task(`hidden_${status}`, 'r_active', status, { updatedAt: newest });
    }

    room('r_z_queued', { name: '只有排队任务', status: 'paused', updatedAt: recent });
    task('t_ready', 'r_z_queued', 'ready', { worktree: null, branch: null });
    task('t_backlog', 'r_z_queued', 'backlog');
    room('r_a_empty', { name: '待确认的草稿', updatedAt: recent });
    room('r_old_plan', { name: '较早的计划', status: 'planning' });

    room('r_archived_plan', { status: 'archived' });
    room('r_archived_tasks', { status: 'archived' });
    task('t_archived_problem', 'r_archived_tasks', 'failed', { updatedAt: newest });
    task('t_archived_result', 'r_archived_tasks', 'approved', { updatedAt: newest });
    task('t_orphan', 'r_missing', 'review', { updatedAt: newest });
    room('r_finished');
    task('t_finished', 'r_finished', 'done');
    room('r_branched');
    task('t_branched', 'r_branched', 'ready', { branch: 'devhub/unfinished' });
    room('r_worktree');
    task('t_worktree', 'r_worktree', 'backlog', { worktree: 'existing-worktree' });

    for (const [id, planJson] of [
      ['malformed', '{"tasks":[{}]'],
      ['null', 'null'],
      ['array', '[{}]'],
      ['primitive', '42'],
      ['no_tasks', '{"draft":true}'],
      ['empty_tasks', '{"tasks":[]}'],
      ['wrong_tasks', '{"tasks":{"title":"不是数组"}}'],
      ['empty_string', ''],
    ]) room(`r_${id}`, { planJson, updatedAt: newest });

    const taskItem = (taskId, title, kind, status, updatedAt) => ({
      id: `task:${taskId}`, roomId: 'r_active', roomName: '正在处理的会话',
      taskId, title, kind, status, updatedAt,
    });
    const planItem = (roomId, title, updatedAt) => ({
      id: `plan:${roomId}`, roomId, roomName: title, taskId: null,
      title, kind: 'plan', status: 'planning', updatedAt,
    });
    const expected = [
      taskItem('t_a_changes', '按意见修改', 'problem', 'changes_requested', recent),
      taskItem('t_z_escalated', '处理升级', 'problem', 'escalated', recent),
      taskItem('t_failed', '检查失败原因', 'problem', 'failed', old),
      planItem('r_a_empty', '待确认的草稿', recent),
      planItem('r_z_queued', '只有排队任务', recent),
      planItem('r_old_plan', '较早的计划', old),
      taskItem('t_newest_review', '查看最新成果', 'result', 'review', newest),
      taskItem('t_a_approved', '合并已通过成果', 'result', 'approved', recent),
      taskItem('t_z_review', '查看另一项成果', 'result', 'review', recent),
    ];
    for (let read = 0; read < 2; read++) {
      const state = await readState();
      assert.deepEqual(state.inbox, expected);
      assert.deepEqual(state.running, []);
    }
  });
});
