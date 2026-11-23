use std::collections::HashSet;
use std::sync::Arc;

use axum::{body::Body, http::{Request, StatusCode}};
use devhub::{api, engine::Engine, store::Store};
use http_body_util::BodyExt;
use rusqlite::params;
use serde_json::{json, Value};
use tokio::sync::broadcast;
use tower::ServiceExt;

struct Fixture {
    _dir: tempfile::TempDir,
    engine: Engine,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().join("data")).unwrap();
        {
            let db = store.db.lock().unwrap();
            db.execute_batch(
                "INSERT INTO rooms (id,name,repo_path,status,created_at,updated_at) VALUES
                   ('room','room','unused','paused','old','old'),
                   ('other','other','unused','paused','old','old');
                 INSERT INTO members (id,room_id,name,worker,enabled,sort) VALUES
                   ('disabled','room','disabled','codex',0,0),
                   ('first','room','Zulu','dsh',1,1),
                   ('second','room','Alpha','claude',1,2),
                   ('foreign','other','Foreign','opencode',1,0);"
            ).unwrap();
        }
        Self { _dir: dir, engine: Engine::new(store) }
    }

    async fn request(&self, input: Value) -> (StatusCode, Value) {
        self.raw(&input.to_string()).await
    }

    async fn raw(&self, input: &str) -> (StatusCode, Value) {
        let response = api::router(self.engine.clone()).oneshot(
            Request::builder().method("POST").uri("/api/tasks")
                .header("content-type", "application/json").body(Body::from(input.to_string())).unwrap(),
        ).await.unwrap();
        let status = response.status();
        let body = response.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&body).expect("task API must return JSON"))
    }

    fn seed(&self, id: &str, key: &str, status: &str, deps: &str) {
        self.engine.store.db.lock().unwrap().execute(
            "INSERT INTO tasks (id,room_id,key,title,owner_id,status,deps_json,created_at,updated_at)
             VALUES (?,'room',?,?,'first',?,?,'old','old')", params![id, key, key, status, deps],
        ).unwrap();
    }

    fn counts(&self) -> (i64, i64) {
        let db = self.engine.store.db.lock().unwrap();
        let tasks = db.query_row("SELECT COUNT(*) FROM tasks", [], |r| r.get(0)).unwrap();
        let events = db.query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0)).unwrap();
        (tasks, events)
    }

    async fn reject(&self, input: Value, expected: StatusCode) {
        let counts = self.counts();
        let mut receiver = self.engine.store.subscribe();
        let (status, body) = self.request(input).await;
        assert_eq!(status, expected, "{body}");
        assert!(body["error"].as_str().map(|s| !s.is_empty()).unwrap_or(false));
        assert_eq!(self.counts(), counts);
        assert!(matches!(receiver.try_recv(), Err(broadcast::error::TryRecvError::Empty)));
    }
}

#[tokio::test]
async fn malformed_fields_return_bad_request_without_persisting_or_broadcasting() {
    let f = Fixture::new();
    for input in [json!(null), json!([]), json!(false), json!("room"), json!({}),
        json!({"roomId":null}), json!({"roomId":3}), json!({"roomId":" "})] {
        f.reject(input, StatusCode::BAD_REQUEST).await;
    }
    for (field, invalid) in [
        ("title", json!(null)), ("title", json!(3)), ("spec", json!(null)), ("spec", json!([])),
        ("type", json!(null)), ("type", json!("Code")), ("type", json!("other")),
        ("ownerId", json!(3)), ("ownerId", json!(false)),
        ("deps", json!(null)), ("deps", json!("T1")), ("deps", json!([3])), ("deps", json!([" "])),
        ("acceptance", json!(null)), ("acceptance", json!({})), ("acceptance", json!([null])),
        ("acceptance", json!(["ok", " "])),
    ] {
        let mut input = json!({"roomId":"room"});
        input[field] = invalid;
        f.reject(input, StatusCode::BAD_REQUEST).await;
    }
}

#[tokio::test]
async fn invalid_json_unknown_rooms_and_archived_rooms_have_specific_statuses() {
    let f = Fixture::new();
    for raw in ["", "{", "undefined"] {
        let (status, body) = f.raw(raw).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    }
    f.reject(json!({"roomId":"missing"}), StatusCode::NOT_FOUND).await;
    f.engine.store.db.lock().unwrap().execute("UPDATE rooms SET status='archived' WHERE id='room'", []).unwrap();
    f.reject(json!({"roomId":"room"}), StatusCode::CONFLICT).await;
    assert_eq!(f.counts(), (0, 0));
}

