use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::Router;
use devhub::{api, engine::Engine, store::Store};
use http_body_util::BodyExt;
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use tempfile::{tempdir, TempDir};
use tokio::sync::broadcast::error::TryRecvError;
use tower::ServiceExt;

const OLD: &str = "2026-11-01T10:00:00.000Z";
const TIED: &str = "2026-11-02T10:00:00.000Z";
const NEW: &str = "2026-11-03T10:00:00.000Z";
const PLAN: &str = r#"{"tasks":[{"title":"整理说明"}]}"#;

fn fixture() -> (TempDir, Store, Router) {
    let dir = tempdir().unwrap();
    let store = Store::open(dir.path().join("data")).unwrap();
    let app = api::router(Engine::new(store.clone()));
    (dir, store, app)
}

fn insert_room(db: &Connection, id: &str, status: &str, plan_json: &str, updated: &str) {
    db.execute(
        "INSERT INTO rooms (id, name, repo_path, status, plan_json, created_at, updated_at)
         VALUES (?, ?, 'unused-fixture-repo', ?, ?, ?, ?)",
        params![id, format!("会话 {id}"), status, plan_json, OLD, updated],
    )
    .unwrap();
}

fn insert_task(
    db: &Connection,
    id: &str,
    room: &str,
    status: &str,
    worktree: &str,
    branch: &str,
    updated: &str,
) {
    db.execute(
        "INSERT INTO tasks (id, room_id, key, title, status, worktree, branch, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params![id, room, id, format!("任务 {id}"), status, worktree, branch, OLD, updated],
    )
    .unwrap();
}

async fn get_state(app: &Router) -> Value {
    let response = app
        .clone()
        .oneshot(Request::get("/api/state").body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(
        status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&bytes)
    );
    serde_json::from_slice(&bytes).unwrap()
}

fn expected_plan(room: &str, updated: &str) -> Value {
    json!({
        "id": format!("plan:{room}"),
        "roomId": room,
        "roomName": format!("会话 {room}"),
        "taskId": null,
        "title": format!("会话 {room}"),
        "kind": "plan",
        "status": "planning",
        "updatedAt": updated,
    })
}

fn expected_task(room: &str, task: &str, kind: &str, status: &str, updated: &str) -> Value {
    json!({
        "id": format!("task:{task}"),
        "roomId": room,
        "roomName": format!("会话 {room}"),
        "taskId": task,
        "title": format!("任务 {task}"),
        "kind": kind,
        "status": status,
        "updatedAt": updated,
    })
}

#[tokio::test]
async fn state_exposes_empty_inbox_without_removing_existing_fields() {
    let (_dir, _store, app) = fixture();
    let state = get_state(&app).await;
    assert_eq!(state["inbox"], json!([]));
    assert_eq!(state["rooms"], json!([]));
    assert_eq!(state["running"], json!([]));
    assert_eq!(state["flowTemplates"].as_array().unwrap().len(), 5);
}

#[tokio::test]
async fn state_filters_and_orders_inbox_entries() {
    let (_dir, store, app) = fixture();
    {
        let db = store.db.lock().unwrap();
        insert_room(&db, "plan_b", "draft", PLAN, TIED);
        insert_room(&db, "plan_a", "paused", PLAN, TIED);
        insert_room(&db, "plan_new", "planning", PLAN, NEW);
        insert_room(&db, "work", "running", PLAN, NEW);
        insert_room(&db, "archived", "archived", PLAN, NEW);
        insert_room(&db, "archived_plan", "archived", PLAN, NEW);

        for (id, status) in [("waiting", "backlog"), ("queued", "ready")] {
            insert_task(&db, id, "plan_a", status, "", "", NEW);
        }
        for (id, status, updated) in [
            ("p_b", "escalated", TIED),
            ("p_a", "failed", TIED),
            ("p_new", "changes_requested", NEW),
            ("p_old", "failed", OLD),
            ("r_b", "approved", NEW),
            ("r_a", "review", NEW),
            ("r_old", "review", OLD),
        ] {
            insert_task(&db, id, "work", status, "", "", updated);
        }
        for (id, status, worktree, branch) in [
            ("has_worktree", "backlog", "old-worktree", ""),
            ("has_branch", "ready", "", "feature"),
            ("done", "done", "", ""),
            ("merged", "merged", "", ""),
            ("running", "running", "", ""),
            ("cancelled", "cancelled", "", ""),
        ] {
            insert_room(&db, id, "planning", PLAN, NEW);
            insert_task(&db, id, id, status, worktree, branch, NEW);
        }
        insert_task(&db, "archive_p", "archived", "failed", "", "", NEW);
        insert_task(&db, "archive_r", "archived", "review", "", "", NEW);
        insert_task(&db, "orphan", "missing_room", "approved", "", "", NEW);
    }

    let state = get_state(&app).await;
    assert_eq!(
        state["inbox"],
        json!([
            expected_task("work", "p_new", "problem", "changes_requested", NEW),
            expected_task("work", "p_a", "problem", "failed", TIED),
            expected_task("work", "p_b", "problem", "escalated", TIED),
            expected_task("work", "p_old", "problem", "failed", OLD),
            expected_plan("plan_new", NEW),
            expected_plan("plan_a", TIED),
            expected_plan("plan_b", TIED),
            expected_task("work", "r_a", "result", "review", NEW),
            expected_task("work", "r_b", "result", "approved", NEW),
            expected_task("work", "r_old", "result", "review", OLD),
        ])
    );
    assert!(state["rooms"]
        .as_array()
        .unwrap()
        .iter()
        .any(|room| room["id"] == "archived"));
}

#[tokio::test]
async fn state_ignores_invalid_plans_and_accepts_nonempty_task_arrays() {
    let (_dir, store, app) = fixture();
    {
        let db = store.db.lock().unwrap();
        for (index, plan) in [
            "",
            "null",
            "[]",
            "{}",
            r#"{"tasks":null}"#,
            r#"{"tasks":"nonempty"}"#,
            r#"{"tasks":{ "0": {} }}"#,
            r#"{"tasks":[]}"#,
            r#"{"tasks":[{}]} invalid"#,
            r#"{"tasks":[{}], "tasks":[]}"#,
        ]
        .into_iter()
        .enumerate()
        {
            insert_room(&db, &format!("invalid_{index}"), "planning", plan, NEW);
        }
        insert_room(&db, "minimal", "planning", r#"{"tasks":[{}]}"#, OLD);
    }
    assert_eq!(
        get_state(&app).await["inbox"],
        json!([expected_plan("minimal", OLD)])
    );
}

#[tokio::test]
async fn state_reads_inbox_without_writes_or_events() {
    let (_dir, store, app) = fixture();
    {
        let db = store.db.lock().unwrap();
        insert_room(&db, "plan", "draft", PLAN, NEW);
        insert_room(&db, "work", "paused", "", OLD);
        insert_task(&db, "problem", "work", "failed", "", "", OLD);
        db.execute_batch("PRAGMA query_only = ON").unwrap();
    }
    let mut events = store.subscribe();
    let expected = json!([
        expected_task("work", "problem", "problem", "failed", OLD),
        expected_plan("plan", NEW),
    ]);
    for _ in 0..2 {
        let state = get_state(&app).await;
        assert_eq!(state["inbox"], expected);
        assert_eq!(state["running"], json!([]));
    }
    assert!(matches!(events.try_recv(), Err(TryRecvError::Empty)));
}
