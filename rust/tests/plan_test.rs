use devhub::{engine::Engine, store::Store};
use rusqlite::params;
use serde_json::{json, Value};

fn fixture() -> (tempfile::TempDir, Store, Engine) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("data")).unwrap();
    {
        let db = store.db.lock().unwrap();
        db.execute(
            "INSERT INTO rooms (id, name, repo_path, plan_json, created_at, updated_at)
             VALUES ('r_test', '测试会话', '.', ?, 'now', 'now')",
            params![json!({"tasks": [{"title": "待确认"}]}).to_string()],
        )
        .unwrap();
        db.execute(
            "INSERT INTO members (id, room_id, name, worker)
             VALUES ('m_test', 'r_test', '协作助手', 'codex')",
            [],
        )
        .unwrap();
        db.execute(
            "INSERT INTO tasks (id, room_id, key, title, status, created_at, updated_at)
             VALUES ('t_existing', 'r_test', 'T1', '原任务', 'ready', 'now', 'now')",
            [],
        )
        .unwrap();
    }
    let engine = Engine::new(store.clone());
    (dir, store, engine)
}

fn valid_plan() -> Value {
    json!({
        "tasks": [
            {"title": "检查现状"},
            {"title": "实现", "owner": "协作助手", "dependsOn": [1]},
        ],
        "decisions": ["先写验收标准"]
    })
}

#[test]
fn rejected_dependency_graph_keeps_the_existing_plan() {
    let (_dir, store, engine) = fixture();
    let invalid = [
        json!([{"title": "一", "dependsOn": [2]}, {"title": "二", "dependsOn": [1]}]),
        json!([{"title": "一", "dependsOn": [2]}]),
        json!([{"title": "一", "dependsOn": [1]}]),
        json!([{"title": "一", "dependsOn": ["1"]}]),
    ];
    for tasks in invalid {
        let result = engine.apply_plan("r_test", &json!({"tasks": tasks}));
        assert!(result.is_err());
        assert_eq!(store.tasks("r_test").unwrap()[0].id, "t_existing");
        assert!(!store.room("r_test").unwrap().unwrap().plan_json.is_empty());
    }
}

#[test]
fn valid_plan_puts_only_unblocked_tasks_in_the_ready_queue() {
    let (_dir, store, engine) = fixture();
    engine.apply_plan("r_test", &valid_plan()).unwrap();
    let mut tasks = store.tasks("r_test").unwrap();
    tasks.sort_by_key(|task| task.key.clone());
    assert_eq!(tasks.len(), 2);
    assert_eq!(tasks[0].status, "ready");
    assert_eq!(tasks[1].status, "backlog");
    assert_eq!(tasks[1].deps_json, r#"["T1"]"#);
    assert_eq!(store.decisions("r_test").unwrap().len(), 1);
    assert!(store.room("r_test").unwrap().unwrap().plan_json.is_empty());
}

#[test]
fn failure_at_the_end_of_apply_rolls_back_all_records() {
    let (_dir, store, engine) = fixture();
    store
        .db
        .lock()
        .unwrap()
        .execute_batch(
            "CREATE TRIGGER plan_test_failure BEFORE UPDATE OF plan_json ON rooms
                BEGIN SELECT RAISE(ABORT, 'test rollback'); END;",
        )
        .unwrap();
    let original = store.room("r_test").unwrap().unwrap().plan_json;
    let error = engine.apply_plan("r_test", &valid_plan()).unwrap_err();
    assert!(error.to_string().contains("test rollback"), "{error}");
    assert_eq!(store.room("r_test").unwrap().unwrap().plan_json, original);
    let tasks = store.tasks("r_test").unwrap();
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0].id, "t_existing");
    assert!(store.decisions("r_test").unwrap().is_empty());
}
