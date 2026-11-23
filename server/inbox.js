import { all, safeJson } from './store.js';

export function listInbox() {
  const candidates = all(`
    WITH candidates AS (
      SELECT 'task:' || t.id AS id, r.id AS roomId, r.name AS roomName,
             t.id AS taskId, t.title,
             CASE WHEN t.status IN ('review', 'approved') THEN 'result' ELSE 'problem' END AS kind,
             t.status, t.updated_at AS updatedAt, NULL AS planJson
      FROM tasks AS t
      JOIN rooms AS r ON r.id = t.room_id
      WHERE r.status <> 'archived'
        AND t.status IN ('failed', 'changes_requested', 'escalated', 'review', 'approved')

      UNION ALL

      SELECT 'plan:' || r.id, r.id, r.name, NULL, r.name,
             'plan', 'planning', r.updated_at, r.plan_json
      FROM rooms AS r
      WHERE r.status <> 'archived' AND r.plan_json <> ''
        AND NOT EXISTS (
          SELECT 1 FROM tasks AS t WHERE t.room_id = r.id
            AND (t.status NOT IN ('backlog', 'ready')
                 OR COALESCE(t.worktree, '') <> '' OR COALESCE(t.branch, '') <> '')
        )
    )
    SELECT * FROM candidates
    ORDER BY CASE kind WHEN 'problem' THEN 0 WHEN 'plan' THEN 1 ELSE 2 END,
             updatedAt DESC, id ASC
  `);

  const inbox = [];
  for (const { planJson, ...item } of candidates) {
    if (item.kind === 'plan') {
      const plan = safeJson(planJson, null);
      if (!Array.isArray(plan?.tasks) || plan.tasks.length === 0) continue;
    }
    inbox.push(item);
  }
  return inbox;
}
