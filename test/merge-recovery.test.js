import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const engineUrl = new URL('../server/engine.js', import.meta.url).href;
const storeUrl = new URL('../server/store.js', import.meta.url).href;
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], {
  encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
}).trim();

// Exercise a real Git/SQLite failure across two distinct application processes.
// Only isolated temporary data is opened; no worker or installed CLI is invoked.
test('a committed squash survives database failure and restart without a duplicate commit', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'devhub-merge-recovery-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const repo = join(directory, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'commit.gpgsign', 'false');
  git(repo, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'README.md'), 'initial\n');
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=DevHub', '-c', 'user.email=devhub@local', 'commit', '-m', 'initial');
  const baseSha = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-b', 'feature');
  writeFileSync(join(repo, 'result.txt'), 'pinned result\n');
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=DevHub', '-c', 'user.email=devhub@local', 'commit', '-m', 'result');
  const resultSha = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', 'main');
  const data = join(directory, 'data');
  const header = `
    import assert from 'node:assert/strict';
    import { execFileSync } from 'node:child_process';
    import { openStore, get, run } from ${JSON.stringify(storeUrl)};
    import { mergeTask } from ${JSON.stringify(engineUrl)};
    const repo = ${JSON.stringify(repo)};
    const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding:'utf8', windowsHide:true }).trim();
    openStore();
  `;
  function application(source) {
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', header + source], {
      env: { ...process.env, DEVHUB_DATA: data }, encoding: 'utf8', windowsHide: true, timeout: 25_000,
    });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stdout + child.stderr);
  }
  application(`
    run("INSERT INTO rooms (id,name,repo_path,base_branch,status,created_at,updated_at) VALUES ('r','Recovery',?,'main','paused','now','now')", [repo]);
    run("INSERT INTO tasks (id,room_id,key,title,status,branch,base_sha,result_sha,diff_stat,created_at,updated_at) VALUES ('t1','r','T1','Pinned result','review','feature',?,?,'result.txt | 1 +','now','now')", [${JSON.stringify(baseSha)}, ${JSON.stringify(resultSha)}]);
    run("INSERT INTO tasks (id,room_id,key,title,status,deps_json,created_at,updated_at) VALUES ('t2','r','T2','Downstream','backlog',?,'now','now')", [JSON.stringify(['T1'])]);
    run("CREATE TRIGGER fail_merge_status BEFORE UPDATE OF status ON tasks WHEN NEW.status='merged' BEGIN SELECT RAISE(ABORT, 'fixture merge status'); END");
    await assert.rejects(mergeTask('t1', {resultSha:${JSON.stringify(resultSha)}}), /fixture merge status/);
    assert.notEqual(git('rev-parse','HEAD'), ${JSON.stringify(baseSha)}, 'Git must already have committed before the DB failure');
    assert.equal(git('rev-list','--count','HEAD'), '2');
    assert.equal(git('status','--porcelain'), '');
    assert.equal(get("SELECT status FROM tasks WHERE id='t1'").status, 'review');
    assert.equal(get("SELECT status FROM tasks WHERE id='t2'").status, 'backlog');
    assert.equal(get("SELECT COUNT(*) AS n FROM events WHERE type='task.merged'").n, 0);
    run('DROP TRIGGER fail_merge_status');
  `);
  const mergedSha = git(repo, 'rev-parse', 'HEAD');
  assert.equal(readFileSync(join(repo, 'result.txt'), 'utf8'), 'pinned result\n');
  // A new process opens the same persisted database and retries the fixed result.
  application(`
    const result = await mergeTask('t1', {resultSha:${JSON.stringify(resultSha)}});
    assert.equal(result.ok, true);
    assert.equal(result.resultSha, ${JSON.stringify(resultSha)});
    assert.equal(get("SELECT status FROM tasks WHERE id='t1'").status, 'merged');
    assert.equal(get("SELECT status FROM tasks WHERE id='t2'").status, 'ready');
    assert.equal(get("SELECT result_sha FROM tasks WHERE id='t1'").result_sha, ${JSON.stringify(resultSha)});
    assert.equal(get("SELECT COUNT(*) AS n FROM events WHERE type='task.merged'").n, 1);
    assert.equal(git('rev-parse','HEAD'), ${JSON.stringify(mergedSha)}, 'retry must not create an empty or duplicate commit');
    assert.equal(git('rev-list','--count','HEAD'), '2');
    assert.equal(git('status','--porcelain'), '');
    assert.equal(git('rev-parse','feature'), ${JSON.stringify(resultSha)});
  `);
});
