import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as G from '../server/git.js';

const git = (repo, ...args) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'devhub-test-'));
  execFileSync('git', ['-C', dir, 'init'], { stdio: 'ignore' });
  writeFileSync(join(dir, 'README.md'), '# test\n', 'utf8');
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.name=DevHub', '-c', 'user.email=devhub@local', 'commit', '-m', 'init');
  return dir;
}

test('trackedStatus 忽略未跟踪文件，但仍能发现已跟踪文件的改动', async () => {
  const repo = makeRepo();
  try {
    writeFileSync(join(repo, 'artifact.tmp'), 'artifact\n', 'utf8');
    assert.match(await G.statusPorcelain(repo), /artifact\.tmp/);
    assert.equal(await G.trackedStatus(repo), '');

    writeFileSync(join(repo, 'README.md'), '# changed\n', 'utf8');
    assert.match(await G.trackedStatus(repo), /README\.md/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('mergeSquash 把分支压成一个提交并保留基准分支历史', async () => {
  const repo = makeRepo();
  try {
    const base = git(repo, 'rev-parse', '--abbrev-ref', 'HEAD');
    git(repo, 'checkout', '-b', 'feature');
    writeFileSync(join(repo, 'feature.txt'), 'feature\n', 'utf8');
    git(repo, 'add', '-A');
    git(repo, '-c', 'user.name=DevHub', '-c', 'user.email=devhub@local', 'commit', '-m', 'feature work');
    git(repo, 'checkout', base);

    await G.mergeSquash(repo, base, 'feature', 'merge feature');

    const log = git(repo, 'log', '--oneline', base);
    assert.match(log, /merge feature/);
    assert.match(log, /init/);
    assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), base);
    assert.equal(await G.statusPorcelain(repo), '');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
