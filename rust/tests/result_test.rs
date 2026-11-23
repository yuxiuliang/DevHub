use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use devhub::{
    api,
    engine::{Engine, ResultConflict},
    store::Store,
};
use http_body_util::BodyExt;
use rusqlite::params;
use serde_json::{json, Value};
use tokio::sync::broadcast;
use tower::ServiceExt;

struct Fixture {
    _dir: tempfile::TempDir,
    root: PathBuf,
    repo: PathBuf,
    worktree: PathBuf,
    base: String,
    result: String,
    store: Store,
    engine: Engine,
}

impl Fixture {
    fn new(status: &str, pinned: bool) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let repo = root.join("repo");
        let worktree = root.join("task-worktree");
        std::fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "-b", "main"]);
        std::fs::write(repo.join("README.md"), "result fixture\n").unwrap();
        commit(&repo, "initial");
        let base = git(&repo, &["rev-parse", "HEAD"]);
        git(
            &repo,
            &[
                "worktree",
                "add",
                "-b",
                "task-one",
                worktree.to_str().unwrap(),
                &base,
            ],
        );
        std::fs::write(worktree.join("feature.txt"), "fixed result\n").unwrap();
        commit(&worktree, "fixed result");
        let result = git(&worktree, &["rev-parse", "HEAD"]);
        let store = Store::open(root.join("temporary-data")).unwrap();
        {
            let db = store.db.lock().unwrap();
            db.execute("INSERT INTO rooms (id,name,repo_path,base_branch,status,reviewer_id,created_at,updated_at) VALUES ('r1','result test',?,'main','paused','m1','now','now')", params![repo.to_str().unwrap()]).unwrap();
            db.execute("INSERT INTO members (id,room_id,name,worker,concurrency) VALUES ('m1','r1','mock reviewer','codex',2)", []).unwrap();
            db.execute("INSERT INTO tasks (id,room_id,key,title,owner_id,status,worktree,branch,base_sha,result_sha,diff_stat,created_at,updated_at) VALUES ('T1','r1','T1','result test','m1',?,?, 'task-one',?,?,'feature.txt | 1 +','now','now')",
                params![status, worktree.to_str().unwrap(), base, if pinned { &result } else { "" }]).unwrap();
        }
        let engine = Engine::new(store.clone());
        let fixture = Self {
            _dir: dir,
            root,
            repo,
            worktree,
            base,
            result,
            store,
            engine,
        };
        fixture.worker(
            "",
            json!({"verdict":"approve","blocking":[],"notes":"checked"}),
            0,
        );
        fixture
    }

    fn worker(&self, commands: &str, verdict: Value, code: i32) {
        let script = self.root.join(if cfg!(windows) {
            "fake-worker.cmd"
        } else {
            "fake-worker.sh"
        });
        let text = verdict
            .as_str()
            .map(str::to_string)
            .unwrap_or_else(|| verdict.to_string());
        let output = json!({"type":"item.completed", "item":{"type":"agent_message","text":text}})
            .to_string();
        let body = if cfg!(windows) {
            format!("@echo off\r\n{commands}\r\necho {output}\r\nexit /b {code}\r\n")
        } else {
            format!("#!/bin/sh\n{commands}\nprintf '%s\\n' '{output}'\nexit {code}\n")
        };
        std::fs::write(&script, body).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        std::fs::write(
            self.store.data.join("env.json"),
            json!({"DEVHUB_CODEX_PATH":script}).to_string(),
        )
        .unwrap();
    }

    fn gated_worker(&self) -> (PathBuf, PathBuf) {
        let started = self.root.join("review-started");
        let gate = self.root.join("review-release");
        let commands = if cfg!(windows) {
            format!("echo started>\"{}\"\r\npowershell.exe -NoProfile -Command \"while (-not (Test-Path -LiteralPath '{}')) {{ Start-Sleep -Milliseconds 20 }}\"", started.display(), gate.display())
        } else {
            format!(
                "touch '{}'\nwhile [ ! -f '{}' ]; do sleep 0.02; done",
                started.display(),
                gate.display()
            )
        };
        self.worker(&commands, json!({"verdict":"approve","blocking":[]}), 0);
        (started, gate)
    }

    fn task(&self) -> devhub::models::Task {
        self.store.task("T1").unwrap().unwrap()
    }

    fn extra_commit(&self) -> String {
        std::fs::write(self.worktree.join("late.txt"), "later branch content\n").unwrap();
        commit(&self.worktree, "later branch change");
        git(&self.worktree, &["rev-parse", "HEAD"])
    }

    fn status(&self, status: &str) {
        self.store
            .db
            .lock()
            .unwrap()
            .execute("UPDATE tasks SET status=? WHERE id='T1'", params![status])
            .unwrap();
    }

    async fn request(&self, method: &str, path: &str, body: Option<Value>) -> (StatusCode, Value) {
        let request = Request::builder()
            .method(method)
            .uri(path)
            .header("content-type", "application/json")
            .body(Body::from(
                body.map(|body| body.to_string()).unwrap_or_default(),
            ))
            .unwrap();
        let response = api::router(self.engine.clone())
            .oneshot(request)
            .await
            .unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&bytes).unwrap())
    }
}

