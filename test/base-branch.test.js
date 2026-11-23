import assert from 'node:assert/strict';
import { regression } from './scheduler.test.js';

// 说明：regression() 会把用例函数体放进子进程执行，辅助函数必须写在用例内部。

regression('旧会话的基准分支不存在时回退到仓库当前分支并持久化', async () => {
  const h = await createHarness({
    rooms: [{ status: 'running', base_branch: 'main' }],
    tasks: [{}],
    hooks: {
      currentBranch: async () => 'master',
      revParse: async (repo, ref) => {
        if (ref === 'main') throw new Error("fatal: ambiguous argument 'main'");
        return 'a'.repeat(40);
      },
    },
  });
  const running = h.api.startTask('t1');
  await settle();
  h.workers[0].finish();
  await running;
  assert.equal(h.rooms.get('r').base_branch, 'master');
  assert.equal(h.tasks.get('t1').base_sha, 'a'.repeat(40));
  const updated = h.events.find((event) => event.type === 'room.updated');
  assert.equal(updated.payload.baseBranch, 'master');
  assert.equal(updated.payload.previous, 'main');
  assert.equal(h.tasks.get('t1').status, 'review');
});

regression('基准分支和仓库当前分支都解析不到时给出可操作错误且任务失败', async () => {
  const h = await createHarness({
    rooms: [{ status: 'running', base_branch: 'main' }],
    tasks: [{}],
    hooks: {
      currentBranch: async () => 'main',
      revParse: async () => { throw new Error('fatal: bad revision'); },
    },
  });
  await assert.rejects(h.api.startTask('t1'), /无法确定基准分支/);
  assert.equal(h.tasks.get('t1').status, 'failed');
  assert.equal(h.rooms.get('r').base_branch, 'main');
  const error = h.events.find((event) => event.type === 'task.error');
  assert.ok(error.payload.error.includes('无法确定基准分支'));
  assert.ok(error.payload.error.includes('仓库当前分支是「main」'));
});
