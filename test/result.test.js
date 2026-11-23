import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import * as G from '../server/git.js';
import { regression } from './scheduler.test.js';

regression('成功执行冻结完整成果 SHA，重跑失败或取消保留上一份成果但不能合并', async () => {
  const h = await createHarness();
  const first = h.api.startTask('t1');
  await settle();
  h.workers[0].finish();
  await first;
  assert.equal(h.tasks.get('t1').result_sha, 'a'.repeat(40));
  assert.equal(h.tasks.get('t1').status, 'review');
  h.api.rejectTask('t1', '继续修改');
  const rerun = h.api.startTask('t1');
  assert.equal(h.tasks.get('t1').result_sha, 'a'.repeat(40));
  h.headSha = 'b'.repeat(40);
  await settle();
  h.workers[1].finish({ code: 1, error: '执行失败' });
  await rerun;
  assert.equal(h.tasks.get('t1').status, 'failed');
  assert.equal(h.tasks.get('t1').result_sha, 'a'.repeat(40));
  await assert.rejects(h.api.mergeTask('t1'), /先完成运行/);
  await assert.rejects(h.api.reviewTask('t1'), /没有可自动评审/);
  const cancelled = h.api.startTask('t1');
  await settle();
  h.api.cancelTask('t1');
  h.workers[2].finish({ code: 1 });
  await cancelled;
  assert.equal(h.tasks.get('t1').status, 'cancelled');
  assert.equal(h.tasks.get('t1').result_sha, 'a'.repeat(40));
  await assert.rejects(h.api.mergeTask('t1'), /先完成运行/);
});

regression('Diff 和合并使用固定 SHA，忽略后来移动的分支、脏文件和过期统计', async () => {
  const sha = 'a'.repeat(40);
  const h = await createHarness({ tasks: [{ status: 'review', worktree: 'wt', branch: 'feature', base_sha: 'base', result_sha: sha, diff_stat: '' }] });
  h.headSha = 'b'.repeat(40);
  h.tracked = ' M change.txt';
  const result = await h.api.taskDiff('t1');
  assert.equal(result.resultSha, sha);
  assert.equal(result.diff, h.resultDiff);
  const merged = await h.api.mergeTask('t1', { resultSha: result.resultSha });
  assert.equal(merged.resultSha, sha);
  assert.equal(h.mergeCalls[0].sha, sha);
  assert.equal(h.commitCalls.length, 0);
  assert.equal(h.tasks.get('t1').status, 'merged');
});

regression('携带旧成果 SHA 的评审和合并要求刷新，不启动 CLI 或写合并结果', async () => {
  const sha = 'a'.repeat(40);
  const h = await createHarness({ tasks: [{ status: 'review', worktree: 'wt', branch: 'feature', base_sha: 'base', result_sha: sha }] });
  for (const expected of ['b'.repeat(40), '', null]) {
    await assert.rejects(h.api.reviewTask('t1', { resultSha: expected }), (error) => error.statusCode === 409 && /刷新 Diff/.test(error.message));
    await assert.rejects(h.api.mergeTask('t1', { resultSha: expected }), (error) => error.statusCode === 409 && /刷新 Diff/.test(error.message));
  }
  assert.equal(h.tasks.get('t1').status, 'review');
  assert.equal(h.workers.length, 0);
  assert.equal(h.mergeCalls.length, 0);
  await h.api.mergeTask('t1');
  assert.equal(h.mergeCalls[0].sha, sha);
});