fn git(repo: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

fn commit(repo: &Path, message: &str) {
    git(repo, &["add", "-A"]);
    git(
        repo,
        &[
            "-c",
            "user.name=DevHub",
            "-c",
            "user.email=devhub@local",
            "commit",
            "-m",
            message,
            "--no-verify",
        ],
    );
}

async fn marker(path: &Path) {
    tokio::time::timeout(Duration::from_secs(15), async {
        while !path.exists() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("mock worker did not start");
}

async fn event(rx: &mut broadcast::Receiver<Value>, kind: &str) {
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            if rx.recv().await.unwrap()["type"] == kind {
                break;
            }
        }
    })
    .await
    .expect("missing operation event");
}

#[tokio::test]
async fn successful_run_writes_status_and_pinned_commit_in_the_same_update() {
    let f = Fixture::new("ready", false);
    f.worker("echo produced>produced.txt", json!("produced"), 0);
    f.store.db.lock().unwrap().execute_batch("CREATE TRIGGER require_atomic_result BEFORE UPDATE OF status ON tasks WHEN NEW.status IN ('review','done') AND NEW.result_sha='' BEGIN SELECT RAISE(ABORT,'status missing fixed result'); END;").unwrap();
    assert_eq!(f.engine.start_task("T1").await.unwrap()["ok"], true);
    let task = f.task();
    let head = git(&f.worktree, &["rev-parse", "HEAD"]);
    assert_eq!(task.status, "review");
    assert_eq!(task.result_sha, head);
    let diff = f.engine.task_diff("T1").await.unwrap();
    assert_eq!(diff["resultSha"], head);
    assert!(diff["diff"].as_str().unwrap().contains("produced.txt"));
}

#[tokio::test]
async fn failed_rerun_keeps_the_prior_result_readable_but_cannot_merge_or_review() {
    let f = Fixture::new("changes_requested", true);
    f.worker("echo failed>failed.txt", json!("failed run"), 8);
    assert_eq!(f.engine.start_task("T1").await.unwrap()["ok"], false);
    assert_eq!(f.task().status, "failed");
    assert_eq!(f.task().result_sha, f.result);
    let diff = f.engine.task_diff("T1").await.unwrap();
    assert_eq!(diff["resultSha"], f.result);
    assert!(!diff["diff"].as_str().unwrap().contains("failed.txt"));
    assert!(f.engine.merge_task("T1").await.is_err());
    assert!(f.engine.review_task("T1").await.is_err());
}

#[tokio::test]
async fn legacy_result_freezes_branch_once_and_get_never_collects_dirty_files() {
    let f = Fixture::new("review", false);
    std::fs::write(f.worktree.join("feature.txt"), "dirty tracked content\n").unwrap();
    std::fs::write(f.worktree.join("untracked.txt"), "untracked content\n").unwrap();
    let first = f.engine.task_diff("T1").await.unwrap();
    assert_eq!(first["resultSha"], f.result);
    assert_eq!(f.task().result_sha, f.result);
    assert!(!first["diff"].as_str().unwrap().contains("dirty tracked"));
    assert!(!first["diff"].as_str().unwrap().contains("untracked.txt"));
    let advanced = f.extra_commit();
    assert_ne!(advanced, f.result);
    assert_eq!(f.engine.task_diff("T1").await.unwrap(), first);
    git(&f.repo, &["update-ref", "-d", "refs/heads/task-one"]);
    assert_eq!(f.engine.task_diff("T1").await.unwrap(), first);
}

