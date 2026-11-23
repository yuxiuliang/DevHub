use serde::Serialize;
use serde_json::Value;

use crate::store::Store;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InboxItem {
    id: String,
    room_id: String,
    room_name: String,
    task_id: Option<String>,
    title: String,
    kind: String,
    status: String,
    updated_at: String,
}

const INBOX_SQL: &str = "
    WITH pending AS (
        SELECT 'plan:' || r.id AS id, r.id AS room_id, r.name AS room_name,
               NULL AS task_id, r.name AS title, 'plan' AS kind, 'planning' AS status,
               r.updated_at, r.plan_json
        FROM rooms AS r
        WHERE r.status <> 'archived'
          AND r.plan_json <> ''
          AND NOT EXISTS (
              SELECT 1 FROM tasks AS t
              WHERE t.room_id = r.id
                AND (t.status NOT IN ('backlog', 'ready')
                     OR COALESCE(t.worktree, '') <> ''
                     OR COALESCE(t.branch, '') <> '')
          )
        UNION ALL
        SELECT 'task:' || t.id, r.id, r.name, t.id, t.title,
               CASE WHEN t.status IN ('review', 'approved') THEN 'result' ELSE 'problem' END,
               t.status, t.updated_at, NULL
        FROM tasks AS t
        JOIN rooms AS r ON r.id = t.room_id
        WHERE r.status <> 'archived'
          AND t.status IN ('failed', 'changes_requested', 'escalated', 'review', 'approved')
    )
    SELECT id, room_id, room_name, task_id, title, kind, status, updated_at, plan_json
    FROM pending
    ORDER BY CASE kind WHEN 'problem' THEN 0 WHEN 'plan' THEN 1 ELSE 2 END,
             updated_at DESC, id ASC
";

pub(crate) fn list(store: &Store) -> rusqlite::Result<Vec<InboxItem>> {
    let conn = store.db.lock().unwrap();
    let mut stmt = conn.prepare(INBOX_SQL)?;
    let mut rows = stmt.query([])?;
    let mut items = Vec::new();
    while let Some(row) = rows.next()? {
        if let Some(plan_json) = row.get::<_, Option<String>>("plan_json")? {
            let Ok(Value::Object(plan)) = serde_json::from_str(&plan_json) else {
                continue;
            };
            if !plan
                .get("tasks")
                .and_then(Value::as_array)
                .is_some_and(|tasks| !tasks.is_empty())
            {
                continue;
            }
        }
        items.push(InboxItem {
            id: row.get("id")?,
            room_id: row.get("room_id")?,
            room_name: row.get("room_name")?,
            task_id: row.get("task_id")?,
            title: row.get("title")?,
            kind: row.get("kind")?,
            status: row.get("status")?,
            updated_at: row.get("updated_at")?,
        });
    }
    Ok(items)
}
