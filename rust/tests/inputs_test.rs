use std::fs;

use axum::{body::Body, http::{Request, StatusCode}};
use devhub::{api, engine::Engine, store::Store};
use http_body_util::BodyExt;
use rusqlite::params;
use serde_json::{json, Value};
use tower::ServiceExt;

const STARTED: &str = "2026-11-21T12:00:00.000Z";
const MAX_BYTES: usize = 262_144;

struct Fixture {
    _dir: tempfile::TempDir,
    store: Store,
    engine: Engine,
    app: axum::Router,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().join("data")).unwrap();
        {
            let db = store.db.lock().unwrap();
            db.execute_batch(
                "INSERT INTO rooms (id,name,requirement,repo_path,status,created_at,updated_at) VALUES
                   ('room','original room','original requirement','unused','paused','old','old'),
                   ('other','other','other requirement','unused','archived','old','old');
                 INSERT INTO members (id,room_id,name,worker) VALUES ('member','room','original member','codex');
                 INSERT INTO tasks (id,room_id,key,title,owner_id,status,created_at,updated_at) VALUES
                   ('task','room','T1','original task','member','failed','old','old'),
                   ('same-room','room','T2','another task','member','ready','old','old'),
                   ('other-task','other','T1','other room',NULL,'done','old','old');
                 INSERT INTO decisions (id,room_id,text,status,created_at) VALUES ('decision','room','original decision','active','old');"
            ).unwrap();
        }
        let engine = Engine::new(store.clone());
        let app = api::router(engine.clone());
        Self { _dir: dir, store, engine, app }
    }

    fn run(&self, id: &str, task: &str, status: &str, code: Option<i64>, started: &str) {
        self.run_flow(id, task, status, code, started, "");
    }

    fn run_flow(&self, id: &str, task: &str, status: &str, code: Option<i64>, started: &str, flow_json: &str) {
        self.store.db.lock().unwrap().execute(
            "INSERT INTO runs (id,task_id,member_id,status,exit_code,started_at,ended_at,error,log_path,flow_json)
             VALUES (?,?,'member',?,?,?,'ended','preserve original worker error','ignore-this-path',?)",
            params![id, task, status, code, started, flow_json],
        ).unwrap();
    }

    fn prompt(&self, id: &str, text: impl AsRef<[u8]>) {
        fs::write(self.store.prompts.join(format!("{id}.md")), text).unwrap();
    }

    async fn get(&self, task: &str, run: Option<&str>) -> (StatusCode, Value) {
        let mut url = format!("/api/tasks/{task}/prompt");
        if let Some(run) = run {
            url.push_str("?runId=");
            for byte in run.bytes() {
                if byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-' {
                    url.push(byte as char);
                } else {
                    url.push_str(&format!("%{byte:02X}"));
                }
            }
        }
        let response = self.app.clone().oneshot(Request::get(url).body(Body::empty()).unwrap()).await.unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&bytes).expect("prompt API returns JSON"))
    }
}

fn empty_response() -> Value {
    json!({
        "prompt":"", "runId":null, "status":"", "exitCode":null, "startedAt":null,
        "endedAt":null, "available":false, "truncated":false, "totalBytes":0, "readError":"",
        "runs":[], "runsTruncated":false, "flow":null,
    })
}

#[tokio::test]
async fn absent_runs_have_exact_empty_shape_and_unknown_tasks_or_selections_are_not_found() {
    let f = Fixture::new();
    let (status, body) = f.get("task", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, empty_response());
    for (task, run) in [("missing", None), ("task", Some("missing")), ("task", Some(""))] {
        let (status, body) = f.get(task, run).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
        assert!(body["error"].as_str().is_some());
        assert!(body.get("prompt").is_none());
    }
}