#[tokio::test]
async fn stale_and_invalid_expected_sha_return_http_conflict_without_modifying_a_legacy_task() {
    let f = Fixture::new("review", false);
    for action in ["review", "merge"] {
        for selected in [
            json!(null),
            json!(""),
            json!(&f.result[..7]),
            json!("0".repeat(40)),
        ] {
            let (status, body) = f
                .request(
                    "POST",
                    &format!("/api/tasks/T1/{action}"),
                    Some(json!({"resultSha":selected})),
                )
                .await;
            assert_eq!(status, StatusCode::CONFLICT, "{action}: {body}");
            assert!(body["error"].as_str().unwrap().contains("刷新 Diff"));
            assert!(f.task().result_sha.is_empty());
            assert_eq!(f.task().status, "review");
            assert_eq!(f.store.review_count("T1").unwrap(), 0);
        }
    }
    let (status, body) = f.request("GET", "/api/tasks/T1/diff", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["resultSha"], f.result);
    assert!(body["diff"].as_str().unwrap().contains("fixed result"));
}

#[tokio::test]
async fn review_requires_a_clean_tracked_worktree_at_the_fixed_commit() {
    for moved_head in [true, false] {
        let f = Fixture::new("review", true);
        if moved_head {
            f.extra_commit();
        } else {
            std::fs::write(f.worktree.join("feature.txt"), "dirty tracked\n").unwrap();
        }
        let error = f
            .engine
            .review_task_result("T1", Some(f.result.clone()))
            .await
            .unwrap_err();
        assert!(error.is::<ResultConflict>(), "{error:?}");
        assert!(
            error.to_string().contains("工作区已偏离固定成果"),
            "{error}"
        );
        assert_eq!(f.task().status, "review");
        assert_eq!(f.store.review_count("T1").unwrap(), 0);
        assert_eq!(std::fs::read_dir(&f.store.prompts).unwrap().count(), 0);
    }
}

#[tokio::test]
async fn review_ignores_untracked_files_and_records_the_exact_result() {
    let f = Fixture::new("review", true);
    std::fs::write(f.worktree.join("untracked.txt"), "keep me\n").unwrap();
    let result = f
        .engine
        .review_task_result("T1", Some(f.result.to_uppercase()))
        .await
        .unwrap();
    assert_eq!(result["resultSha"], f.result);
    assert_eq!(result["verdict"]["resultSha"], f.result);
    assert_eq!(f.task().status, "approved");
    let reviews = f.store.reviews("r1").unwrap();
    assert_eq!(reviews.len(), 1);
    assert_eq!(
        serde_json::from_str::<Value>(&reviews[0].payload).unwrap()["resultSha"],
        f.result
    );
    assert_eq!(git(&f.worktree, &["rev-parse", "HEAD"]), f.result);
    assert!(f.worktree.join("untracked.txt").exists());
}

#[tokio::test]
async fn review_process_failure_invalid_verdict_and_modifications_never_approve() {
    let cases = [
        ("", json!({"verdict":"approve","blocking":[]}), 6, "未成功结束"),
        ("", json!("not json"), 0, "合法结论"),
        ("", json!({"verdict":"approve","blocking":[{"issue":"stop"}]}), 0, "通过和阻塞"),
        ("", json!({"verdict":"other"}), 0, "合法结论"),
        ("", json!({"verdict":"approve","blocking":[1]}), 0, "合法结论"),
        ("echo changed>feature.txt", json!({"verdict":"approve","blocking":[]}), 0, "修改了已跟踪"),
        ("echo changed>feature.txt\ngit add -A\ngit -c user.name=DevHub -c user.email=devhub@local commit -m reviewer-change", json!({"verdict":"approve","blocking":[]}), 0, "修改了已跟踪"),
    ];
    for (commands, verdict, code, expected) in cases {
        let f = Fixture::new("review", true);
        f.worker(
            &commands.replace('\n', if cfg!(windows) { "\r\n" } else { "\n" }),
            verdict,
            code,
        );
        let error = f.engine.review_task("T1").await.unwrap_err().to_string();
        assert!(error.contains(expected), "{commands}: {error}");
        assert_eq!(f.task().status, "review");
        assert_eq!(f.task().result_sha, f.result);
        assert_eq!(f.store.review_count("T1").unwrap(), 0);
    }
}

#[tokio::test]
async fn merge_uses_the_fixed_sha_even_after_branch_moves_and_worktree_is_dirty() {
    let f = Fixture::new("review", true);
    f.extra_commit();
    std::fs::write(f.worktree.join("feature.txt"), "uncommitted content\n").unwrap();
    std::fs::write(f.worktree.join("untracked.txt"), "untracked content\n").unwrap();
    let result = f
        .engine
        .merge_task_result("T1", Some(f.result.clone()))
        .await
        .unwrap();
    assert_eq!(result["resultSha"], f.result);
    assert_eq!(f.task().status, "merged");
    assert_eq!(git(&f.repo, &["show", "main:feature.txt"]), "fixed result");
    assert!(!f.repo.join("late.txt").exists());
    assert!(!f.repo.join("untracked.txt").exists());
    assert_eq!(
        std::fs::read_to_string(f.worktree.join("feature.txt")).unwrap(),
        "uncommitted content\n"
    );
    assert!(f.worktree.join("untracked.txt").exists());
    assert_eq!(git(&f.repo, &["rev-list", "--count", "main"]), "2");
}