regression('旧待审任务第一次查看固定分支提交，后续分支移动不会换掉成果', async () => {
  const h = await createHarness({ tasks: [{ status: 'review', worktree: 'wt', branch: 'feature', base_sha: 'base', result_sha: '' }] });
  h.headSha = 'b'.repeat(40);
  h.tracked = ' M change.txt';
  const legacy = await h.api.taskDiff('t1');
  assert.equal(legacy.resultSha, 'b'.repeat(40));
  assert.equal(h.tasks.get('t1').result_sha, legacy.resultSha);
  h.headSha = 'c'.repeat(40);
  assert.equal((await h.api.taskDiff('t1')).resultSha, legacy.resultSha);
  await h.api.mergeTask('t1', { resultSha: legacy.resultSha });
  assert.equal(h.mergeCalls[0].sha, legacy.resultSha);
  assert.equal(h.commitCalls.length, 0);
  const pending = await createHarness({ tasks: [{ status: 'failed', branch: 'feature', worktree: 'wt', base_sha: 'base' }] });
  assert.equal((await pending.api.taskDiff('t1')).resultSha, '');
  assert.equal(pending.tasks.get('t1').result_sha, '');
});

regression('旧成果首次固定时同步占用任务，其他操作等待该次读取完成', async () => {
  const gate = deferred();
  const h = await createHarness({ tasks: [{ status: 'review', worktree: 'wt', branch: 'feature', base_sha: 'base' }], hooks: { resolve: () => gate.promise } });
  const reading = h.api.taskDiff('t1');
  await assert.rejects(h.api.reviewTask('t1'), /正在读取成果/);
  await assert.rejects(h.api.mergeTask('t1'), /正在读取成果/);
  assert.throws(() => h.api.cancelTask('t1'), /正在合并或读取成果/);
  gate.resolve('a'.repeat(40));
  assert.equal((await reading).resultSha, 'a'.repeat(40));
  await h.api.mergeTask('t1');
  assert.equal(h.tasks.get('t1').status, 'merged');
});

regression('任务从读取第一步起互斥：运行、评审、合并、取消和归档不能交错', async () => {
  const gate = deferred();
  const h = await createHarness({ tasks: [{ status: 'changes_requested', worktree: 'wt', branch: 'feature', base_sha: 'base', result_sha: 'a'.repeat(40) }], hooks: { resolve: () => gate.promise } });
  const review = h.api.reviewTask('t1');
  await assert.rejects(h.api.startTask('t1'), /正在评审/);
  await assert.rejects(h.api.mergeTask('t1'), /正在评审/);
  await assert.rejects(h.api.reviewTask('t1'), /正在评审/);
  assert.throws(() => h.api.rejectTask('t1', '修改'), /正在评审/);
  assert.throws(() => h.api.archiveRoom('r'), /不能归档/);
  h.api.cancelTask('t1');
  gate.resolve('a'.repeat(40));
  await assert.rejects(review, /取消/);
  assert.equal(h.tasks.get('t1').status, 'cancelled');
  assert.equal(h.workers.length, 0);
  const mergeGate = deferred();
  const queued = await createHarness({ tasks: [{ status: 'review', worktree: 'wt', branch: 'feature', base_sha: 'base', result_sha: 'a'.repeat(40) }], hooks: { merge: () => mergeGate.promise } });
  const merge = queued.api.mergeTask('t1');
  await settle();
  await assert.rejects(queued.api.reviewTask('t1'), /正在合并/);
  await assert.rejects(queued.api.startTask('t1'), /正在合并/);
  assert.throws(() => queued.api.cancelTask('t1'), /正在合并/);
  assert.throws(() => queued.api.retryTask('t1'), /正在合并/);
  mergeGate.resolve();
  await merge;
  assert.equal(queued.tasks.get('t1').status, 'merged');
});

regression('评审失败关闭：非零退出、非法结论、改文件、改提交不能写 approve', async () => {
  for (const failure of ['exit', 'json', 'tracked', 'head']) {
    const h = await createHarness({ tasks: [{ status: 'review', worktree: 'wt', branch: 'feature', base_sha: 'base', result_sha: 'a'.repeat(40) }] });
    const review = h.api.reviewTask('t1');
    await settle();
    assert.equal(h.workers.length, 1);
    if (failure === 'tracked') h.tracked = ' M change.txt';
    if (failure === 'head') h.headSha = 'b'.repeat(40);
    h.workers[0].finish({ code: failure === 'exit' ? 2 : 0, error: '模拟评审失败', text: failure === 'json' ? 'not json' : '{"verdict":"approve","blocking":[]}' });
    await assert.rejects(review, /自动评审失败/);
    assert.equal(h.reviews.length, 0);
    assert.equal(h.tasks.get('t1').status, 'review');
  }
});