#[tokio::test]
async fn latest_and_explicit_history_preserve_metadata_and_crlf_bytes() {
    let f = Fixture::new();
    f.run("older", "task", "completed", Some(0), STARTED);
    f.run("latest", "task", "failed", Some(17), STARTED);
    let old_prompt = "\u{feff}old requirement\r\n旧决策：保持原文 ✅\r\n";
    let new_prompt = "new requirement\r\n成员与反馈 💥\n末尾";
    f.prompt("older", old_prompt);
    f.prompt("latest", new_prompt);
    let (status, body) = f.get("task", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!({
        "prompt":new_prompt, "runId":"latest", "status":"failed", "exitCode":17,
        "startedAt":STARTED, "endedAt":"ended", "available":true, "truncated":false,
        "totalBytes":new_prompt.len(), "readError":"", "runsTruncated":false, "flow":null,
        "runs":[
            {"runId":"latest","status":"failed","exitCode":17,"startedAt":STARTED,"endedAt":"ended"},
            {"runId":"older","status":"completed","exitCode":0,"startedAt":STARTED,"endedAt":"ended"},
        ],
    }));
    let (status, body) = f.get("task", Some("older")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["prompt"], old_prompt);
    assert_eq!(body["runId"], "older");
    assert_eq!(body["exitCode"], 0);
    assert_eq!(body["totalBytes"], old_prompt.len());
    assert_eq!(body["runs"][0]["runId"], "latest");
}

