use std::fs;
use std::path::Path;
use std::time::Duration;

use devhub::engine::Engine;
use devhub::store::Store;
use rusqlite::{params, Connection, ErrorCode};
use tempfile::{tempdir, TempDir};

fn seed() -> TempDir {
    let dir = tempdir().unwrap();
    let data = dir.path().to_path_buf();
    drop(Store::open(data.clone()).unwrap());
    let log = data.join("logs/run-active.log");
    let worktree = data.join("worktrees/task-active");
    fs::create_dir(&worktree).unwrap();
    fs::write(&log, "worker output\n").unwrap();
    fs::write(worktree.join("draft.txt"), "unfinished work\n").unwrap();
    let conn = Connection::open(data.join("devhub.db")).unwrap();
    // Recreate a database written before the result_sha migration.
    conn.execute_batch(
        "ALTER TABLE tasks DROP COLUMN result_sha;
         INSERT INTO rooms (id, name, repo_path, status, created_at, updated_at) VALUES
            ('room', 'Active', 'unused-fixture-repo', 'running', 'old', 'old'),
            ('queue', 'Queue only', 'unused-fixture-repo', 'running', 'old', 'old'),
            ('paused', 'Already paused', 'unused-fixture-repo', 'paused', 'old', 'old'),
            ('archived', 'Archived', 'unused-fixture-repo', 'archived', 'old', 'old');
         INSERT INTO members (id, room_id, name, worker) VALUES ('member', 'room', 'Fixture', 'opencode');
         INSERT INTO tasks (id, room_id, key, title, owner_id, status, summary, deps_json, created_at, updated_at) VALUES
            ('task-active', 'room', 'T1', 'Active', 'member', 'running', 'previous summary', '[]', 'old', 'old'),
            ('task-ready', 'queue', 'T2', 'Ready', NULL, 'ready', 'previous summary', '[]', 'old', 'old'),
            ('task-backlog', 'room', 'T3', 'Waiting', NULL, 'backlog', '', '[\"T1\"]', 'old', 'old'),
            ('task-done', 'room', 'T4', 'Done', NULL, 'done', '', '[]', 'old', 'old'),
            ('task-no-run', 'paused', 'T1', 'No run row', NULL, 'running', '', '[]', 'old', 'old');
         INSERT INTO runs (id, task_id, member_id, status, session_id, exit_code, error, started_at, ended_at) VALUES
            ('run-active', 'task-active', 'member', 'running', 'existing-session', NULL, '', 'old', NULL),
            ('run-older', 'task-active', 'member', 'completed', '', 0, 'old details', 'old', 'old'),
            ('run-orphan', 'missing-task', 'member', 'running', '', NULL, '', 'old', NULL);",
    )
    .unwrap();
    conn.execute(
        "UPDATE tasks SET worktree=?, branch='devhub/fixture', base_sha='old-base' WHERE id='task-active'",
        params![worktree.to_str().unwrap()],
    )
    .unwrap();
    conn.execute(
        "UPDATE runs SET log_path=? WHERE id='run-active'",
        params![log.to_str().unwrap()],
    )
    .unwrap();
    dir
}

fn text(conn: &Connection, sql: &str) -> String {
    conn.query_row(sql, [], |row| row.get(0)).unwrap()
}

fn has_result_sha(conn: &Connection) -> bool {
    conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM pragma_table_info('tasks') WHERE name='result_sha')",
        [],
        |row| row.get(0),
    )
    .unwrap()
}

fn assert_locked(data: &Path) {
    let error = Store::open(data.to_path_buf())
        .err()
        .expect("instance lock");
    assert!(error
        .to_string()
        .contains("数据目录已被另一个 DevHub 实例使用"));
    assert!(error.to_string().contains(data.to_str().unwrap()));
}

#[test]
fn locks_only_the_selected_directory_before_opening_the_application_db() {
    let primary = seed();
    let other = tempdir().unwrap();
    let data = primary.path().to_path_buf();
    let lock = Connection::open(data.join("devhub.instance.sqlite")).unwrap();
    lock.execute_batch("BEGIN EXCLUSIVE").unwrap();
    assert_locked(&data);
    let conn = Connection::open(data.join("devhub.db")).unwrap();
    assert_eq!(
        text(&conn, "SELECT status FROM tasks WHERE id='task-active'"),
        "running"
    );
    assert!(!has_result_sha(&conn));
    let _independent = Store::open(other.path().to_path_buf()).unwrap();
    drop(lock);

    let store = Store::open(data.clone()).unwrap();
    let clone = store.clone();
    drop(store);
    assert_locked(&data);
    let contender = Connection::open(data.join("devhub.instance.sqlite")).unwrap();
    contender.busy_timeout(Duration::ZERO).unwrap();
    assert_eq!(
        contender
            .execute_batch("BEGIN EXCLUSIVE")
            .unwrap_err()
            .sqlite_error_code(),
        Some(ErrorCode::DatabaseBusy)
    );
    drop(clone);
    contender.execute_batch("BEGIN EXCLUSIVE").unwrap();
    drop(contender);
    Store::open(data).unwrap();
}

