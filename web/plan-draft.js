const text = (value) => typeof value === 'string' ? value : '';
const textList = (value) => Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim()) : [];
const TYPES = ['code', 'document', 'research'];

export function suggestTaskTitle(description) {
  const first = text(description).split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '新任务';
  const concise = first
    .replace(/^(?:麻烦|请帮我|帮我|请)\s*/u, '')
    .replace(/[。！？.!?，,；;]+$/u, '')
    .trim();
  return [...(concise || first)].slice(0, 36).join('');
}

export function suggestTaskType(description) {
  const value = text(description);
  if (/文档|说明|指南|README|撰写|手册/u.test(value)) return 'document';
  if (/调研|调查|对比|分析|搜集/u.test(value)) return 'research';
  return 'code';
}

export function createPlanDraft(plan, defaultOwner = '') {
  const original = Array.isArray(plan?.tasks) ? plan.tasks : [];
  const tasks = original.map((task, index) => {
    const refs = task?.dependsOn;
    const valid = (ref) => Number.isSafeInteger(ref) && ref >= 1 && ref <= original.length && ref !== index + 1;
    const dependencies = Array.isArray(refs) ? [...new Set(refs.filter(valid))] : [];
    return {
      id: index + 1,
      title: text(task?.title).trim() || suggestTaskTitle(task?.spec || task?.acceptance?.[0]),
      spec: text(task?.spec),
      owner: text(task?.owner) || defaultOwner,
      type: TYPES.includes(task?.type) ? task.type : suggestTaskType(`${task?.title || ''}\n${task?.spec || ''}`),
      phase: text(task?.phase),
      acceptance: textList(task?.acceptance).length ? textList(task?.acceptance) : ['按说明完成，并确认结果符合预期'],
      dependencies: [...new Set(dependencies)],
      invalidDependencies: refs !== undefined && (!Array.isArray(refs) || dependencies.length !== refs.length),
    };
  });
  return {
    summary: text(plan?.summary),
    decisions: textList(plan?.decisions),
    risks: textList(plan?.risks),
    tasks,
    nextId: tasks.length + 1,
  };
}

export function addPlanTask(draft, owner) {
  const task = {
    id: draft.nextId++, title: '', spec: '', owner, type: 'code', phase: '',
    acceptance: [], dependencies: [], invalidDependencies: false,
  };
  draft.tasks.push(task);
  return task;
}

export function removePlanTask(draft, taskId) {
  draft.tasks = draft.tasks.filter((task) => task.id !== taskId);
  for (const task of draft.tasks) {
    task.dependencies = task.dependencies.filter((id) => id !== taskId);
  }
}

export function serializePlan(draft) {
  const numbers = new Map(draft.tasks.map((task, index) => [task.id, index + 1]));
  return {
    summary: draft.summary,
    decisions: draft.decisions,
    risks: draft.risks,
    tasks: draft.tasks.map(({ id, dependencies, invalidDependencies, ...task }) => ({
      ...task,
      title: task.title.trim(),
      dependsOn: dependencies.map((depId) => numbers.get(depId)),
    })),
  };
}
