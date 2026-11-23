import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addPlanTask, createPlanDraft, removePlanTask, serializePlan, suggestTaskTitle, suggestTaskType } from '../web/plan-draft.js';

test('automatic task title trims polite wrappers and keeps one concise action', () => {
  assert.equal(suggestTaskTitle('请帮我在订单列表增加筛选功能。'), '在订单列表增加筛选功能');
  assert.equal(suggestTaskTitle('\n\n  编写快速上手文档\n补充例子'), '编写快速上手文档');
  assert.equal([...suggestTaskTitle('编写'.repeat(30))].length, 36);
});

test('automatic task type chooses document or research from plain description', () => {
  assert.equal(suggestTaskType('编写快速上手文档'), 'document');
  assert.equal(suggestTaskType('比较三个 API 调研报告'), 'research');
  assert.equal(suggestTaskType('给按钮增加 loading 状态'), 'code');
});

test('deleting and adding plan tasks preserves edited content and dependency targets', () => {
  const draft = createPlanDraft({ tasks: [
    { title: '检查现状' }, { title: '移除我' },
    { title: '实现筛选', spec: '保留说明', dependsOn: [1, 2] },
    { title: '验收', dependsOn: [3] },
  ] }, '协作助手');
  draft.tasks[2].title = '实现新版筛选';
  removePlanTask(draft, 2);
  const final = addPlanTask(draft, '协作助手');
  final.title = '编写说明';
  final.dependencies.push(4);
  const plan = serializePlan(draft);
  assert.deepEqual(plan.tasks.map((task) => task.dependsOn), [[], [1], [2], [3]]);
  assert.equal(plan.tasks[1].title, '实现新版筛选');
  assert.equal(plan.tasks[1].spec, '保留说明');
  assert.equal(plan.tasks[1].owner, '协作助手');
});

test('invalid dependencies stay visible for correction and never silently target another task', () => {
  const original = { tasks: [null, { title: '验证', dependsOn: [1, 2, 3, '1', 1] }] };
  const before = JSON.stringify(original);
  const draft = createPlanDraft(original, '协作助手');
  assert.equal(draft.tasks[1].invalidDependencies, true);
  assert.deepEqual(draft.tasks[1].dependencies, [1]);
  assert.equal(JSON.stringify(original), before);
});

test('automatic suggestions preserve explicit owner, type and acceptance', () => {
  const draft = createPlanDraft({ tasks: [{
    spec: '请帮我编写说明文档。', owner: '自选成员', type: 'research', acceptance: ['验证链接'],
  }] }, '协作助手');
  assert.equal(draft.tasks[0].title, '编写说明文档');
  assert.equal(draft.tasks[0].owner, '自选成员');
  assert.equal(draft.tasks[0].type, 'research');
  assert.deepEqual(draft.tasks[0].acceptance, ['验证链接']);
});