#[tokio::test]
async fn defaults_normalize_title_choose_first_enabled_owner_and_stay_queued() {
    let f = Fixture::new();
    f.engine.store.db.lock().unwrap().execute("UPDATE rooms SET status='running' WHERE id='room'", []).unwrap();
    for owner in [None, Some(json!(null)), Some(json!("  "))] {
        let mut input = json!({"roomId":" room ","title":" \n ","spec":"  line one\nline two  ","acceptance":[" verify one ","verify two"]});
        if let Some(owner) = owner { input["ownerId"] = owner; }
        let (status, body) = f.request(input).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let task = f.engine.store.task(body["id"].as_str().unwrap()).unwrap().unwrap();
        assert_eq!(task.title, "新任务");
        assert_eq!(task.spec, "  line one\nline two  ");
        assert_eq!(task.owner_id.as_deref(), Some("first"));
        assert_eq!(task.task_type, "code");
        assert_eq!(task.status, "backlog");
        assert_eq!(task.deps_json, "[]");
        assert_eq!(task.acceptance_json, r#"["verify one","verify two"]"#);
        assert!(f.engine.running_tasks().await.is_empty());
        assert_eq!(f.engine.store.events("room").unwrap().last().unwrap()["payload"]["title"], "新任务");
    }
    for kind in ["code", "document", "research"] {
        let (status, body) = f.request(json!({"roomId":"room","title":"  title  ","type":kind,"ownerId":" second "})).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let task = f.engine.store.task(body["id"].as_str().unwrap()).unwrap().unwrap();
        assert_eq!(task.title, "title");
        assert_eq!(task.owner_id.as_deref(), Some("second"));
        assert_eq!(task.task_type, kind);
        assert_eq!(task.spec, "");
    }
}

#[tokio::test]
async fn owners_must_be_enabled_in_the_room_and_have_a_known_worker_key() {
    let f = Fixture::new();
    for owner in ["foreign", "disabled", "missing"] {
        f.reject(json!({"roomId":"room","ownerId":owner}), StatusCode::BAD_REQUEST).await;
    }
    f.engine.store.db.lock().unwrap().execute("UPDATE members SET worker='unknown' WHERE id='first'", []).unwrap();
    f.reject(json!({"roomId":"room"}), StatusCode::BAD_REQUEST).await;
    let (status, body) = f.request(json!({"roomId":"room","ownerId":"second"})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    f.engine.store.db.lock().unwrap().execute("UPDATE members SET enabled=0 WHERE room_id='room'", []).unwrap();
    f.reject(json!({"roomId":"room"}), StatusCode::BAD_REQUEST).await;
}

#[tokio::test]
async fn dependencies_allow_pending_and_completed_tasks_but_reject_unknown_repeated_and_self_keys() {
    let f = Fixture::new();
    f.seed("one", "T1", "backlog", "[]");
    f.seed("two", "T2", "merged", "[]");
    for deps in [json!(["missing"]), json!(["T1", " T1 "]), json!(["T3"])] {
        f.reject(json!({"roomId":"room","deps":deps}), StatusCode::BAD_REQUEST).await;
    }
    let (status, body) = f.request(json!({"roomId":"room","deps":[" T1 ","T2"]})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let task = f.engine.store.task(body["id"].as_str().unwrap()).unwrap().unwrap();
    assert_eq!(task.deps_json, r#"["T1","T2"]"#);
    assert_eq!(task.status, "backlog");
}

#[tokio::test]
async fn selected_dependency_chains_reject_cycles_ambiguity_and_malformed_upstream_data() {
    let f = Fixture::new();
    f.seed("one", "T1", "ready", "[]");
    f.seed("two", "T2", "backlog", "[]");
    for deps in ["null", "{}", "[3]", "[\" \" ]", "[\"missing\"]", "[\"T1\"]", "[\"T2\",\" T2 \"]", "[\" T2 \"]", "[\"T2\",\"T2\"]", "[\"T3\"]"] {
        f.engine.store.db.lock().unwrap().execute("UPDATE tasks SET deps_json=? WHERE id='one'", params![deps]).unwrap();
        f.reject(json!({"roomId":"room","deps":["T1"]}), StatusCode::BAD_REQUEST).await;
    }
    f.engine.store.db.lock().unwrap().execute_batch("UPDATE tasks SET deps_json='[\"T2\"]' WHERE id='one'; UPDATE tasks SET deps_json='[\"T1\"]' WHERE id='two';").unwrap();
    f.reject(json!({"roomId":"room","deps":["T1"]}), StatusCode::BAD_REQUEST).await;
    f.engine.store.db.lock().unwrap().execute_batch("UPDATE tasks SET deps_json='[]'; UPDATE tasks SET key='T1' WHERE id='two';").unwrap();
    f.reject(json!({"roomId":"room","deps":["T1"]}), StatusCode::BAD_REQUEST).await;
}

#[tokio::test]
async fn unrelated_bad_tasks_do_not_block_creation_and_completed_chains_stop_traversal() {
    let f = Fixture::new();
    f.seed("broken", "T1", "failed", "null");
    f.seed("done", "T2", "done", "[\"T1\"]");
    f.seed("duplicate", "T1", "ready", "[\"missing\"]");
    for deps in [json!([]), json!(["T2"])] {
        let (status, body) = f.request(json!({"roomId":"room","deps":deps})).await;
        assert_eq!(status, StatusCode::OK, "{body}");
    }
    for status in ["done", "merged"] {
        for old_deps in [r#"[" T1 "]"#, r#"["T1","T1"]"#] {
            f.engine.store.db.lock().unwrap().execute(
                "UPDATE tasks SET status=?, deps_json=? WHERE id='done'", params![status, old_deps],
            ).unwrap();
            let (status, body) = f.request(json!({"roomId":"room","deps":["T2"]})).await;
            assert_eq!(status, StatusCode::OK, "{body}");
        }
    }
}

#[tokio::test]
async fn sparse_task_numbers_and_parallel_creations_never_reuse_a_key() {
    let f = Fixture::new();
    f.seed("one", "T1", "done", "[]");
    f.seed("three", "T3", "done", "[]");
    let (status, body) = f.request(json!({"roomId":"room"})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(f.engine.store.task(body["id"].as_str().unwrap()).unwrap().unwrap().key, "T4");
    let barrier = Arc::new(std::sync::Barrier::new(12));
    let mut threads = Vec::new();
    for _ in 0..12 {
        let engine = f.engine.clone();
        let barrier = barrier.clone();
        threads.push(std::thread::spawn(move || {
            barrier.wait();
            engine.create_task(&json!({"roomId":"room"})).unwrap()
        }));
    }
    let ids = threads.into_iter().map(|thread| thread.join().unwrap()).collect::<HashSet<_>>();
    assert_eq!(ids.len(), 12);
    let tasks = f.engine.store.tasks("room").unwrap();
    assert_eq!(tasks.len(), 15);
    assert_eq!(tasks.iter().map(|task| &task.key).collect::<HashSet<_>>().len(), tasks.len());
}

#[tokio::test]
async fn task_creation_and_event_failures_roll_back_everything_and_leave_retry_available() {
    for failure in ["insert", "event", "commit"] {
        let f = Fixture::new();
        let mut receiver = f.engine.store.subscribe();
        {
            let db = f.engine.store.db.lock().unwrap();
            let statement = match failure {
                "insert" => "CREATE TRIGGER fail_creation BEFORE INSERT ON tasks BEGIN SELECT RAISE(ABORT,'creation fixture'); END;",
                "event" => "CREATE TRIGGER fail_creation BEFORE INSERT ON events WHEN NEW.type='task.created' BEGIN SELECT RAISE(ABORT,'creation fixture'); END;",
                "commit" => "PRAGMA foreign_keys=ON; CREATE TABLE creation_guard (room_id TEXT REFERENCES rooms(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER fail_creation AFTER INSERT ON events WHEN NEW.type='task.created' BEGIN INSERT INTO creation_guard VALUES ('missing'); END;",
                _ => unreachable!(),
            };
            db.execute_batch(statement).unwrap();
        }
        let (status, body) = f.request(json!({"roomId":"room"})).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{failure}: {body}");
        assert_eq!(f.counts(), (0, 0), "{failure}");
        assert!(matches!(receiver.try_recv(), Err(broadcast::error::TryRecvError::Empty)));
        f.engine.store.db.lock().unwrap().execute_batch("DROP TRIGGER fail_creation").unwrap();
        let (status, body) = f.request(json!({"roomId":"room"})).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let task = f.engine.store.task(body["id"].as_str().unwrap()).unwrap().unwrap();
        assert_eq!(task.key, "T1");
        assert_eq!(f.counts(), (1, 1));
        let event = receiver.try_recv().unwrap();
        assert_eq!(event["type"], "task.created");
        assert_eq!(event["payload"]["title"], "新任务");
        assert!(matches!(receiver.try_recv(), Err(broadcast::error::TryRecvError::Empty)));
    }
}

#[tokio::test]
async fn completed_rooms_pause_atomically_when_new_work_is_created() {
    for failure in ["room_update", "room_event", "task_event", "commit"] {
        let f = Fixture::new();
        {
            let db = f.engine.store.db.lock().unwrap();
            db.execute("UPDATE rooms SET status='completed' WHERE id='room'", []).unwrap();
            let sql = match failure {
                "room_update" => "CREATE TRIGGER fail_creation BEFORE UPDATE OF status ON rooms BEGIN SELECT RAISE(ABORT,'creation fixture'); END;",
                "room_event" => "CREATE TRIGGER fail_creation BEFORE INSERT ON events WHEN NEW.type='room.paused' BEGIN SELECT RAISE(ABORT,'creation fixture'); END;",
                "task_event" => "CREATE TRIGGER fail_creation BEFORE INSERT ON events WHEN NEW.type='task.created' BEGIN SELECT RAISE(ABORT,'creation fixture'); END;",
                "commit" => "PRAGMA foreign_keys=ON; CREATE TABLE creation_guard (room_id TEXT REFERENCES rooms(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER fail_creation AFTER INSERT ON events WHEN NEW.type='task.created' BEGIN INSERT INTO creation_guard VALUES ('missing'); END;",
                _ => unreachable!(),
            };
            db.execute_batch(sql).unwrap();
        }
        let mut receiver = f.engine.store.subscribe();
        let (status, body) = f.request(json!({"roomId":"room"})).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{failure}: {body}");
        assert_eq!(f.counts(), (0, 0));
        let room = f.engine.store.room("room").unwrap().unwrap();
        assert_eq!(room.status, "completed");
        assert_eq!(room.updated_at, "old");
        assert!(matches!(receiver.try_recv(), Err(broadcast::error::TryRecvError::Empty)));
        f.engine.store.db.lock().unwrap().execute_batch("DROP TRIGGER fail_creation").unwrap();
        let (status, body) = f.request(json!({"roomId":"room"})).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(f.engine.store.room("room").unwrap().unwrap().status, "paused");
        assert_eq!(f.engine.store.task(body["id"].as_str().unwrap()).unwrap().unwrap().status, "backlog");
        assert_eq!(f.counts(), (1, 2));
        let paused = receiver.try_recv().unwrap();
        assert_eq!(paused["type"], "room.paused");
        assert_eq!(paused["payload"]["reason"], "task.created");
        assert_eq!(receiver.try_recv().unwrap()["type"], "task.created");
        assert!(matches!(receiver.try_recv(), Err(broadcast::error::TryRecvError::Empty)));
        assert!(f.engine.running_tasks().await.is_empty());
    }
}

#[tokio::test]
async fn deep_dependency_chains_and_shared_branches_validate_without_recursion() {
    let f = Fixture::new();
    {
        let mut db = f.engine.store.db.lock().unwrap();
        let tx = db.transaction().unwrap();
        for number in 1..=5000 {
            let key = format!("T{number}");
            let deps = if number == 5000 { "[]".to_string() } else { json!([format!("T{}", number + 1)]).to_string() };
            tx.execute(
                "INSERT INTO tasks (id,room_id,key,title,owner_id,status,deps_json,created_at,updated_at)
                 VALUES (?,'room',?,'upstream','first','backlog',?,'old','old')", params![key, key, deps],
            ).unwrap();
        }
        tx.commit().unwrap();
    }
    let (status, body) = f.request(json!({"roomId":"room","deps":["T1","T2"]})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(f.engine.store.task(body["id"].as_str().unwrap()).unwrap().unwrap().key, "T5001");
}

#[tokio::test(flavor="multi_thread", worker_threads=2)]
async fn task_created_broadcast_identifies_a_committed_task_and_event() {
    let f = Fixture::new();
    let mut receiver = f.engine.store.subscribe();
    let db = rusqlite::Connection::open(f.engine.store.data.join("devhub.db")).unwrap();
    let observer = tokio::spawn(async move {
        let event = receiver.recv().await.unwrap();
        let task_id = event["task_id"].as_str().unwrap();
        let task: (String, String) = db.query_row("SELECT title,status FROM tasks WHERE id=?", params![task_id], |r| Ok((r.get(0)?,r.get(1)?))).unwrap();
        assert_eq!(task, ("新任务".into(), "backlog".into()));
        let persisted: String = db.query_row("SELECT payload FROM events WHERE id=?", params![event["id"].as_i64().unwrap()], |r| r.get(0)).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&persisted).unwrap(), event["payload"]);
    });
    let (status, body) = f.request(json!({"roomId":"room"})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    tokio::time::timeout(std::time::Duration::from_secs(5), observer).await.unwrap().unwrap();
}