regression('工作区已偏离固定成果时自动评审失败，恢复后可评审同一份 SHA', async () => {
  const h = await createHarness({ tasks: [{ status: 'review', worktree: 'wt', branch: 'feature', base_sha: 'base', result_sha: 'a'.repeat(40) }] });
  h.tracked = ' M change.txt';
  await assert.rejects(h.api.reviewTask('t1'), /工作区已偏离固定成果/);
  assert.equal(h.workers.length, 0);
  h.tracked = '';
  const review = h.api.reviewTask('t1');
  await settle();
  h.workers[0].finish({ text: '{"verdict":"approve","blocking":[],"notes":"通过"}' });
  const result = await review;
  assert.equal(result.resultSha, 'a'.repeat(40));
  assert.equal(h.tasks.get('t1').status, 'approved');
  assert.equal(JSON.parse(h.reviews[0].payload).resultSha, 'a'.repeat(40));
});

regression('读取成果或合并失败释放互斥，后续可重试而不污染任务状态', async () => {
  let attempts = 0;
  const h = await createHarness({ tasks: [{ status: 'review', worktree: 'wt', branch: 'feature', base_sha: 'base', result_sha: 'a'.repeat(40) }], hooks: { merge: () => { if (++attempts === 1) throw new Error('基准仓库有改动，请先处理后重试'); } } });
  await assert.rejects(h.api.mergeTask('t1'), /请先处理/);
  assert.equal(h.tasks.get('t1').status, 'review');
  await h.api.mergeTask('t1');
  assert.equal(h.tasks.get('t1').status, 'merged');
});

const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

test('真实临时 Git：固定提交 diff 和 squash 不包含工作区后来的修改或测试文件', async (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'devhub-result-git-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, 'init');
  git(repo, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'change.txt'), 'base\n');
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=DevHub', '-c', 'user.email=devhub@local', 'commit', '-m', 'initial');
  const baseBranch = git(repo, 'rev-parse', '--abbrev-ref', 'HEAD');
  const base = await G.commitSha(repo);
  // Keep the fixture worktree outside the repository so the base remains clean.
  const wtRoot = mkdtempSync(join(tmpdir(), 'devhub-result-wt-'));
  t.after(() => rmSync(wtRoot, { recursive: true, force: true }));
  const wt = join(wtRoot, 'task');
  git(repo, 'worktree', 'add', '-b', 'feature', wt, base);
  writeFileSync(join(wt, 'change.txt'), 'reviewed\n');
  await G.commitAll(wt, 'reviewed task');
  const result = await G.commitSha(wt);
  writeFileSync(join(wt, 'change.txt'), 'later unreviewed change\n');
  writeFileSync(join(wt, 'test-output.tmp'), 'test output\n');
  const diff = await G.diffCommit(repo, base, result);
  assert.match(diff, /reviewed/);
  assert.doesNotMatch(diff, /later unreviewed|test-output/);
  await G.mergeSquash(repo, baseBranch, result, 'merge reviewed task');
  assert.equal(readFileSync(join(repo, 'change.txt'), 'utf8'), 'reviewed\n');
  assert.doesNotMatch(git(repo, 'ls-tree', '-r', '--name-only', 'HEAD'), /test-output/);
  assert.match(await G.statusPorcelain(wt), /test-output\.tmp/);
  assert.match(await G.trackedStatus(wt), /change\.txt/);
  writeFileSync(join(repo, 'local.tmp'), 'keep me\n');
  await assert.rejects(G.mergeSquash(repo, baseBranch, result, 'reject dirty base'), /请先.*处理/);
  assert.equal(readFileSync(join(repo, 'local.tmp'), 'utf8'), 'keep me\n');
});