#[tokio::test]
async fn history_uses_started_time_then_rowid_and_allows_selection_beyond_fifty() {
    let f = Fixture::new();
    for n in 0..50 {
        f.run(&format!("run_{n:03}"), "task", "completed", Some(0), STARTED);
    }
    let (_, fifty) = f.get("task", None).await;
    assert_eq!(fifty["runs"].as_array().unwrap().len(), 50);
    assert_eq!(fifty["runsTruncated"], false);
    assert_eq!(fifty["runId"], "run_049");
    for n in 50..60 {
        f.run(&format!("run_{n:03}"), "task", "completed", Some(0), STARTED);
    }
    f.run("newest_by_time", "task", "running", None, "2026-11-22T12:00:00.000Z");
    f.run("last_inserted_but_old", "task", "interrupted", None, "2000-01-01T00:00:00.000Z");
    f.prompt("run_000", "oldest saved input");
    let (_, latest) = f.get("task", None).await;
    assert_eq!(latest["runId"], "newest_by_time");
    assert_eq!(latest["runsTruncated"], true);
    assert_eq!(latest["runs"].as_array().unwrap().len(), 50);
    assert_eq!(latest["runs"][1]["runId"], "run_059");
    assert_eq!(latest["runs"][49]["runId"], "run_011");
    let (status, history) = f.get("task", Some("run_000")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(history["runId"], "run_000");
    assert_eq!(history["prompt"], "oldest saved input");
    assert_eq!(history["runs"], latest["runs"]);
    assert_eq!(history["runsTruncated"], true);
}

#[tokio::test]
async fn selections_cannot_cross_tasks_or_rooms_and_unrecorded_review_files_are_ignored() {
    let f = Fixture::new();
    f.run("own", "task", "failed", Some(1), STARTED);
    f.run("same_room", "same-room", "completed", Some(0), STARTED);
    f.run("foreign", "other-task", "completed", Some(0), STARTED);
    f.prompt("same_room", "another task secret");
    f.prompt("foreign", "another room secret");
    f.prompt("review-unrecorded", "review prompt must not become a task execution");
    for run in ["same_room", "foreign", "review-unrecorded"] {
        let (status, body) = f.get("task", Some(run)).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    }
    let (_, own) = f.get("task", None).await;
    assert_eq!(own["runId"], "own");
    assert_eq!(own["prompt"], "");
    assert_eq!(own["available"], false);
    assert_eq!(own["runs"].as_array().unwrap().len(), 1);
    let (_, archived) = f.get("other-task", None).await;
    assert_eq!(archived["prompt"], "another room secret");
}

#[tokio::test]
async fn settings_decisions_and_archive_changes_never_rebuild_saved_input() {
    let f = Fixture::new();
    f.run("recorded", "task", "interrupted", None, STARTED);
    f.prompt("recorded", "original requirement\r\noriginal member\r\noriginal decision\r\n");
    let (_, before) = f.get("task", None).await;
    f.store.db.lock().unwrap().execute_batch(
        "UPDATE rooms SET name='changed',requirement='changed requirement',status='archived';
         UPDATE members SET name='changed member',worker='dsh';
         UPDATE tasks SET title='changed task',feedback='new feedback';
         UPDATE decisions SET text='changed decision';"
    ).unwrap();
    let (_, after) = f.get("task", None).await;
    assert_eq!(after, before);
}

#[tokio::test]
async fn missing_and_empty_files_are_distinct_and_missing_latest_never_borrows_old_input() {
    let f = Fixture::new();
    f.run("older", "task", "completed", Some(0), STARTED);
    f.prompt("older", "do not borrow this");
    f.run("missing", "task", "running", None, STARTED);
    let (_, missing) = f.get("task", None).await;
    assert_eq!(missing["runId"], "missing");
    assert_eq!(missing["available"], false);
    assert_eq!(missing["prompt"], "");
    assert_eq!(missing["readError"], "");
    assert_eq!(missing["totalBytes"], 0);
    assert!(!f.store.prompts.join("missing.md").exists());
    f.prompt("missing", "");
    let (_, empty) = f.get("task", None).await;
    assert_eq!(empty["available"], true);
    assert_eq!(empty["prompt"], "");
    assert_eq!(empty["readError"], "");
    assert_eq!(empty["totalBytes"], 0);
}

#[tokio::test]
async fn bounded_prefix_handles_exact_limit_chinese_emoji_and_oversized_single_lines() {
    let f = Fixture::new();
    f.run("bounded", "task", "completed", Some(0), STARTED);
    let exact = "a".repeat(MAX_BYTES);
    f.prompt("bounded", &exact);
    let (_, body) = f.get("task", None).await;
    assert_eq!(body["prompt"], exact);
    assert_eq!(body["truncated"], false);
    let large_ascii = "x".repeat(MAX_BYTES * 12);
    f.prompt("bounded", &large_ascii);
    let (_, body) = f.get("task", None).await;
    assert_eq!(body["prompt"], "x".repeat(MAX_BYTES));
    assert_eq!(body["totalBytes"], large_ascii.len());
    assert_eq!(body["truncated"], true);
    assert_eq!(body["available"], true);
    let chinese = "界".repeat(MAX_BYTES);
    f.prompt("bounded", &chinese);
    let (_, body) = f.get("task", None).await;
    assert_eq!(body["prompt"], "界".repeat(MAX_BYTES / 3));
    assert_eq!(body["totalBytes"], chinese.len());
    assert_eq!(body["readError"], "");
    for offset in 1..=3 {
        let prefix = "a".repeat(MAX_BYTES - offset);
        let text = format!("{prefix}💥suffix\r\n");
        f.prompt("bounded", &text);
        let (_, body) = f.get("task", None).await;
        assert_eq!(body["prompt"], prefix);
        assert_eq!(body["available"], true);
        assert_eq!(body["truncated"], true);
        assert_eq!(body["totalBytes"], text.len());
        assert_eq!(body["readError"], "");
    }
}

#[tokio::test]
async fn invalid_utf8_is_an_error_without_replacement_characters_or_partial_output() {
    let f = Fixture::new();
    f.run("invalid", "task", "failed", Some(7), STARTED);
    let mut invalid_prefix = vec![b'a'; MAX_BYTES + 10];
    invalid_prefix[100] = 0xff;
    for bytes in [vec![b'a', 0xff, b'b'], vec![0xf0, 0x9f], invalid_prefix] {
        f.prompt("invalid", &bytes);
        let (status, body) = f.get("task", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["available"], false);
        assert_eq!(body["prompt"], "");
        assert!(!body["readError"].as_str().unwrap().is_empty());
        assert_eq!(body["totalBytes"], bytes.len());
        assert_eq!(body["status"], "failed");
        assert_eq!(body["exitCode"], 7);
    }
}

#[tokio::test]
async fn unsafe_run_ids_keep_metadata_but_cannot_be_used_as_paths() {
    let f = Fixture::new();
    fs::write(f.store.data.join("escape.md"), "outside prompt folder").unwrap();
    for run in ["../escape", "..\\escape", "with.dot", "/absolute", " ", "中文", ""] {
        f.run(run, "task", "cancelled", None, STARTED);
        let selected = if run.is_empty() {
            let (status, _) = f.get("task", Some(run)).await;
            assert_eq!(status, StatusCode::NOT_FOUND);
            None
        } else {
            Some(run)
        };
        let (status, body) = f.get("task", selected).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["runId"], run);
        assert_eq!(body["status"], "cancelled");
        assert_eq!(body["available"], false);
        assert_eq!(body["prompt"], "");
        assert!(!body["readError"].as_str().unwrap().is_empty());
        assert_eq!(body["totalBytes"], 0);
    }
}

