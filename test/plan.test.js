import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { validatePlan, PlanValidationError } from '../server/plan.js';

const members = [{ id: 'm1', name: '工程师', enabled: true }];
const flow = { nodes: [{ id: 'p1', type: 'phase', name: '执行' }] };
const validate = (plan) => validatePlan(plan, { members, flow });

test('计划允许省略可选字段，保留向前引用的整数依赖', () => {
  const plan = validate({
    tasks: [{ title: '下游', dependsOn: [2], phase: '' }, { title: '上游' }],
    validationErrors: ['旧诊断'],
  });
  assert.deepEqual(plan.tasks[0].dependsOn, [2]);
  assert.deepEqual(plan.tasks[1].dependsOn, []);
  assert.equal(plan.tasks[0].owner, '工程师');
  assert.equal(plan.tasks[0].type, 'code');
  assert.equal(plan.tasks[0].spec, '');
  assert.deepEqual(plan.tasks[0].acceptance, []);
  assert.deepEqual(plan.decisions, []);
  assert.equal(plan.validationErrors, undefined);
});

test('拒绝错误类型、未知、自身和循环依赖，不修改原始草稿', () => {
  const cases = [
    [{ tasks: [{ title: '任务', dependsOn: '1' }] }, /dependsOn.*整数数组/],
    [{ tasks: [{ title: '任务', dependsOn: null }] }, /dependsOn.*整数数组/],
    [{ tasks: [{ title: '任务', dependsOn: ['1'] }] }, /正整数/],
    [{ tasks: [{ title: '任务', dependsOn: [0] }] }, /正整数/],
    [{ tasks: [{ title: '任务', dependsOn: [1.5] }] }, /正整数/],
    [{ tasks: [{ title: '任务', dependsOn: [2] }] }, /T2 不存在/],
    [{ tasks: [{ title: '任务', dependsOn: [1] }] }, /依赖自身/],
    [{ tasks: [{ title: '甲', dependsOn: [2] }, { title: '乙', dependsOn: [1] }] }, /存在循环/],
    [{ tasks: [{ title: '甲' }, { title: '乙', dependsOn: [1, 1] }] }, /重复依赖/],
  ];
  for (const [draft, expected] of cases) {
    const original = structuredClone(draft);
    assert.throws(() => validate(draft), expected);
    assert.deepEqual(draft, original);
  }
});

test('完整校验任务、精确负责人、阶段和决策结构', () => {
  for (const draft of [
    null,
    { tasks: [] },
    { tasks: [null] },
    { tasks: [{ title: '' }] },
    { tasks: [{ title: '任务', owner: '工程' }] },
    { tasks: [{ title: '任务', type: 'unknown' }] },
    { tasks: [{ title: '任务', spec: {} }] },
    { tasks: [{ title: '任务', acceptance: '测试通过' }] },
    { tasks: [{ title: '任务', phase: '不存在的阶段' }] },
    { tasks: [{ title: '任务' }], decisions: [null] },
  ]) assert.throws(() => validate(draft), PlanValidationError);
  assert.throws(() => validatePlan({ tasks: [{ title: '任务', owner: '工程师' }] }, {
    members: [{ ...members[0], enabled: false }], flow,
  }), /已停用/);
  assert.throws(() => validatePlan({ tasks: [{ title: '任务', owner: '工程师' }] }, {
    members: [members[0], { ...members[0], id: 'm2' }], flow,
  }), /同名成员/);
});

// Import a temporary server copy in a child so SQLite never opens the user's .data,
// no worker is launched, and Windows can remove the database after the child exits.
function isolatedStore(t, body) {
  const fixture = mkdtempSync(join(tmpdir(), 'devhub-plan-test-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  cpSync(new URL('../server/', import.meta.url), join(fixture, 'server'), { recursive: true });
  writeFileSync(join(fixture, 'package.json'), '{"type":"module"}', 'utf8');
  const setup = `
    import assert from 'node:assert/strict';
    import { all, get, run, bus } from './server/store.js';
    import { applyPlan } from './server/engine.js';
    const ts = '2026-01-01T00:00:00.000Z';
    const roomId = 'room';
    const flow = ${JSON.stringify(flow)};
    run('INSERT INTO rooms (id, name, repo_path, flow_json, plan_json, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
      [roomId, '测试会话', 'unused', JSON.stringify(flow), '{"draft":"保留"}', 'planning', ts, ts]);
    run('INSERT INTO members (id, room_id, name, worker) VALUES (?,?,?,?)', ['m1', roomId, '工程师', 'codex']);
    run('INSERT INTO tasks (id, room_id, key, title, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
      ['old-task', roomId, 'T1', '原任务', 'ready', ts, ts]);
    run('INSERT INTO decisions (id, room_id, text, created_at) VALUES (?,?,?,?)', ['old-decision', roomId, '原决策', ts]);
    const events = [];
    bus.on('event', (event) => events.push(event));
    const snapshot = () => ({
      tasks: all('SELECT * FROM tasks ORDER BY id'),
      decisions: all('SELECT * FROM decisions ORDER BY id'),
      room: get('SELECT * FROM rooms WHERE id=?', [roomId]),
      events: all('SELECT * FROM events ORDER BY id'),
    });
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', setup + body], {
    cwd: fixture, encoding: 'utf8', windowsHide: true, timeout: 15_000,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stdout + child.stderr);
}

test('应用无效计划不删除旧任务、不新增决策、不清除草稿', (t) => {
  isolatedStore(t, `
    const before = snapshot();
    for (const invalid of [
      { tasks: [{ title: '新任务', dependsOn: [2] }] },
      { tasks: [{ title: '甲', dependsOn: [2] }, { title: '乙', dependsOn: [1] }] },
      { tasks: [{ title: '新任务' }], decisions: [null] },
    ]) {
      assert.throws(() => applyPlan(roomId, invalid));
      assert.deepEqual(snapshot(), before);
    }
    assert.equal(events.length, 0);
  `);
});

test('保存后段失败时事务回滚任务、决策和会话草稿', (t) => {
  isolatedStore(t, `
    run("CREATE TRIGGER reject_plan_update BEFORE UPDATE ON rooms WHEN NEW.plan_json = '' BEGIN SELECT RAISE(ABORT, 'simulated plan write failure'); END");
    const before = snapshot();
    assert.throws(() => applyPlan(roomId, {
      tasks: [{ title: '新上游' }, { title: '新下游', dependsOn: [1] }],
      decisions: ['新决策'],
    }), /simulated plan write failure/);
    assert.deepEqual(snapshot(), before);
    assert.equal(events.length, 0);
  `);
});

test('有效计划完整替换并保存依赖，只有无依赖任务就绪', (t) => {
  isolatedStore(t, `
    const state = applyPlan(roomId, {
      tasks: [{ title: '新上游' }, { title: '新下游', dependsOn: [1], phase: '' }],
      decisions: ['新决策'],
    });
    assert.equal(state.tasks.length, 2);
    const first = state.tasks.find((task) => task.key === 'T1');
    const second = state.tasks.find((task) => task.key === 'T2');
    assert.equal(first.title, '新上游');
    assert.equal(first.owner_id, 'm1');
    assert.equal(first.status, 'ready');
    assert.equal(second.status, 'backlog');
    assert.deepEqual(second.deps, ['T1']);
    assert.equal(state.room.plan_json, '');
    assert.deepEqual(state.decisions.map((decision) => decision.text).sort(), ['原决策', '新决策'].sort());
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'plan.applied');
  `);
});