#[tokio::test]
async fn recovers_and_records_only_stale_rows_and_explicit_retry_stays_queued() {
    let dir = seed();
    let data = dir.path().to_path_buf();
    let store = Store::open(data.clone()).unwrap();
    let failed = store.task("task-active").unwrap().unwrap();
    let worktree = data.join("worktrees/task-active");
    let log = data.join("logs/run-active.log");
    assert_eq!(failed.status, "failed");
    assert!(failed.summary.contains("重启中断"));
    assert!(failed.summary.contains("手动重试"));
    assert_eq!(failed.worktree, worktree.to_str().unwrap());
    assert_eq!(failed.branch, "devhub/fixture");
    assert_eq!(failed.base_sha, "old-base");
    assert_eq!(store.task("task-no-run").unwrap().unwrap().status, "failed");
    assert_eq!(
        fs::read_to_string(worktree.join("draft.txt")).unwrap(),
        "unfinished work\n"
    );
    assert_eq!(fs::read_to_string(&log).unwrap(), "worker output\n");
    for (id, status) in [
        ("task-ready", "ready"),
        ("task-backlog", "backlog"),
        ("task-done", "done"),
    ] {
        let unchanged = store.task(id).unwrap().unwrap();
        assert_eq!(unchanged.status, status);
        assert_eq!(unchanged.updated_at, "old");
    }
    assert_eq!(
        store.task("task-ready").unwrap().unwrap().summary,
        "previous summary"
    );
    assert_eq!(
        store.task("task-backlog").unwrap().unwrap().deps_json,
        "[\"T1\"]"
    );
    assert_eq!(store.room("room").unwrap().unwrap().status, "paused");
    assert_eq!(store.room("queue").unwrap().unwrap().status, "paused");
    assert_eq!(store.room("paused").unwrap().unwrap().updated_at, "old");
    assert_eq!(store.room("archived").unwrap().unwrap().status, "archived");

    let conn = Connection::open(data.join("devhub.db")).unwrap();
    let active_run = "FROM runs WHERE id='run-active'";
    for (column, expected) in [
        ("status", "interrupted"),
        ("error", failed.summary.as_str()),
        ("ended_at", failed.updated_at.as_str()),
        ("started_at", "old"),
        ("log_path", log.to_str().unwrap()),
        ("session_id", "existing-session"),
        ("typeof(exit_code)", "null"),
    ] {
        assert_eq!(
            text(&conn, &format!("SELECT {column} {active_run}")),
            expected
        );
    }
    assert_ne!(failed.updated_at, "old");
    assert_eq!(
        text(&conn, "SELECT error FROM runs WHERE id='run-older'"),
        "old details"
    );
    assert_eq!(
        text(&conn, "SELECT status FROM runs WHERE id='run-orphan'"),
        "interrupted"
    );
    assert_eq!(
        text(&conn, "SELECT result_sha FROM tasks WHERE id='task-active'"),
        ""
    );
    let room_events = store.events("room").unwrap();
    assert_eq!(room_events.len(), 3);
    for (event, (kind, status)) in room_events.iter().zip([
        ("run.interrupted", "interrupted"),
        ("task.interrupted", "failed"),
        ("room.recovered", "paused"),
    ]) {
        assert_eq!(event["type"], kind);
        assert_eq!(event["payload"]["status"], status);
        assert!(event["payload"]["reason"]
            .as_str()
            .unwrap()
            .contains("重启"));
        assert_eq!(event["created_at"], failed.updated_at);
    }
    assert_eq!(room_events[0]["run_id"], "run-active");
    assert_eq!(room_events[1]["task_id"], "task-active");
    assert_eq!(store.events("queue").unwrap()[0]["type"], "room.recovered");
    assert_eq!(
        store.events("paused").unwrap()[0]["type"],
        "task.interrupted"
    );
    assert_eq!(
        text(&conn, "SELECT CAST(COUNT(*) AS TEXT) FROM events"),
        "6"
    );

    conn.execute(
        "UPDATE tasks SET result_sha='result-commit' WHERE id='task-done'",
        [],
    )
    .unwrap();
    drop(store);
    let store = Store::open(data).unwrap();
    assert_eq!(store.events("room").unwrap(), room_events);
    assert_eq!(
        text(&conn, "SELECT result_sha FROM tasks WHERE id='task-done'"),
        "result-commit"
    );
    let engine = Engine::new(store);
    // All queue rooms are paused. The explicit retry changes state but cannot launch a worker.
    assert_eq!(engine.store.room("room").unwrap().unwrap().status, "paused");
    engine.retry_task("task-active").await.unwrap();
    assert!(engine.running_tasks().await.is_empty());
    assert_eq!(
        engine.store.task("task-active").unwrap().unwrap().status,
        "ready"
    );
    assert_eq!(
        engine.store.task("task-ready").unwrap().unwrap().status,
        "ready"
    );
    assert_eq!(text(&conn, "SELECT CAST(COUNT(*) AS TEXT) FROM runs"), "3");
}

#[test]
fn recovery_failure_rolls_back_state_events_and_migration_and_releases_lock() {
    let dir = seed();
    let data = dir.path().to_path_buf();
    let conn = Connection::open(data.join("devhub.db")).unwrap();
    conn.execute_batch(
        "CREATE TRIGGER abort_recovery BEFORE INSERT ON events
         WHEN NEW.type='room.recovered' BEGIN SELECT RAISE(ABORT, 'recovery fixture'); END;",
    )
    .unwrap();
    let error = Store::open(data.clone())
        .err()
        .expect("trigger should abort recovery");
    assert!(format!("{error:#}").contains("recovery fixture"));
    for (table, id) in [
        ("runs", "run-active"),
        ("tasks", "task-active"),
        ("rooms", "room"),
    ] {
        assert_eq!(
            text(
                &conn,
                &format!("SELECT status FROM {table} WHERE id='{id}'")
            ),
            "running"
        );
    }
    assert_eq!(
        text(&conn, "SELECT CAST(COUNT(*) AS TEXT) FROM events"),
        "0"
    );
    assert!(!has_result_sha(&conn));
    conn.execute_batch("DROP TRIGGER abort_recovery").unwrap();
    let _store = Store::open(data).unwrap();
    assert_eq!(
        text(&conn, "SELECT status FROM runs WHERE id='run-active'"),
        "interrupted"
    );
}