#[tokio::test]
async fn directories_and_other_io_failures_are_reported_without_rewriting_run_records() {
    let f = Fixture::new();
    f.run("directory", "task", "failed", Some(8), STARTED);
    fs::create_dir(f.store.prompts.join("directory.md")).unwrap();
    let (_, body) = f.get("task", None).await;
    assert_eq!(body["available"], false);
    assert_eq!(body["prompt"], "");
    assert!(!body["readError"].as_str().unwrap().is_empty());
    assert_eq!(body["totalBytes"], 0);
    assert_eq!(body["exitCode"], 8);
    let g = Fixture::new();
    g.run("broken_parent", "task", "running", None, STARTED);
    fs::rename(&g.store.prompts, g.store.data.join("preserved-prompts")).unwrap();
    fs::write(&g.store.prompts, "not a directory").unwrap();
    let (_, body) = g.get("task", None).await;
    assert_eq!(body["available"], false);
    assert!(!body["readError"].as_str().unwrap().is_empty());
    let error: String = g.store.db.lock().unwrap().query_row("SELECT error FROM runs WHERE id='broken_parent'", [], |row| row.get(0)).unwrap();
    assert_eq!(error, "preserve original worker error");
}

#[tokio::test]
async fn symbolic_links_are_rejected_when_host_supports_creating_them() {
    let f = Fixture::new();
    f.run("linked", "task", "completed", Some(0), STARTED);
    let target = f.store.data.join("outside.md");
    fs::write(&target, "must not follow the link").unwrap();
    let link = f.store.prompts.join("linked.md");
    #[cfg(unix)]
    let created = std::os::unix::fs::symlink(&target, &link);
    #[cfg(windows)]
    let created = std::os::windows::fs::symlink_file(&target, &link);
    #[cfg(not(any(unix, windows)))]
    let created: std::io::Result<()> = Err(std::io::ErrorKind::Unsupported.into());
    if let Err(error) = created {
        eprintln!("symlink fixture unavailable on this host: {error}");
        return;
    }
    let (_, body) = f.get("task", None).await;
    assert_eq!(body["available"], false);
    assert_eq!(body["prompt"], "");
    assert_eq!(body["totalBytes"], 0);
    assert!(!body["readError"].as_str().unwrap().is_empty());
}

#[tokio::test]
async fn reading_is_select_only_and_does_not_create_files_events_or_workers() {
    let f = Fixture::new();
    f.run("readonly", "task", "interrupted", None, STARTED);
    f.prompt("readonly", "saved input only");
    let original_file = fs::metadata(f.store.prompts.join("readonly.md")).unwrap().modified().unwrap();
    let mut receiver = f.store.subscribe();
    let db = f.store.db.lock().unwrap();
    let before = (db.total_changes(), db.last_insert_rowid());
    db.execute_batch("PRAGMA query_only=ON").unwrap();
    drop(db);
    for _ in 0..3 {
        let (status, body) = f.get("task", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["prompt"], "saved input only");
    }
    let db = f.store.db.lock().unwrap();
    assert_eq!((db.total_changes(), db.last_insert_rowid()), before);
    let run: (String, String) = db.query_row("SELECT status,error FROM runs WHERE id='readonly'", [], |r| Ok((r.get(0)?,r.get(1)?))).unwrap();
    assert_eq!(run, ("interrupted".into(), "preserve original worker error".into()));
    drop(db);
    assert_eq!(fs::read_dir(&f.store.prompts).unwrap().count(), 1);
    assert_eq!(fs::metadata(f.store.prompts.join("readonly.md")).unwrap().modified().unwrap(), original_file);
    assert!(matches!(receiver.try_recv(), Err(tokio::sync::broadcast::error::TryRecvError::Empty)));
    assert!(f.engine.running_tasks().await.is_empty());
    assert_eq!(f.engine.active_worker_count(), 0);
}

