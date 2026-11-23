import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function withTempApi(t, check) {
  const data = mkdtempSync(join(tmpdir(), 'devhub-log-test-'));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const storeUrl = new URL('../server/store.js', import.meta.url).href;
  const apiUrl = new URL('../server/api.js', import.meta.url).href;
  const source = `
    import assert from 'node:assert/strict';
    import { join } from 'node:path';
    import { mkdir, open, writeFile } from 'node:fs/promises';
    import { openStore, run, get, LOGS } from ${JSON.stringify(storeUrl)};
    import { handleApi } from ${JSON.stringify(apiUrl)};
    openStore();

    const stamp = '2026-11-20T00:00:00.000Z';
    function putRun(id, taskId, fields = {}) {
      run('INSERT INTO runs (id, task_id, member_id, status, error, exit_code, started_at, ended_at, log_path) VALUES (?,?,?,?,?,?,?,?,?)', [
        id, taskId, 'member-fixture', fields.status ?? 'completed', fields.error ?? '',
        fields.exitCode ?? null, fields.startedAt ?? stamp, fields.endedAt ?? null,
        fields.path ?? '',
      ]);
    }
    async function readLog(taskId) {
      run('PRAGMA query_only=ON');
      const before = get('SELECT total_changes() AS count').count;
      let status;
      let body;
      const res = { writeHead(code) { status = code; }, end(payload) { body = payload; } };
      try {
        const handled = await handleApi({ method: 'GET' }, res,
          new URL('http://127.0.0.1/api/tasks/' + taskId + '/log'));
        assert.equal(handled, true);
        assert.equal(status, 200, body);
        assert.equal(get('SELECT total_changes() AS count').count, before);
        const result = JSON.parse(body);
        assert.deepEqual(Object.keys(result).sort(), [
          'log', 'runId', 'status', 'error', 'exitCode', 'startedAt', 'endedAt', 'truncated', 'totalBytes', 'readError',
        ].sort());
        assert.ok(!JSON.stringify(result).includes(LOGS), 'must not leak the log directory');
        return result;
      } finally {
        run('PRAGMA query_only=OFF');
      }
    }
    await (${check.toString()})({ assert, join, mkdir, open, writeFile, putRun, readLog, LOGS, stamp });
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
    env: { ...process.env, DEVHUB_DATA: data }, encoding: 'utf8', windowsHide: true, timeout: 30_000,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stdout + child.stderr);
}

test('log endpoint preserves empty defaults, latest run metadata and read-only access', (t) => {
  withTempApi(t, async ({ assert, join, writeFile, putRun, readLog, LOGS, stamp }) => {
    assert.deepEqual(await readLog('no-run'), {
      log: '', runId: null, status: '', error: '', exitCode: null, startedAt: null, endedAt: null,
      truncated: false, totalBytes: 0, readError: '',
    });
    putRun('older', 'task', { startedAt: '2026-01-01T00:00:00.000Z' });
    putRun('tied-first', 'task', { status: 'completed', exitCode: 0 });
    putRun('tied-last', 'task', { status: 'failed', exitCode: 7, error: '工具登录已失效', endedAt: stamp });
    await writeFile(join(LOGS, 'tied-last.log'), '最近的输出\n');
    const latest = await readLog('task');
    assert.deepEqual(latest, {
      log: '最近的输出\n', runId: 'tied-last', status: 'failed', error: '工具登录已失效', exitCode: 7,
      startedAt: stamp, endedAt: stamp, truncated: false, totalBytes: Buffer.byteLength('最近的输出\n'), readError: '',
    });
    putRun('newer-time', 'task', { startedAt: '2027-01-01T00:00:00.000Z', status: 'running' });
    putRun('last-inserted-old', 'task', { startedAt: '2025-01-01T00:00:00.000Z' });
    const newest = await readLog('task');
    assert.equal(newest.runId, 'newer-time');
    assert.equal(newest.status, 'running');
  });
});

test('small UTF-8 logs preserve exact CRLF, blank lines and terminal newline', (t) => {
  withTempApi(t, async ({ assert, join, writeFile, putRun, readLog, LOGS }) => {
    const text = '中文与 emoji 🧭\r\n\r\n下一行\n最后一行\r\n';
    const path = join(LOGS, 'stored-custom-name.log');
    await writeFile(path, text);
    putRun('unicode', 'task', { path, status: 'completed', exitCode: 0 });
    const result = await readLog('task');
    assert.equal(result.log, text);
    assert.equal(result.totalBytes, Buffer.byteLength(text));
    assert.equal(result.truncated, false);
    assert.equal(result.readError, '');
    await writeFile(path, '');
    assert.equal((await readLog('task')).totalBytes, 0);
    assert.equal((await readLog('task')).log, '');
  });
});

test('blank stored paths expose active and interrupted fallback logs without changing run causes', (t) => {
  withTempApi(t, async ({ assert, join, writeFile, putRun, readLog, LOGS, stamp }) => {
    for (const status of ['running', 'interrupted', 'completed']) {
      const id = 'run-' + status;
      putRun(id, id, { status, error: status === 'interrupted' ? '服务重启中断了上次运行' : '' });
      await writeFile(join(LOGS, id + '.log'), '执行中的已落盘输出\n');
      const result = await readLog(id);
      assert.equal(result.log, '执行中的已落盘输出\n');
      assert.equal(result.status, status);
      assert.equal(result.exitCode, null);
      assert.equal(result.startedAt, stamp);
      assert.equal(result.endedAt, null);
      assert.equal(result.error, status === 'interrupted' ? '服务重启中断了上次运行' : '');
    }
  });
});

test('missing logs remain empty and genuine IO failures use readError, not run failure', (t) => {
  withTempApi(t, async ({ assert, join, mkdir, writeFile, putRun, readLog, LOGS }) => {
    putRun('missing-file', 'missing', { path: join(LOGS, 'absent.log'), status: 'failed', error: '上次工具失败', exitCode: 9 });
    const missing = await readLog('missing');
    assert.equal(missing.readError, '');
    assert.equal(missing.totalBytes, 0);
    assert.equal(missing.log, '');
    assert.equal(missing.error, '上次工具失败');
    const directory = join(LOGS, 'not-a-file');
    await mkdir(directory);
    putRun('directory-file', 'unreadable', { path: directory, status: 'running', error: '' });
    const unreadable = await readLog('unreadable');
    assert.equal(unreadable.readError, '无法读取运行日志，请重试。');
    assert.equal(unreadable.status, 'running');
    assert.equal(unreadable.error, '');
    assert.equal(unreadable.log, '');
    assert.equal(unreadable.truncated, false);
    assert.equal(unreadable.exitCode, null);
    assert.ok(!JSON.stringify(unreadable).includes(directory));
    // A nonempty missing stored path must not silently switch to another file.
    putRun('stored-path', 'prefer-stored', { path: join(LOGS, 'also-absent.log') });
    await writeFile(join(LOGS, 'stored-path.log'), 'not the selected log');
    assert.equal((await readLog('prefer-stored')).log, '');
  });
});

test('line tails keep the last 2000 logical lines and preserve their original endings', (t) => {
  withTempApi(t, async ({ assert, join, writeFile, putRun, readLog, LOGS }) => {
    const lines = Array.from({ length: 2005 }, (_, i) => '第' + i + '行');
    for (const newline of ['\n', '\r\n']) {
      for (const terminal of [false, true]) {
        const id = (newline.length === 1 ? 'lf' : 'crlf') + '-' + terminal;
        const text = lines.join(newline) + (terminal ? newline : '');
        await writeFile(join(LOGS, id + '.log'), text);
        putRun(id, id);
        const result = await readLog(id);
        assert.equal(result.log, lines.slice(-2000).join(newline) + (terminal ? newline : ''));
        assert.equal(result.totalBytes, Buffer.byteLength(text));
        assert.equal(result.truncated, true);
      }
    }
    const exact = 'x\n'.repeat(2000);
    await writeFile(join(LOGS, 'exact.log'), exact);
    putRun('exact', 'exact');
    assert.equal((await readLog('exact')).log, exact);
    assert.equal((await readLog('exact')).truncated, false);
  });
});

test('bounded byte tails skip partial first lines but retain a first line at an exact LF boundary', (t) => {
  withTempApi(t, async ({ assert, join, open, putRun, readLog, LOGS }) => {
    const size = 256 * 1024 * 1024;
    for (const preceding of ['x', '\n']) {
      const id = preceding === 'x' ? 'partial' : 'boundary';
      const file = await open(join(LOGS, id + '.log'), 'w');
      try {
        await file.truncate(size);
        const tail = Buffer.from('不完整前缀\r\n' + 'x'.repeat(131072 - Buffer.byteLength('不完整前缀\r\n')));
        await file.write(Buffer.from(preceding), 0, 1, size - 131072 - 1);
        await file.write(tail, 0, tail.length, size - 131072);
      } finally { await file.close(); }
      putRun(id, id);
      const result = await readLog(id);
      assert.equal(result.totalBytes, size);
      assert.equal(result.truncated, true);
      assert.ok(Buffer.byteLength(result.log) <= 131072);
      assert.equal(result.log.startsWith('不完整前缀'), preceding === '\n');
      assert.ok(!result.log.includes('\u0000'));
    }
  });
});

test('huge single Unicode lines retain a safe tail with and without a terminal LF', (t) => {
  withTempApi(t, async ({ assert, join, writeFile, putRun, readLog, LOGS }) => {
    for (const ending of ['', '\n', '\r\n']) {
      const id = 'huge-' + ending.length;
      const text = '前'.repeat(50001) + '界'.repeat(50001) + ending;
      await writeFile(join(LOGS, id + '.log'), text);
      putRun(id, id);
      const result = await readLog(id);
      assert.equal(result.totalBytes, Buffer.byteLength(text));
      assert.equal(result.truncated, true);
      assert.ok(result.log.length > 1000, 'retain available huge-line content');
      assert.ok(Buffer.byteLength(result.log) <= 131072);
      assert.ok(!result.log.includes('\ufffd'), 'byte seek must not invent a leading replacement');
      assert.ok(result.log.endsWith('界' + ending));
    }
  });
});
