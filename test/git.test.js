import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as G from '../server/git.js';

const git = (repo, ...args) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'devhub-test-'));
  execFileSync('git', ['-C', dir, 'init'], { stdio: 'ignore' });
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'core.autocrlf', 'false');
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

    // Retry remains harmless even after another base-branch commit was added.
    writeFileSync(join(repo, 'later.txt'), 'later work\n');
    git(repo, 'add', '-A');
    git(repo, '-c', 'user.name=DevHub', '-c', 'user.email=devhub@local', 'commit', '-m', 'later work');
    const head = git(repo, 'rev-parse', 'HEAD');
    const count = git(repo, 'rev-list', '--count', 'HEAD');
    await G.mergeSquash(repo, base, 'feature', 'retry feature');
    assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
    assert.equal(git(repo, 'rev-list', '--count', 'HEAD'), count);
    assert.equal(readFileSync(join(repo, 'later.txt'), 'utf8'), 'later work\n');
    assert.equal(await G.statusPorcelain(repo), '');
    assert.equal(existsSync(join(repo, '.git', 'SQUASH_MSG')), false);

    writeFileSync(join(repo, 'keep.tmp'), 'uncommitted user work\n');
    await assert.rejects(G.mergeSquash(repo, base, 'feature', 'dirty retry'), /仓库有未提交/);
    assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
    assert.equal(readFileSync(join(repo, 'keep.tmp'), 'utf8'), 'uncommitted user work\n');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('mergeSquash 的真实签名失败仍报错，清理后可重试', async () => {
  const repo = makeRepo();
  try {
    const base = git(repo, 'rev-parse', '--abbrev-ref', 'HEAD');
    const before = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-b', 'feature');
    writeFileSync(join(repo, 'feature.txt'), 'feature\n');
    git(repo, 'add', '-A');
    git(repo, '-c', 'user.name=DevHub', '-c', 'user.email=devhub@local', 'commit', '-m', 'feature');
    git(repo, 'checkout', base);
    git(repo, 'config', 'commit.gpgsign', 'true');
    git(repo, 'config', 'gpg.program', 'devhub-fixture-missing-gpg');
    await assert.rejects(G.mergeSquash(repo, base, 'feature', 'signed merge'), /合并提交失败/);
    assert.equal(git(repo, 'rev-parse', 'HEAD'), before);
    assert.equal(await G.statusPorcelain(repo), '');
    assert.equal(existsSync(join(repo, 'feature.txt')), false);
    git(repo, 'config', 'commit.gpgsign', 'false');
    await G.mergeSquash(repo, base, 'feature', 'retry merge');
    assert.notEqual(git(repo, 'rev-parse', 'HEAD'), before);
    assert.equal(readFileSync(join(repo, 'feature.txt'), 'utf8'), 'feature\n');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('mergeSquash 冲突回退保留基准分支内容', async () => {
  const repo = makeRepo();
  try {
    const base = git(repo, 'rev-parse', '--abbrev-ref', 'HEAD');
    git(repo, 'checkout', '-b', 'feature');
    writeFileSync(join(repo, 'README.md'), 'feature change\n');
    git(repo, 'add', '-A');
    git(repo, '-c', 'user.name=DevHub', '-c', 'user.email=devhub@local', 'commit', '-m', 'feature');
    git(repo, 'checkout', base);
    writeFileSync(join(repo, 'README.md'), 'base change\n');
    git(repo, 'add', '-A');
    git(repo, '-c', 'user.name=DevHub', '-c', 'user.email=devhub@local', 'commit', '-m', 'base');
    const before = git(repo, 'rev-parse', 'HEAD');
    await assert.rejects(G.mergeSquash(repo, base, 'feature', 'conflicting merge'), /合并冲突/);
    assert.equal(git(repo, 'rev-parse', 'HEAD'), before);
    assert.equal(await G.statusPorcelain(repo), '');
    assert.equal(readFileSync(join(repo, 'README.md'), 'utf8'), 'base change\n');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