#[tokio::test]
async fn database_errors_return_500_and_are_not_empty_history_or_missing_tasks() {
    let f = Fixture::new();
    f.store.db.lock().unwrap().execute_batch("DROP TABLE runs").unwrap();
    let (status, body) = f.get("task", None).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert!(body["error"].as_str().is_some());
    assert!(body.get("prompt").is_none());
    let g = Fixture::new();
    g.store.db.lock().unwrap().execute_batch("DROP TABLE tasks").unwrap();
    let (status, body) = g.get("task", None).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert!(body["error"].as_str().is_some());
}

fn has_run_flow(store: &Store) -> bool {
    store.db.lock().unwrap().query_row(
        "SELECT EXISTS (SELECT 1 FROM pragma_table_info('runs') WHERE name='flow_json')",
        [],
        |row| row.get(0),
    ).unwrap()
}

#[tokio::test]
async fn flow_snapshot_is_exposed_only_when_the_stored_text_is_a_json_object() {
    let f = Fixture::new();
    let flow = json!({
        "nodes": [
            {"id": "plan", "type": "planner", "title": "规划"},
            {"id": "code", "type": "worker"},
        ],
        "edges": [{"from": "plan", "to": "code"}],
        "options": {"parallel": true, "retries": 0, "weights": [1, 2.5, null]},
    });
    f.run_flow("object", "task", "completed", Some(0), STARTED, &flow.to_string());
    f.prompt("object", "saved input");
    let (status, body) = f.get("task", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["flow"], flow);
    assert_eq!(body["runId"], "object");
    assert_eq!(body["status"], "completed");
    assert_eq!(body["exitCode"], 0);
    assert_eq!(body["prompt"], "saved input");
    assert_eq!(body["available"], true);
    assert_eq!(body["totalBytes"], "saved input".len());
    assert_eq!(body["readError"], "");
    assert_eq!(body["runs"][0]["runId"], "object");
    assert!(body["runs"][0].get("flow").is_none(), "run list must not carry snapshots");

    for (id, stored) in [
        ("legacy", ""),
        ("blank", "   "),
        ("broken", "{bad"),
        ("array", "[]"),
        ("null", "null"),
        ("scalar", "7"),
        ("text", "\"flow\""),
    ] {
        f.run_flow(id, "task", "completed", Some(0), STARTED, stored);
        let (status, body) = f.get("task", Some(id)).await;
        assert_eq!(status, StatusCode::OK, "{id}");
        assert_eq!(body["flow"], Value::Null, "{id} stored {stored:?}");
        assert_eq!(body["runId"], id);
        assert_eq!(body["status"], "completed");
        assert_eq!(body["exitCode"], 0);
        assert_eq!(body["startedAt"], STARTED);
        assert_eq!(body["endedAt"], "ended");
        assert_eq!(body["prompt"], "");
        assert_eq!(body["available"], false);
        assert_eq!(body["readError"], "");
        assert_eq!(body["totalBytes"], 0);
        assert_eq!(body["truncated"], false);
    }
}

