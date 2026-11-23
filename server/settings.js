import { all, get, run, transaction, emit, now, uid } from './store.js';
import { WORKER_DEFS } from './adapters.js';

function fail(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(value, label, { empty = true, trim = false } = {}) {
  if (typeof value !== 'string') fail(400, `${label}必须是文字`);
  const result = trim ? value.trim() : value;
  if (!empty && !result.trim()) fail(400, `${label}不能为空`);
  return result;
}

/** A projection of editable settings only; task events and flow saves do not change its version. */
export function readSettings(roomId) {
  const room = get('SELECT * FROM rooms WHERE id=?', [roomId]);
  if (!room) fail(404, '会话不存在，请刷新后重新选择');
  const members = all('SELECT * FROM members WHERE room_id=? ORDER BY sort, name', [roomId]).map((member) => ({
    key: member.id,
    id: member.id,
    name: member.name,
    worker: member.worker,
    role_name: member.role_name || '',
    role_brief: member.role_brief || '',
    model: member.model || '',
    concurrency: member.concurrency,
    enabled: Boolean(member.enabled),
  }));
  const settings = {
    name: room.name,
    requirement: room.requirement,
    mode: room.mode,
    autoApprove: Boolean(room.auto_approve),
    plannerKey: room.planner_id || '',
    reviewerKey: room.reviewer_id || '',
    members,
  };
  return { roomId, archived: room.status === 'archived', version: JSON.stringify(settings), settings };
}

function validateSettings(input, current) {
  if (!object(input)) fail(400, '设置必须是完整的设置对象');
  const name = requiredString(input.name, '会话名', { empty: false, trim: true });
  const requirement = requiredString(input.requirement, '需求');
  if (!['serial', 'parallel'].includes(input.mode)) fail(400, '执行方式必须是 serial 或 parallel');
  if (typeof input.autoApprove !== 'boolean') fail(400, '自动执行设置必须是开或关');
  if (!Array.isArray(input.members) || !input.members.length) fail(400, '至少保留一位成员');
  const existing = new Map(current.settings.members.map((member) => [member.id, member]));
  const keys = new Set();
  const ids = new Set();
  const names = new Set();
  const members = input.members.map((member, index) => {
    const label = `成员 ${index + 1}`;
    if (!object(member)) fail(400, `${label}设置无效`);
    const key = requiredString(member.key, `${label}标识`, { empty: false });
    if (keys.has(key)) fail(400, '成员标识重复，请重新打开设置后重试');
    keys.add(key);
    let id = null;
    if (member.id !== undefined && member.id !== null && member.id !== '') {
      id = requiredString(member.id, `${label} ID`, { empty: false });
      if (!existing.has(id)) fail(400, '提交的成员不属于当前会话，请重新打开设置后重试');
      if (key !== id) fail(400, '已有成员标识不能修改，请重新打开设置后重试');
      if (ids.has(id)) fail(400, '同一成员不能重复提交');
      ids.add(id);
    } else if (existing.has(key) || get('SELECT id FROM members WHERE id=?', [key])) {
      fail(400, '新增成员标识与已有成员冲突，请重新打开设置后重试');
    }
    const memberName = requiredString(member.name, `${label}名字`, { empty: false, trim: true });
    if (names.has(memberName)) fail(400, `成员名字「${memberName}」重复，请使用不同的名字`);
    names.add(memberName);
    const worker = requiredString(member.worker, `${label}工具`, { empty: false });
    if (!Object.hasOwn(WORKER_DEFS, worker)) fail(400, `未知协作工具：${worker}`);
    if (!Number.isInteger(member.concurrency) || member.concurrency < 1 || member.concurrency > 10) {
      fail(400, `${label}的并发数必须是 1 到 10 的整数`);
    }
    if (typeof member.enabled !== 'boolean') fail(400, `${label}的启用状态必须是开或关`);
    const optionalText = (field) => member[field] === undefined ? '' : requiredString(member[field], `${label}的${field}`);
    const model = optionalText('model').trim();
    if (/\p{Cc}/u.test(member.model ?? '')) fail(400, `${label}的模型名不能包含换行或控制字符`);
    return { key, id, name: memberName, worker, role_name: optionalText('role_name').trim(),
      role_brief: optionalText('role_brief').trim(), model, concurrency: member.concurrency, enabled: member.enabled };
  });
  const assigned = (key, label) => {
    requiredString(key, label, { empty: false });
    const member = members.find((item) => item.key === key);
    if (!member) fail(400, `${label}必须选择当前成员`);
    if (!member.enabled) fail(400, `${label}已停用，请选择启用的成员`);
    return key;
  };
  const plannerKey = assigned(input.plannerKey, '计划者');
  const reviewerKey = assigned(input.reviewerKey, '评审者');
  for (const member of current.settings.members) {
    if (ids.has(member.id)) continue;
    const owned = get('SELECT COUNT(*) c FROM tasks WHERE owner_id=?', [member.id]).c;
    if (owned) fail(400, `「${member.name}」名下还有 ${owned} 个任务，不能删除；可以先停用`);
  }
  return { name, requirement, mode: input.mode, autoApprove: input.autoApprove, plannerKey, reviewerKey, members };
}

export function saveSettings(roomId, input) {
  const result = transaction(() => {
    const current = readSettings(roomId);
    if (current.archived) fail(409, '会话已归档，请先恢复后再保存设置');
    if (!object(input) || typeof input.version !== 'string') fail(400, '缺少设置版本，请重新打开设置后重试');
    if (input.version !== current.version) fail(409, '设置已在其他地方更新，请重新加载最新设置后再保存');
    const settings = validateSettings(input.settings, current);
    const ids = new Map();
    settings.members.forEach((member, index) => {
      const id = member.id || uid('m');
      ids.set(member.key, id);
      if (member.id) {
        run(`UPDATE members SET name=?, worker=?, role_name=?, role_brief=?, model=?, concurrency=?, enabled=?, sort=?
          WHERE id=? AND room_id=?`, [member.name, member.worker, member.role_name, member.role_brief, member.model,
          member.concurrency, member.enabled ? 1 : 0, index, id, roomId]);
      } else {
        run(`INSERT INTO members (id,room_id,name,worker,role_name,role_brief,model,concurrency,enabled,sort)
          VALUES (?,?,?,?,?,?,?,?,?,?)`, [id, roomId, member.name, member.worker, member.role_name, member.role_brief,
          member.model, member.concurrency, member.enabled ? 1 : 0, index]);
      }
    });
    const kept = new Set(ids.values());
    for (const member of current.settings.members) {
      if (!kept.has(member.id)) run('DELETE FROM members WHERE id=? AND room_id=?', [member.id, roomId]);
    }
    run(`UPDATE rooms SET name=?, requirement=?, mode=?, auto_approve=?, planner_id=?, reviewer_id=?, updated_at=? WHERE id=?`,
      [settings.name, settings.requirement, settings.mode, settings.autoApprove ? 1 : 0,
        ids.get(settings.plannerKey), ids.get(settings.reviewerKey), now(), roomId]);
    return readSettings(roomId);
  });
  emit(roomId, null, null, 'room.settings_updated', {});
  return result;
}
