const TASK_TYPES = new Set(['code', 'document', 'research']);

export class PlanValidationError extends Error {
  constructor(issues) {
    super(`计划校验失败：\n${issues.join('\n')}`);
    this.name = 'PlanValidationError';
    this.issues = issues;
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Validate the complete draft before any task records are replaced. */
export function validatePlan(input, { members = [], flow = {} } = {}) {
  if (!isObject(input)) throw new PlanValidationError(['计划必须是 JSON 对象']);
  if (!Array.isArray(input.tasks) || input.tasks.length === 0) {
    throw new PlanValidationError(['计划里至少要有一个任务']);
  }

  const issues = [];
  const defaultOwner = members.find((m) => m.enabled !== false && m.enabled !== 0)?.name || '';
  if (!defaultOwner) issues.push('当前会话没有启用成员，请先启用成员或添加成员');
  const phases = Array.isArray(flow?.nodes) ? flow.nodes.filter((n) => n?.type === 'phase') : [];
  const stringList = (value, label) => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
      issues.push(`${label}必须是非空字符串数组`);
      return [];
    }
    return value.map((item) => item.trim());
  };
  if (input.summary !== undefined && typeof input.summary !== 'string') issues.push('计划摘要必须是字符串');
  const decisions = stringList(input.decisions, '计划决策');
  const risks = stringList(input.risks, '计划风险');
  const tasks = input.tasks.map((task, index) => {
    const key = `T${index + 1}`;
    if (!isObject(task)) {
      issues.push(`${key} 必须是任务对象`);
      return { title: '', spec: '', owner: '', type: 'code', acceptance: [], dependsOn: [] };
    }
    const title = typeof task.title === 'string' ? task.title.trim() : '';
    if (!title) issues.push(`${key} 的标题不能为空，且必须是字符串`);
    if (task.spec !== undefined && typeof task.spec !== 'string') issues.push(`${key} 的说明必须是字符串`);
    const owner = task.owner === undefined ? defaultOwner : typeof task.owner === 'string' ? task.owner.trim() : '';
    const matches = members.filter((m) => m.name === owner);
    if (!owner || matches.length === 0) issues.push(`${key} 的负责人「${owner || '未填写'}」不在当前会话成员中`);
    else if (matches.length > 1) issues.push(`${key} 的负责人「${owner}」存在同名成员，请先修改成员名`);
    else if (matches[0].enabled === false || matches[0].enabled === 0) issues.push(`${key} 的负责人「${owner}」已停用，请换人或启用成员`);
    const type = task.type === undefined ? 'code' : task.type;
    if (!TASK_TYPES.has(type)) issues.push(`${key} 的类型必须是 code、document 或 research`);
    const acceptance = stringList(task.acceptance, `${key} 的验收标准`);
    let phase;
    if (task.phase !== undefined) {
      if (typeof task.phase !== 'string') issues.push(`${key} 的阶段必须是字符串`);
      else if (task.phase.trim()) {
        phase = task.phase.trim();
        const matches = phases.filter((p) => p.name === phase);
        if (matches.length === 0) issues.push(`${key} 的阶段「${phase}」不在当前流程中`);
        else if (matches.length > 1) issues.push(`${key} 的阶段「${phase}」存在重名，请先修改阶段名`);
      }
    }
    let dependsOn = [];
    if (task.dependsOn !== undefined) {
      if (!Array.isArray(task.dependsOn)) issues.push(`${key} 的依赖 dependsOn 必须是从 1 开始的整数数组`);
      else {
        const seen = new Set();
        for (const dep of task.dependsOn) {
          if (!Number.isSafeInteger(dep) || dep < 1) issues.push(`${key} 的依赖必须是从 1 开始的正整数`);
          else if (dep > input.tasks.length) issues.push(`${key} 依赖的任务 T${dep} 不存在`);
          else if (dep === index + 1) issues.push(`${key} 不能依赖自身`);
          else if (seen.has(dep)) issues.push(`${key} 重复依赖了 T${dep}`);
          else { seen.add(dep); dependsOn.push(dep); }
        }
      }
    }
    return { ...task, title, spec: task.spec ?? '', owner, type, phase, acceptance, dependsOn };
  });

  // Topological validation supports forward references without recursive depth limits.
  const dependents = tasks.map(() => []);
  const pending = tasks.map((task, i) => {
    for (const dep of task.dependsOn) dependents[dep - 1].push(i);
    return task.dependsOn.length;
  });
  const queue = pending.flatMap((count, i) => count === 0 ? [i] : []);
  for (let cursor = 0; cursor < queue.length; cursor++) {
    for (const next of dependents[queue[cursor]]) {
      if (--pending[next] === 0) queue.push(next);
    }
  }
  if (queue.length !== tasks.length) {
    const involved = pending.flatMap((count, i) => count > 0 ? [`T${i + 1}`] : []);
    issues.push(`任务依赖存在循环（${involved.join('、')}），请移除循环依赖`);
  }
  if (issues.length) throw new PlanValidationError(issues);
  const { validationErrors, ...plan } = input;
  return { ...plan, tasks, decisions, risks };
}