#[tokio::test]
async fn every_run_keeps_its_own_snapshot_and_room_edits_never_rewrite_history() {
    let f = Fixture::new();
    let older = json!({"version": 1, "nodes": [{"id": "a"}]});
    let latest = json!({"version": 2, "nodes": [{"id": "b"}, {"id": "c"}]});
    f.run_flow("older", "task", "completed", Some(0), STARTED, &older.to_string());
    f.run_flow("latest", "task", "failed", Some(3), "2026-11-22T09:00:00.000Z", &latest.to_string());
    f.prompt("older", "older input");
    f.prompt("latest", "latest input");

    let (status, by_default) = f.get("task", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(by_default["runId"], "latest");
    assert_eq!(by_default["flow"], latest);
    assert_eq!(by_default["prompt"], "latest input");
    assert_eq!(by_default["exitCode"], 3);

    let (status, selected) = f.get("task", Some("older")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(selected["runId"], "older");
    assert_eq!(selected["flow"], older);
    assert_eq!(selected["prompt"], "older input");
    assert_eq!(selected["exitCode"], 0);
    assert_ne!(by_default["flow"], selected["flow"]);
    assert_eq!(selected["runs"], by_default["runs"]);

    // Later flow edits belong to the room, not to already recorded runs.
    f.store.db.lock().unwrap().execute(
        "UPDATE rooms SET flow_json=? WHERE id='room'",
        params![json!({"version": 99, "nodes": []}).to_string()],
    ).unwrap();
    assert_eq!(f.get("task", None).await.1["flow"], latest);
    assert_eq!(f.get("task", Some("older")).await.1["flow"], older);
}

#[tokio::test]
async fn databases_without_the_flow_column_are_migrated_and_old_runs_report_null() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    {
        let store = Store::open(data.clone()).unwrap();
        store.db.lock().unwrap().execute_batch(
            "ALTER TABLE runs DROP COLUMN flow_json;
             INSERT INTO rooms (id,name,requirement,repo_path,status,created_at,updated_at) VALUES
               ('room','room','requirement','unused','paused','old','old');
             INSERT INTO members (id,room_id,name,worker) VALUES ('member','room','member','codex');
             INSERT INTO tasks (id,room_id,key,title,owner_id,status,created_at,updated_at) VALUES
               ('task','room','T1','task','member','completed','old','old');
             INSERT INTO runs (id,task_id,member_id,status,exit_code,log_path,error,started_at,ended_at) VALUES
               ('legacy','task','member','completed',0,'legacy-log','legacy error','old','old');",
        ).unwrap();
        assert!(!has_run_flow(&store), "fixture must start without the flow column");
        fs::write(store.prompts.join("legacy.md"), "legacy input").unwrap();
    }
    let store = Store::open(data.clone()).unwrap();
    assert!(has_run_flow(&store));
    let legacy: (String, String, Option<i64>, String, String) = store.db.lock().unwrap().query_row(
        "SELECT flow_json,status,exit_code,log_path,error FROM runs WHERE id='legacy'",
        [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
    ).unwrap();
    assert_eq!(legacy, (String::new(), "completed".into(), Some(0), "legacy-log".into(), "legacy error".into()));
    drop(store);

    // Reopening is idempotent: the column stays single and old rows stay untouched.
    let store = Store::open(data.clone()).unwrap();
    let columns: i64 = store.db.lock().unwrap().query_row(
        "SELECT COUNT(*) FROM pragma_table_info('runs') WHERE name='flow_json'", [], |row| row.get(0),
    ).unwrap();
    assert_eq!(columns, 1);
    let stored: String = store.db.lock().unwrap().query_row(
        "SELECT flow_json FROM runs WHERE id='legacy'", [], |row| row.get(0),
    ).unwrap();
    assert_eq!(stored, "");

    let app = api::router(Engine::new(store.clone()));
    let response = app.oneshot(Request::get("/api/tasks/task/prompt").body(Body::empty()).unwrap()).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let body: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["flow"], Value::Null);
    assert_eq!(body["runId"], "legacy");
    assert_eq!(body["status"], "completed");
    assert_eq!(body["exitCode"], 0);
    assert_eq!(body["prompt"], "legacy input");
    assert_eq!(body["available"], true);
    assert_eq!(body["readError"], "");
    assert_eq!(body["runsTruncated"], false);
    assert_eq!(body["runs"].as_array().unwrap().len(), 1);
    assert!(body["runs"][0].get("flow").is_none());
}

#[tokio::test]
async fn starting_a_run_records_the_current_room_flow_with_the_run() {
    let f = Fixture::new();
    let flow = json!({"nodes": [{"id": "planner", "type": "planner"}], "edges": []});
    let missing_repo = f.store.data.join("missing-repository");
    f.store.db.lock().unwrap().execute(
        "UPDATE rooms SET flow_json=?, repo_path=? WHERE id='room'",
        params![flow.to_string(), missing_repo.to_string_lossy()],
    ).unwrap();
    // The run row is reserved before worktree preparation, which fails for a missing repo.
    assert!(f.engine.start_task("task").await.is_err());
    let (stored_flow, stored_status): (String, String) = f.store.db.lock().unwrap().query_row(
        "SELECT flow_json,status FROM runs WHERE task_id='task'", [], |row| Ok((row.get(0)?, row.get(1)?)),
    ).unwrap();
    assert_eq!(stored_flow, flow.to_string());
    assert_eq!(stored_status, "failed");
    let (status, body) = f.get("task", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["flow"], flow);
    assert_eq!(body["status"], "failed");
    assert_eq!(body["runs"].as_array().unwrap().len(), 1);
}