#[tokio::test]
async fn failed_merge_status_can_retry_without_duplicate_commit() {
    retry_after_merge_status_failure(false).await;
}

#[tokio::test]
async fn failed_merge_status_can_retry_after_store_restart() {
    retry_after_merge_status_failure(true).await;
}

async fn retry_after_merge_status_failure(restart: bool) {
    let Fixture {
        _dir, repo, base, result, mut store, mut engine, ..
    } = Fixture::new("review", true);
    {
        let db = store.db.lock().unwrap();
        db.execute(
            "INSERT INTO tasks (id,room_id,key,title,owner_id,status,deps_json,created_at,updated_at)
             VALUES ('T2','r1','T2','dependent','m1','backlog','[\"T1\"]','now','now')",
            [],
        )
        .unwrap();
        db.execute_batch(
            "CREATE TRIGGER fail_merge_status BEFORE UPDATE OF status ON tasks
             WHEN NEW.id='T1' AND NEW.status='merged'
             BEGIN SELECT RAISE(ABORT, 'fixture merge status'); END;",
        )
        .unwrap();
    }
    let error = engine.merge_task_result("T1", Some(result.clone())).await.unwrap_err();
    assert!(error.to_string().contains("fixture merge status"), "{error}");
    let applied = git(&repo, &["rev-parse", "main"]);
    assert_ne!(applied, base);
    assert_eq!(git(&repo, &["rev-list", "--count", "main"]), "2");
    assert_eq!(git(&repo, &["show", "main:feature.txt"]), "fixed result");
    assert_eq!(store.task("T1").unwrap().unwrap().status, "review");
    assert_eq!(store.task("T2").unwrap().unwrap().status, "backlog");
    assert!(!store.events("r1").unwrap().iter().any(|event| event["type"] == "task.merged"));
    store.db.lock().unwrap().execute_batch("DROP TRIGGER fail_merge_status").unwrap();

    if restart {
        let data = store.data.clone();
        let old_db = std::sync::Arc::downgrade(&store.db);
        drop(engine);
        drop(store);
        // Let the failed merge's background scheduler release its final Store clone.
        tokio::time::timeout(Duration::from_secs(5), async {
            while old_db.upgrade().is_some() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("old Store must close before reopening its instance lock");
        store = Store::open(data).unwrap();
        engine = Engine::new(store.clone());
        assert_eq!(store.task("T1").unwrap().unwrap().status, "review");
        assert_eq!(store.task("T2").unwrap().unwrap().status, "backlog");
    }

    let merged = engine.merge_task_result("T1", Some(result.clone())).await.unwrap();
    assert_eq!(merged["ok"], true);
    assert_eq!(merged["resultSha"], result);
    assert_eq!(store.task("T1").unwrap().unwrap().status, "merged");
    assert_eq!(store.task("T1").unwrap().unwrap().result_sha, result);
    assert_eq!(store.task("T2").unwrap().unwrap().status, "ready");
    assert_eq!(git(&repo, &["rev-parse", "main"]), applied);
    assert_eq!(git(&repo, &["rev-list", "--count", "main"]), "2");
    assert_eq!(git(&repo, &["status", "--porcelain"]), "");
    let squash_message = git(&repo, &["rev-parse", "--git-path", "SQUASH_MSG"]);
    assert!(!repo.join(squash_message).exists());
    assert_eq!(
        store.events("r1").unwrap().iter().filter(|event| event["type"] == "task.merged").count(),
        1,
    );
}

#[tokio::test]
async fn atomic_merge_rolls_back_when_a_later_dependency_update_fails() {
    assert_atomic_merge_retry("ready_sql", false).await;
}

#[tokio::test]
async fn atomic_merge_rolls_back_when_a_task_status_event_fails() {
    assert_atomic_merge_retry("task_status_event", false).await;
}

#[tokio::test]
async fn atomic_merge_rolls_back_when_the_merged_event_fails() {
    assert_atomic_merge_retry("merged_event", false).await;
}

#[tokio::test]
async fn atomic_merge_rolls_back_when_a_dependency_status_event_fails() {
    assert_atomic_merge_retry("ready_event", false).await;
}

#[tokio::test]
async fn atomic_merge_rolls_back_when_room_completion_update_fails() {
    assert_atomic_merge_retry("room_sql", false).await;
}

#[tokio::test]
async fn atomic_merge_rolls_back_when_room_completion_event_fails() {
    assert_atomic_merge_retry("room_event", false).await;
}

#[tokio::test]
async fn atomic_merge_discards_events_when_transaction_commit_fails() {
    assert_atomic_merge_retry("commit", false).await;
}

#[tokio::test]
async fn atomic_merge_no_diff_result_rolls_back_and_retries_all_completion_state() {
    assert_atomic_merge_retry("room_event", true).await;
}

fn merge_completion_events(events: Vec<Value>) -> Vec<Value> {
    events.into_iter().filter(|event| {
        matches!(event["type"].as_str(), Some("task.status" | "task.merged" | "room.completed"))
    }).collect()
}

fn received_events(receiver: &mut broadcast::Receiver<Value>) -> Vec<Value> {
    let mut events = Vec::new();
    while let Ok(event) = receiver.try_recv() {
        events.push(event);
    }
    events
}

async fn assert_atomic_merge_retry(failure: &str, no_diff: bool) {
    let f = Fixture::new("approved", true);
    let completing_room = failure.starts_with("room_");
    let (table, operation, predicate) = match failure {
        "ready_sql" => ("tasks", "UPDATE OF status", "NEW.id='T3' AND NEW.status='ready'"),
        "task_status_event" => ("events", "INSERT", "NEW.type='task.status' AND NEW.task_id='T1'"),
        "merged_event" => ("events", "INSERT", "NEW.type='task.merged'"),
        "ready_event" => ("events", "INSERT", "NEW.type='task.status' AND NEW.task_id='T3'"),
        "room_sql" => ("rooms", "UPDATE OF status", "NEW.status='completed'"),
        "room_event" => ("events", "INSERT", "NEW.type='room.completed'"),
        "commit" => ("events", "INSERT", "NEW.type='task.merged'"),
        _ => unreachable!(),
    };
    {
        let db = f.store.db.lock().unwrap();
        if completing_room {
            db.execute("UPDATE rooms SET status='running' WHERE id='r1'", []).unwrap();
        } else {
            for key in ["T2", "T3"] {
                db.execute(
                    "INSERT INTO tasks (id,room_id,key,title,owner_id,status,deps_json,created_at,updated_at)
                     VALUES (?,'r1',?,'dependent','m1','backlog','[\"T1\"]','now','now')",
                    params![key, key],
                ).unwrap();
            }
        }
        if no_diff {
            db.execute("UPDATE tasks SET result_sha=? WHERE id='T1'", params![f.base]).unwrap();
        }
        if failure == "commit" {
            db.execute_batch(
                "PRAGMA foreign_keys=ON;
                 CREATE TABLE merge_commit_guard (room_id TEXT REFERENCES rooms(id) DEFERRABLE INITIALLY DEFERRED);
                 CREATE TRIGGER fail_merge_completion AFTER INSERT ON events
                 WHEN NEW.type='task.merged' BEGIN INSERT INTO merge_commit_guard VALUES ('missing-room'); END;"
            ).unwrap();
        } else {
            db.execute_batch(&format!(
                "CREATE TRIGGER fail_merge_completion BEFORE {operation} ON {table}
                 WHEN {predicate} BEGIN SELECT RAISE(ABORT, 'fixture atomic merge'); END;"
            )).unwrap();
        }
    }
    let task_before = f.store.tasks("r1").unwrap().iter().map(devhub::models::task_payload).collect::<Vec<_>>();
    let room_before = devhub::models::room_payload(&f.store.room("r1").unwrap().unwrap());
    let mut receiver = f.store.subscribe();
    let outcome = f.engine.merge_task("T1").await;
    assert!(outcome.is_err(), "{failure}: merge must report a failed completion: {outcome:?}");
    let error = outcome.unwrap_err().to_string();
    assert!(error.contains(if failure == "commit" { "FOREIGN KEY constraint failed" } else { "fixture atomic merge" }), "{error}");
    if failure == "commit" {
        let guarded_rows: i64 = f.store.db.lock().unwrap().query_row(
            "SELECT COUNT(*) FROM merge_commit_guard", [], |row| row.get(0),
        ).unwrap();
        assert_eq!(guarded_rows, 0);
    }
    assert_eq!(f.store.tasks("r1").unwrap().iter().map(devhub::models::task_payload).collect::<Vec<_>>(), task_before, "{failure}: tasks");
    assert_eq!(devhub::models::room_payload(&f.store.room("r1").unwrap().unwrap()), room_before, "{failure}: room");
    assert!(merge_completion_events(f.store.events("r1").unwrap()).is_empty(), "{failure}: persisted completion events");
    assert!(merge_completion_events(received_events(&mut receiver)).is_empty(), "{failure}: ghost status broadcast");
    let applied = git(&f.repo, &["rev-parse", "main"]);
    assert_eq!(git(&f.repo, &["rev-list", "--count", "main"]), if no_diff { "1" } else { "2" });
    assert_eq!(git(&f.repo, &["status", "--porcelain"]), "");
    if no_diff {
        assert_eq!(applied, f.base);
    } else {
        assert_ne!(applied, f.base);
        assert_eq!(git(&f.repo, &["show", "main:feature.txt"]), "fixed result");
    }
    f.store.db.lock().unwrap().execute_batch("DROP TRIGGER fail_merge_completion").unwrap();
    let merged = f.engine.merge_task("T1").await.unwrap();
    assert_eq!(merged["ok"], true);
    assert_eq!(merged["noChange"], no_diff);
    assert_eq!(f.task().status, if no_diff { "done" } else { "merged" });
    assert_eq!(f.store.room("r1").unwrap().unwrap().status, if completing_room { "completed" } else { "paused" });
    if !completing_room {
        for key in ["T2", "T3"] {
            assert_eq!(f.store.task(key).unwrap().unwrap().status, "ready");
        }
    }
    assert_eq!(git(&f.repo, &["rev-parse", "main"]), applied);
    let durable = merge_completion_events(f.store.events("r1").unwrap());
    let published = merge_completion_events(received_events(&mut receiver));
    assert_eq!(published.len(), if completing_room { 3 } else { 4 });
    assert_eq!(durable.len(), published.len());
    for event in &published {
        assert!(event["id"].as_i64().unwrap() > 0);
        let mut stored = event.clone();
        stored.as_object_mut().unwrap().remove("kind");
        assert!(durable.contains(&stored), "broadcast must identify its persisted event: {event}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn atomic_merge_broadcasts_only_after_final_state_and_event_ids_are_readable() {
    let f = Fixture::new("approved", true);
    f.store.db.lock().unwrap().execute("UPDATE rooms SET status='running' WHERE id='r1'", []).unwrap();
    let mut receiver = f.store.subscribe();
    let observer_db = rusqlite::Connection::open(f.store.data.join("devhub.db")).unwrap();
    let observer = tokio::spawn(async move {
        let mut observed = Vec::new();
        while observed.len() < 3 {
            let event = receiver.recv().await.unwrap();
            if merge_completion_events(vec![event.clone()]).is_empty() {
                continue;
            }
            let task_status: String = observer_db.query_row("SELECT status FROM tasks WHERE id='T1'", [], |row| row.get(0)).unwrap();
            let room_status: String = observer_db.query_row("SELECT status FROM rooms WHERE id='r1'", [], |row| row.get(0)).unwrap();
            assert_eq!(task_status, "merged");
            assert_eq!(room_status, "completed");
            let (kind, payload): (String, String) = observer_db.query_row(
                "SELECT type,payload FROM events WHERE id=?", params![event["id"].as_i64().unwrap()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            ).unwrap();
            assert_eq!(event["type"], kind);
            assert_eq!(event["payload"], serde_json::from_str::<Value>(&payload).unwrap());
            observed.push(event);
        }
        observed
    });
    assert_eq!(f.engine.merge_task("T1").await.unwrap()["ok"], true);
    let observed = tokio::time::timeout(Duration::from_secs(5), observer).await.unwrap().unwrap();
    assert_eq!(observed.iter().map(|event| event["type"].as_str().unwrap()).collect::<Vec<_>>(),
        ["task.status", "task.merged", "room.completed"]);
}

#[test]
fn failed_event_insert_never_broadcasts_an_old_event_id() {
    let temp = tempfile::tempdir().unwrap();
    let store = Store::open(temp.path().join("data")).unwrap();
    store.emit(None, None, None, "accepted", json!({"accepted":true}));
    let mut receiver = store.subscribe();
    store.db.lock().unwrap().execute_batch(
        "CREATE TRIGGER reject_event BEFORE INSERT ON events WHEN NEW.type='rejected'
         BEGIN SELECT RAISE(ABORT, 'fixture rejected event'); END;"
    ).unwrap();
    store.emit(None, None, None, "rejected", json!({"accepted":false}));
    assert!(matches!(receiver.try_recv(), Err(broadcast::error::TryRecvError::Empty)));
    let count: i64 = store.db.lock().unwrap().query_row("SELECT COUNT(*) FROM events", [], |row| row.get(0)).unwrap();
    assert_eq!(count, 1);
}

#[tokio::test]
async fn pending_failed_or_cancelled_tasks_cannot_merge_or_review_even_with_a_saved_sha() {
    let f = Fixture::new("review", true);
    for state in [
        "backlog",
        "ready",
        "running",
        "failed",
        "cancelled",
        "merged",
        "done",
    ] {
        f.status(state);
        assert!(f.engine.merge_task("T1").await.is_err(), "{state}");
        assert!(f.engine.review_task("T1").await.is_err(), "{state}");
        assert_eq!(git(&f.repo, &["rev-parse", "main"]), f.base);
    }
    f.status("changes_requested");
    assert!(f.engine.merge_task("T1").await.is_err());
    assert_eq!(
        f.engine.review_task("T1").await.unwrap()["resultSha"],
        f.result
    );
}

#[tokio::test]
async fn manual_merge_accepts_escalated_result_without_an_automated_review() {
    let f = Fixture::new("escalated", false);
    assert!(f.engine.review_task("T1").await.is_err());
    assert_eq!(
        f.engine.merge_task("T1").await.unwrap()["resultSha"],
        f.result
    );
    assert_eq!(f.task().status, "merged");
    assert_eq!(f.store.review_count("T1").unwrap(), 0);
}

#[tokio::test]
async fn review_claim_blocks_every_other_action_before_async_preparation_and_releases_after_cancel()
{
    let f = Fixture::new("review", true);
    let mut rx = f.store.subscribe();
    let engine = f.engine.clone();
    let review = tokio::spawn(async move { engine.review_task("T1").await });
    event(&mut rx, "review.started").await;
    for error in [
        f.engine.start_task("T1").await.unwrap_err().to_string(),
        f.engine.retry_task("T1").await.unwrap_err().to_string(),
        f.engine.merge_task("T1").await.unwrap_err().to_string(),
        f.engine.review_task("T1").await.unwrap_err().to_string(),
        f.engine.reject_task("T1", "race").unwrap_err().to_string(),
    ] {
        assert!(error.contains("正在评审"), "{error}");
    }
    assert!(f.engine.archive_room("r1").await.is_err());
    f.engine.cancel_task("T1").await.unwrap();
    assert!(review.await.unwrap().is_err());
    assert_eq!(f.task().status, "cancelled");
    assert_eq!(f.store.review_count("T1").unwrap(), 0);
    f.engine.retry_task("T1").await.unwrap();
    assert_eq!(f.task().status, "ready");
}

#[tokio::test]
async fn cancelling_a_running_review_never_applies_its_approve_verdict() {
    let f = Fixture::new("review", true);
    let (started, _gate) = f.gated_worker();
    let engine = f.engine.clone();
    let review = tokio::spawn(async move { engine.review_task("T1").await });
    marker(&started).await;
    assert_eq!(f.engine.cancel_room_run("r1").await, 1);
    assert!(review
        .await
        .unwrap()
        .unwrap_err()
        .to_string()
        .contains("已取消"));
    assert_eq!(f.task().status, "review");
    assert_eq!(f.store.review_count("T1").unwrap(), 0);
    f.worker("", json!({"verdict":"approve"}), 0);
    f.engine.review_task("T1").await.unwrap();
    assert_eq!(f.task().status, "approved");
}

#[tokio::test]
async fn merge_reserves_before_the_first_git_await_and_releases_after_failure() {
    let f = Fixture::new("review", true);
    std::fs::write(f.repo.join("dirty.txt"), "main dirty\n").unwrap();
    let engine = f.engine.clone();
    let mut future = Box::pin(engine.merge_task("T1"));
    assert!(futures::poll!(future.as_mut()).is_pending());
    for error in [
        f.engine.start_task("T1").await.unwrap_err().to_string(),
        f.engine.review_task("T1").await.unwrap_err().to_string(),
        f.engine.retry_task("T1").await.unwrap_err().to_string(),
        f.engine.reject_task("T1", "race").unwrap_err().to_string(),
        f.engine.cancel_task("T1").await.unwrap_err().to_string(),
    ] {
        assert!(error.contains("合并"), "{error}");
    }
    assert!(future.await.unwrap_err().to_string().contains("未提交"));
    assert_eq!(f.task().status, "review");
    f.engine.review_task("T1").await.unwrap();
}

#[tokio::test]
async fn corrupt_or_missing_fixed_commit_is_an_error_and_unproduced_tasks_have_empty_diff() {
    let f = Fixture::new("review", true);
    f.store
        .db
        .lock()
        .unwrap()
        .execute(
            "UPDATE tasks SET result_sha=? WHERE id='T1'",
            params!["0".repeat(40)],
        )
        .unwrap();
    let error = f.engine.task_diff("T1").await.unwrap_err().to_string();
    assert!(error.contains("无法读取固定成果"), "{error}");
    assert_eq!(f.task().status, "review");
    assert!(f.engine.merge_task("T1").await.is_err());
    assert_eq!(git(&f.repo, &["rev-parse", "main"]), f.base);
    f.store
        .db
        .lock()
        .unwrap()
        .execute(
            "UPDATE tasks SET status='ready',result_sha='' WHERE id='T1'",
            [],
        )
        .unwrap();
    assert_eq!(
        f.engine.task_diff("T1").await.unwrap(),
        json!({"diff":"","resultSha":""})
    );
}

#[tokio::test]
async fn no_change_result_uses_done_without_creating_a_merge_commit() {
    let f = Fixture::new("approved", true);
    f.store
        .db
        .lock()
        .unwrap()
        .execute(
            "UPDATE tasks SET result_sha=?, diff_stat='' WHERE id='T1'",
            params![f.base],
        )
        .unwrap();
    let result = f.engine.merge_task("T1").await.unwrap();
    assert_eq!(result["noChange"], true);
    assert_eq!(f.task().status, "done");
    assert_eq!(git(&f.repo, &["rev-parse", "main"]), f.base);
}

#[tokio::test]
async fn legacy_diff_claims_the_task_before_git_and_snapshot_reads_reject_concurrent_changes() {
    let f = Fixture::new("review", false);
    let mut read = Box::pin(f.engine.task_diff("T1"));
    assert!(futures::poll!(read.as_mut()).is_pending());
    for error in [
        f.engine.start_task("T1").await.unwrap_err().to_string(),
        f.engine.review_task("T1").await.unwrap_err().to_string(),
        f.engine.merge_task("T1").await.unwrap_err().to_string(),
        f.engine.retry_task("T1").await.unwrap_err().to_string(),
        f.engine.reject_task("T1", "race").unwrap_err().to_string(),
        f.engine.cancel_task("T1").await.unwrap_err().to_string(),
    ] {
        assert!(error.contains("读取成果"), "{error}");
    }
    assert_eq!(read.await.unwrap()["resultSha"], f.result);
    let mut read = Box::pin(f.engine.task_diff("T1"));
    assert!(futures::poll!(read.as_mut()).is_pending());
    f.store
        .db
        .lock()
        .unwrap()
        .execute(
            "UPDATE tasks SET result_sha=? WHERE id='T1'",
            params![f.base],
        )
        .unwrap();
    let error = read.await.unwrap_err();
    assert!(error.is::<ResultConflict>(), "{error:?}");
    assert_eq!(f.task().result_sha, f.base);
}

#[tokio::test]
async fn review_round_limit_keeps_escalated_result_available_for_manual_merge() {
    let f = Fixture::new("review", true);
    f.worker(
        "",
        json!({"verdict":"request_changes","blocking":[],"notes":"human decision"}),
        0,
    );
    assert_eq!(f.engine.review_task("T1").await.unwrap()["round"], 1);
    assert_eq!(f.task().status, "changes_requested");
    assert_eq!(f.engine.review_task("T1").await.unwrap()["round"], 2);
    assert_eq!(f.task().status, "escalated");
    assert!(f.engine.review_task("T1").await.is_err());
    assert_eq!(f.store.review_count("T1").unwrap(), 2);
    f.engine
        .merge_task_result("T1", Some(f.result.clone()))
        .await
        .unwrap();
    assert_eq!(f.task().status, "merged");
}

#[tokio::test]
async fn room_cancel_reaches_review_before_its_first_git_await() {
    let f = Fixture::new("review", true);
    let mut review = Box::pin(f.engine.review_task("T1"));
    assert!(futures::poll!(review.as_mut()).is_pending());
    assert_eq!(f.engine.cancel_room_run("r1").await, 1);
    assert!(review.await.unwrap_err().to_string().contains("已取消"));
    assert_eq!(f.task().status, "review");
    assert_eq!(f.store.review_count("T1").unwrap(), 0);
    assert_eq!(std::fs::read_dir(&f.store.prompts).unwrap().count(), 0);
    f.engine.review_task("T1").await.unwrap();
    assert_eq!(f.task().status, "approved");
}
