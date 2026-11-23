use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use axum::{body::Body, http::Request};
use devhub::{api, engine::Engine, store::Store};
use http_body_util::BodyExt;
use rusqlite::params;
use serde_json::{json, Value};
use tokio::sync::broadcast;
use tower::ServiceExt;

struct Fixture {
    _dir: tempfile::TempDir,
    root: PathBuf,
    repo: PathBuf,
    store: Store,
    engine: Engine,
}

impl Fixture {
    fn new(repository: bool) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let repo = root.join("repo");
        std::fs::create_dir(&repo).unwrap();
        if repository {
            git(&repo, &["init", "-b", "main"]);
            std::fs::write(repo.join("README.md"), "scheduler fixture\n").unwrap();
            git(&repo, &["add", "-A"]);
            git(
                &repo,
                &[
                    "-c",
                    "user.name=DevHub",
                    "-c",
                    "user.email=devhub@local",
                    "commit",
                    "-m",
                    "initial",
                ],
            );
        }
        let store = Store::open(root.join("temporary-data")).unwrap();
        let engine = Engine::new(store.clone());
        let fixture = Self {
            _dir: dir,
            root,
            repo,
            store,
            engine,
        };
        fixture.worker("", 97);
        fixture
    }

    fn room(&self, id: &str, status: &str, mode: &str) {
        self.store.db.lock().unwrap().execute(
            "INSERT INTO rooms (id,name,repo_path,base_branch,status,mode,created_at,updated_at) VALUES (?,?,?,'main',?,?, 'now','now')",
            params![id, id, self.repo.to_string_lossy(), status, mode],
        ).unwrap();
    }

    fn member(&self, id: &str, room: &str, concurrency: i64) {
        self.store
            .db
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO members (id,room_id,name,worker,concurrency) VALUES (?,?,?,'codex',?)",
                params![id, room, id, concurrency],
            )
            .unwrap();
    }

    fn task(&self, id: &str, room: &str, owner: &str, status: &str, deps: Value) {
        self.store.db.lock().unwrap().execute(
            "INSERT INTO tasks (id,room_id,key,title,owner_id,status,deps_json,summary,diff_stat,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'original summary','original stat','now','now')",
            params![id, room, id, id, owner, status, deps.to_string()],
        ).unwrap();
    }

    fn single(&self, room_status: &str, task_status: &str) {
        self.room("r1", room_status, "parallel");
        self.member("m1", "r1", 1);
        self.task("T1", "r1", "m1", task_status, json!([]));
    }

    fn status(&self, id: &str) -> String {
        self.store.task(id).unwrap().unwrap().status
    }

    fn runs(&self) -> Vec<(String, Option<i64>, Option<String>, String)> {
        self.store
            .db
            .lock()
            .unwrap()
            .prepare("SELECT status,exit_code,ended_at,error FROM runs ORDER BY started_at")
            .unwrap()
            .query_map([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
    }

    fn worker(&self, commands: &str, exit: i32) {
        let script = if cfg!(windows) {
            self.root.join("mock-worker.cmd")
        } else {
            self.root.join("mock-worker.sh")
        };
        let output = r#"{"type":"item.completed","item":{"type":"agent_message","text":"fixture finished"}}"#;
        let content = if cfg!(windows) {
            format!("@echo off\r\n{commands}\r\necho {output}\r\nexit /b {exit}\r\n")
        } else {
            format!("#!/bin/sh\n{commands}\nprintf '%s\\n' '{output}'\nexit {exit}\n")
        };
        std::fs::write(&script, content).unwrap();
        executable(&script);
        // This explicit existing path prevents any installed CLI from being invoked.
        std::fs::write(
            self.store.data.join("env.json"),
            json!({"DEVHUB_CODEX_PATH": script}).to_string(),
        )
        .unwrap();
    }

    fn gated_worker(&self) -> (PathBuf, PathBuf) {
        let started = self.root.join("worker-started");
        let gate = self.root.join("worker-release");
        let commands = if cfg!(windows) {
            format!("echo started>>\"{}\"\r\npowershell.exe -NoProfile -Command \"while (-not (Test-Path -LiteralPath '{}')) {{ Start-Sleep -Milliseconds 20 }}\"", started.display(), gate.display())
        } else {
            format!(
                "echo started >> '{}'; while [ ! -f '{}' ]; do sleep 0.02; done",
                started.display(),
                gate.display()
            )
        };
        self.worker(&commands, 0);
        (started, gate)
    }

    fn collection_gate(&self) -> (PathBuf, PathBuf) {
        let started = self.root.join("collection-started");
        let gate = self.root.join("collection-release");
        let script = if cfg!(windows) {
            let ps = self.root.join("filter.ps1");
            std::fs::write(&ps, format!(
                "$text = [Console]::In.ReadToEnd()\n[IO.File]::WriteAllText('{}', 'started')\n$until = [DateTime]::UtcNow.AddSeconds(15)\nwhile (-not (Test-Path -LiteralPath '{}')) {{ if ([DateTime]::UtcNow -gt $until) {{ throw 'fixture gate timed out' }}; Start-Sleep -Milliseconds 20 }}\n[Console]::Out.Write($text)\n",
                started.display(), gate.display()
            )).unwrap();
            let cmd = self.root.join("filter.cmd");
            std::fs::write(&cmd, format!("@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File \"{}\"\r\n", ps.display())).unwrap();
            cmd
        } else {
            let sh = self.root.join("filter.sh");
            std::fs::write(
                &sh,
                format!(
                    "#!/bin/sh\ntouch '{}'\nwhile [ ! -f '{}' ]; do sleep 0.02; done\ncat\n",
                    started.display(),
                    gate.display()
                ),
            )
            .unwrap();
            executable(&sh);
            sh
        };
        std::fs::write(
            self.repo.join(".gitattributes"),
            "change.txt filter=fixture\n",
        )
        .unwrap();
        git(&self.repo, &["add", ".gitattributes"]);
        git(
            &self.repo,
            &[
                "-c",
                "user.name=DevHub",
                "-c",
                "user.email=devhub@local",
                "commit",
                "-m",
                "fixture filter",
            ],
        );
        let command = format!("\"{}\"", script.to_string_lossy().replace('\\', "/"));
        git(&self.repo, &["config", "filter.fixture.clean", &command]);
        git(&self.repo, &["config", "filter.fixture.required", "true"]);
        (started, gate)
    }

    async fn idle(&self) {
        tokio::time::timeout(Duration::from_secs(20), async {
            while !self.engine.running_tasks().await.is_empty() {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("reserved execution did not drain");
    }

    async fn stop_automatic(&self) {
        for room in ["r1", "r2"] {
            if self.store.room(room).unwrap().is_some() {
                self.engine.pause_room(room).await.unwrap();
            }
        }
        for run in self.engine.running_tasks().await {
            self.engine
                .cancel_task(run["taskId"].as_str().unwrap())
                .await
                .unwrap();
        }
        self.idle().await;
    }
}

fn executable(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    #[cfg(not(unix))]
    let _ = path;
}

fn git(repo: &Path, args: &[&str]) {
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
}

async fn marker(path: &Path) {
    tokio::time::timeout(Duration::from_secs(15), async {
        while !path.exists() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("mock process did not reach fixture gate");
}

async fn event(rx: &mut broadcast::Receiver<Value>, kind: &str) -> Value {
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let value = rx.recv().await.unwrap();
            if value["type"] == kind {
                return value;
            }
        }
    })
    .await
    .expect("expected runtime event")
}

fn start(engine: &Engine, id: &str) -> tokio::task::JoinHandle<anyhow::Result<Value>> {
    let engine = engine.clone();
    let id = id.to_string();
    tokio::spawn(async move { engine.start_task(&id).await })
}

#[tokio::test]
async fn business_rejections_leave_status_history_and_worktree_untouched() {
    for (status, expected) in [
        ("review", "当前任务状态"),
        ("approved", "当前任务状态"),
        ("running", "先取消"),
        ("merged", "已经完成"),
        ("done", "已经完成"),
    ] {
        let f = Fixture::new(false);
        f.single("draft", status);
        let error = f.engine.start_task("T1").await.unwrap_err().to_string();
        assert!(error.contains(expected), "{status}: {error}");
        assert_eq!(f.status("T1"), status);
        assert!(f.runs().is_empty());
        assert!(f.engine.running_tasks().await.is_empty());
        assert_eq!(std::fs::read_dir(&f.store.worktrees).unwrap().count(), 0);
        assert_eq!(
            f.store.task("T1").unwrap().unwrap().summary,
            "original summary"
        );
    }
}

#[tokio::test]
async fn member_and_dependency_guards_do_not_mark_business_errors_failed() {
    let cases = [
        ("UPDATE members SET enabled=0", "已停用"),
        ("UPDATE members SET worker='unknown'", "CLI 无效"),
        ("UPDATE members SET room_id='elsewhere'", "不属于当前会话"),
        ("UPDATE tasks SET owner_id=NULL", "有效负责人"),
        ("UPDATE tasks SET deps_json='null'", "依赖格式无效"),
        ("UPDATE tasks SET deps_json='[1]'", "依赖格式无效"),
        (
            "UPDATE tasks SET deps_json='[\"missing\"]'",
            "依赖 missing 无效",
        ),
        ("UPDATE tasks SET deps_json='[\"T1\"]'", "依赖 T1 无效"),
        ("UPDATE rooms SET status='archived'", "已归档"),
    ];
    for (sql, expected) in cases {
        let f = Fixture::new(false);
        f.single("draft", "ready");
        f.store.db.lock().unwrap().execute_batch(sql).unwrap();
        let error = f.engine.start_task("T1").await.unwrap_err().to_string();
        assert!(error.contains(expected), "{sql}: {error}");
        assert_eq!(f.status("T1"), "ready");
        assert!(f.runs().is_empty());
    }
    let f = Fixture::new(false);
    f.single("draft", "ready");
    f.task("T2", "r1", "m1", "review", json!([]));
    f.store
        .db
        .lock()
        .unwrap()
        .execute("UPDATE tasks SET deps_json='[\"T2\"]' WHERE id='T1'", [])
        .unwrap();
    let error = f.engine.start_task("T1").await.unwrap_err().to_string();
    assert!(
        error.contains("依赖 T2 尚未完成") && error.contains("还需合并"),
        "{error}"
    );
    assert_eq!(f.status("T1"), "ready");
    assert!(f.runs().is_empty());
}

#[tokio::test]
async fn manual_rerun_states_work_in_draft_and_paused_rooms_and_prepare_errors_release_slots() {
    for room_status in ["draft", "paused"] {
        for task_status in [
            "backlog",
            "ready",
            "failed",
            "cancelled",
            "changes_requested",
            "escalated",
        ] {
            let f = Fixture::new(false);
            f.single(room_status, task_status);
            let error = f.engine.start_task("T1").await.unwrap_err().to_string();
            assert!(
                error.contains("准备工作区失败"),
                "{room_status}/{task_status}: {error}"
            );
            assert_eq!(f.status("T1"), "failed");
            let runs = f.runs();
            assert_eq!(runs.len(), 1);
            assert_eq!(runs[0].0, "failed");
            assert!(runs[0].2.is_some());
            assert!(f.engine.running_tasks().await.is_empty());
        }
    }
}

#[tokio::test]
async fn completed_dependencies_allow_manual_execution() {
    for upstream_status in ["merged", "done"] {
        let f = Fixture::new(false);
        f.single("draft", "backlog");
        f.task("T2", "r1", "m1", upstream_status, json!([]));
        f.store
            .db
            .lock()
            .unwrap()
            .execute("UPDATE tasks SET deps_json='[\"T2\"]' WHERE id='T1'", [])
            .unwrap();
        assert!(f
            .engine
            .start_task("T1")
            .await
            .unwrap_err()
            .to_string()
            .contains("准备工作区失败"));
        assert_eq!(f.runs().len(), 1);
    }
}

#[tokio::test]
async fn automatic_dispatch_requires_running_room_ready_task_and_valid_dependencies() {
    let f = Fixture::new(false);
    f.single("draft", "ready");
    f.engine.schedule().await;
    assert!(f.runs().is_empty());
    f.engine.pause_room("r1").await.unwrap();
    f.engine.schedule().await;
    assert!(f.runs().is_empty());
    f.store
        .db
        .lock()
        .unwrap()
        .execute_batch("UPDATE rooms SET status='running'; UPDATE members SET enabled=0;")
        .unwrap();
    f.engine.schedule().await;
    assert_eq!(f.status("T1"), "ready");
    assert!(f.runs().is_empty());
    f.store
        .db
        .lock()
        .unwrap()
        .execute_batch("UPDATE members SET enabled=1; UPDATE tasks SET status='backlog';")
        .unwrap();
    f.engine.schedule().await;
    assert!(f.runs().is_empty());
    f.task("T2", "r1", "m1", "ready", json!(["T1"]));
    f.engine.schedule().await;
    assert_eq!(f.status("T2"), "ready");
    assert!(f.runs().is_empty());
}

#[tokio::test]
async fn schedulers_reserve_global_and_room_slots_before_git_and_duplicates_are_idempotent() {
    let f = Fixture::new(true);
    for room in ["r1", "r2"] {
        f.room(room, "running", "parallel");
        f.member(room, room, 10);
        for n in 1..=4 {
            f.task(&format!("{room}T{n}"), room, room, "ready", json!([]));
        }
    }
    f.engine.schedule().await;
    f.engine.schedule().await;
    let running = f.engine.running_tasks().await;
    assert_eq!(running.len(), 3);
    assert!(running
        .iter()
        .all(|run| run["phase"] == "starting" && run["pid"].is_null()));
    assert_eq!(
        running.iter().filter(|run| run["roomId"] == "r1").count(),
        2
    );
    for run in &running {
        assert_eq!(f.status(run["taskId"].as_str().unwrap()), "running");
    }
    let id = running[0]["taskId"].as_str().unwrap();
    assert_eq!(f.engine.start_task(id).await.unwrap()["already"], true);
    assert!(f
        .engine
        .retry_task(id)
        .await
        .unwrap_err()
        .to_string()
        .contains("收尾"));
    let error = f.engine.start_task("r2T4").await.unwrap_err().to_string();
    assert!(error.contains("全局 3"), "{error}");
    let before = f.store.tasks("r1").unwrap().len();
    assert!(f
        .engine
        .apply_plan(
            "r1",
            &json!({"tasks":[{"title":"replacement","owner":"r1"}]})
        )
        .unwrap_err()
        .to_string()
        .contains("不能覆盖计划"));
    assert_eq!(f.store.tasks("r1").unwrap().len(), before);
    assert_eq!(f.runs().len(), 3);
    // Cancel does not release an in-flight preparation reservation.
    f.engine.pause_room("r1").await.unwrap();
    f.engine.pause_room("r2").await.unwrap();
    for run in &running {
        f.engine
            .cancel_task(run["taskId"].as_str().unwrap())
            .await
            .unwrap();
    }
    assert_eq!(f.engine.running_tasks().await.len(), 3);
    f.idle().await;
    assert!(f
        .runs()
        .iter()
        .all(|run| run.0 == "cancelled" && run.2.is_some()));
    for run in running {
        assert_eq!(f.status(run["taskId"].as_str().unwrap()), "cancelled");
    }
}

#[tokio::test]
async fn manual_runs_share_serial_and_member_quotas_with_automatic_preparation() {
    for (mode, concurrency, expected) in [
        ("serial", 10, "当前会话的 1"),
        ("parallel", 1, "负责人「m1」的并发已满"),
    ] {
        let f = Fixture::new(true);
        f.room("r1", "running", mode);
        f.member("m1", "r1", concurrency);
        f.task("T1", "r1", "m1", "ready", json!([]));
        f.task("T2", "r1", "m1", "ready", json!([]));
        f.engine.schedule().await;
        assert_eq!(f.engine.running_tasks().await.len(), 1);
        let error = f.engine.start_task("T2").await.unwrap_err().to_string();
        assert!(error.contains(expected), "{mode}: {error}");
        assert_eq!(f.status("T2"), "ready");
        f.stop_automatic().await;
    }
}

#[tokio::test]
async fn pausing_during_automatic_preparation_restores_ready_without_launching_a_worker() {
    let f = Fixture::new(true);
    f.single("running", "ready");
    // If preparation incorrectly launches a worker this explicit mock produces a failure.
    f.worker("", 19);
    f.engine.schedule().await;
    f.engine.pause_room("r1").await.unwrap();
    f.idle().await;
    assert_eq!(f.status("T1"), "ready");
    let task = f.store.task("T1").unwrap().unwrap();
    assert_eq!(task.summary, "original summary");
    assert_eq!(task.diff_stat, "original stat");
    assert_eq!(f.runs()[0].0, "cancelled");
    assert!(f.runs()[0].1.is_none());
    assert!(f.runs()[0].3.contains("已暂停"));
    assert_eq!(std::fs::read_dir(&f.store.prompts).unwrap().count(), 0);
}

#[tokio::test]
async fn disabling_member_during_preparation_defers_without_failing_the_task() {
    let f = Fixture::new(true);
    f.single("running", "ready");
    f.engine.schedule().await;
    f.engine
        .update_member("m1", &json!({"enabled":false}))
        .await
        .unwrap();
    f.idle().await;
    assert_eq!(f.status("T1"), "ready");
    assert_eq!(f.runs()[0].0, "cancelled");
    assert!(f.runs()[0].3.contains("已停用"));
}

#[tokio::test]
async fn mock_worker_success_exposes_all_phases_and_finishes_the_run() {
    let f = Fixture::new(true);
    f.single("draft", "ready");
    f.worker("", 0);
    let result = f.engine.start_task("T1").await.unwrap();
    assert_eq!(result["ok"], true);
    assert_eq!(f.status("T1"), "done");
    assert_eq!(f.runs()[0].0, "completed");
    assert_eq!(f.runs()[0].1, Some(0));
    assert!(f.runs()[0].2.is_some());
    assert!(f.engine.running_tasks().await.is_empty());
    let phases = f
        .store
        .events("r1")
        .unwrap()
        .into_iter()
        .filter(|value| {
            ["task.started", "task.phase"].contains(&value["type"].as_str().unwrap_or(""))
        })
        .map(|value| value["payload"]["phase"].as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    assert_eq!(phases, ["starting", "running", "collecting"]);
    assert!(f
        .engine
        .cancel_task("T1")
        .await
        .unwrap_err()
        .to_string()
        .contains("已经完成"));
    assert_eq!(f.status("T1"), "done");
}

#[tokio::test]
async fn nonzero_mock_worker_exit_and_cli_setup_errors_finalize_and_release() {
    let f = Fixture::new(true);
    f.single("draft", "ready");
    f.worker("", 7);
    assert_eq!(f.engine.start_task("T1").await.unwrap()["ok"], false);
    assert_eq!(f.status("T1"), "failed");
    assert_eq!(f.runs()[0].0, "failed");
    assert_eq!(f.runs()[0].1, Some(7));
    assert!(f.runs()[0].2.is_some());
    assert!(f.engine.running_tasks().await.is_empty());

    let f = Fixture::new(true);
    f.single("draft", "ready");
    f.worker("", 0);
    std::fs::remove_dir(&f.store.prompts).unwrap();
    let error = f.engine.start_task("T1").await.unwrap_err().to_string();
    assert!(error.contains("CLI 配置和日志"), "{error}");
    assert_eq!(f.status("T1"), "failed");
    assert_eq!(f.runs()[0].0, "failed");
    assert!(f.runs()[0].2.is_some());
    assert!(f.engine.running_tasks().await.is_empty());
}

#[tokio::test]
async fn long_unicode_worker_errors_finalize_release_and_allow_retry() {
    let f = Fixture::new(true);
    f.single("draft", "ready");
    let stderr = f.root.join("unicode-error.txt");
    // 4401 bytes including the newline: the old 4000-byte tail began inside
    // an emoji and panicked, poisoning the accumulator and retaining the slot.
    let diagnostic = format!("{}\n", "💥".repeat(1100));
    std::fs::write(&stderr, &diagnostic).unwrap();
    let commands = if cfg!(windows) {
        format!("type \"{}\" 1>&2", stderr.display())
    } else {
        format!("cat '{}' >&2", stderr.display())
    };
    f.worker(&commands, 7);

    let result = tokio::time::timeout(Duration::from_secs(15), f.engine.start_task("T1"))
        .await
        .expect("Unicode worker diagnostics must finish without retaining a task slot")
        .expect("a nonzero worker exit should be a normal failed run");
    assert_eq!(result["ok"], false);
    assert_eq!(f.status("T1"), "failed");
    let failed_run = &f.runs()[0];
    assert_eq!(failed_run.0, "failed");
    assert_eq!(failed_run.1, Some(7));
    assert!(failed_run.2.is_some());
    assert!(!failed_run.3.is_empty());
    assert!(failed_run.3.chars().all(|c| c == '💥'));
    assert!(f.engine.running_tasks().await.is_empty());
    assert_eq!(f.engine.active_worker_count(), 0);
    assert!(f.engine.task_log("T1").contains(diagnostic.trim_end()));

    // Retry through the public engine entry point, using the same member and
    // worktree, proves both the reservation and failed-task guards were cleared.
    f.worker("echo recovered>recovered.txt", 0);
    assert_eq!(f.engine.start_task("T1").await.unwrap()["ok"], true);
    assert_eq!(f.status("T1"), "review");
    assert_eq!(f.runs().len(), 2);
    assert_eq!(f.runs().iter().filter(|run| run.0 == "completed").count(), 1);
    assert!(f.engine.running_tasks().await.is_empty());
}

#[tokio::test]
async fn git_status_and_commit_failures_are_collection_failures_not_empty_successes() {
    for break_status in [true, false] {
        let f = Fixture::new(true);
        f.single("draft", "ready");
        if break_status {
            f.worker("git config core.repositoryformatversion 999", 0);
        } else {
            f.worker("echo changed>change.txt", 0);
            git(&f.repo, &["config", "commit.gpgsign", "true"]);
            git(
                &f.repo,
                &["config", "gpg.program", "devhub-fixture-missing-gpg"],
            );
        }
        let result = f.engine.start_task("T1").await;
        assert!(
            result.is_err(),
            "break_status={break_status}: {result:?}; task={:?}; log={}",
            f.store.task("T1").unwrap(),
            f.engine.task_log("T1")
        );
        let error = result.unwrap_err().to_string();
        assert!(error.contains("收集改动失败"), "{error}");
        assert_eq!(f.status("T1"), "failed");
        assert_eq!(f.runs()[0].0, "failed");
        assert!(f.runs()[0].2.is_some());
        assert!(f.engine.running_tasks().await.is_empty());
    }
}

#[tokio::test]
async fn global_stop_signals_running_task_and_plan_but_preserves_queued_tasks() {
    let f = Fixture::new(true);
    f.single("running", "ready");
    f.task("T2", "r1", "m1", "ready", json!([]));
    let (started, _gate) = f.gated_worker();
    let task = start(&f.engine, "T1");
    marker(&started).await;

    let engine = f.engine.clone();
    let plan = tokio::spawn(async move { engine.generate_plan("r1").await });
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let started_count = std::fs::read_to_string(&started)
                .map(|text| text.lines().count())
                .unwrap_or_default();
            if started_count >= 2 && f.engine.active_worker_count() == 2 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("task and plan worker processes should both be active");

    let app = api::router(f.engine.clone());
    let state = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/state")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(state.status(), axum::http::StatusCode::OK);
    let state: Value =
        serde_json::from_slice(&state.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(state["activeWorkers"], 2);

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/stop-all")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), axum::http::StatusCode::OK);
    let stopped: Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(stopped, json!({"stopped": 2}));
    assert_eq!(f.status("T1"), "cancelled");
    assert_eq!(f.status("T2"), "ready");
    assert_eq!(task.await.unwrap().unwrap()["cancelled"], true);
    assert!(plan.await.unwrap().is_err());
    assert_eq!(f.engine.active_worker_count(), 0);
    assert_eq!(f.status("T2"), "ready");
    assert_eq!(f.store.room("r1").unwrap().unwrap().status, "paused");
    f.engine.schedule().await;
    assert_eq!(f.engine.running_tasks().await.len(), 0);
    assert_eq!(f.status("T2"), "ready");
}

#[tokio::test]
async fn cancellation_of_a_running_mock_process_stays_cancelled_and_finishes_history() {
    let f = Fixture::new(true);
    f.single("draft", "ready");
    let (started, _gate) = f.gated_worker();
    let handle = start(&f.engine, "T1");
    marker(&started).await;
    assert_eq!(f.engine.running_tasks().await[0]["phase"], "running");
    assert_eq!(f.status("T1"), "running");
    f.engine.cancel_task("T1").await.unwrap();
    assert_eq!(handle.await.unwrap().unwrap()["cancelled"], true);
    assert_eq!(f.status("T1"), "cancelled");
    assert_eq!(f.runs()[0].0, "cancelled");
    assert!(f.runs()[0].2.is_some());
    assert!(f.engine.running_tasks().await.is_empty());
}

#[tokio::test]
async fn cancellation_during_git_collection_preserves_status_and_capacity_until_git_drains() {
    let f = Fixture::new(true);
    f.single("draft", "ready");
    f.task("T2", "r1", "m1", "ready", json!([]));
    let (started, gate) = f.collection_gate();
    f.worker("echo changed>change.txt", 0);
    let handle = start(&f.engine, "T1");
    marker(&started).await;
    let running = f.engine.running_tasks().await;
    assert_eq!(running.len(), 1);
    assert_eq!(running[0]["phase"], "collecting");
    assert_eq!(f.status("T1"), "running");
    f.engine.cancel_task("T1").await.unwrap();
    assert_eq!(f.status("T1"), "cancelled");
    assert_eq!(f.engine.running_tasks().await.len(), 1);
    assert!(f.engine.retry_task("T1").await.is_err());
    assert!(f
        .engine
        .start_task("T2")
        .await
        .unwrap_err()
        .to_string()
        .contains("并发已满"));
    assert_eq!(f.engine.start_task("T1").await.unwrap()["already"], true);
    std::fs::write(gate, "release").unwrap();
    assert_eq!(handle.await.unwrap().unwrap()["cancelled"], true);
    assert_eq!(f.status("T1"), "cancelled");
    assert_eq!(f.status("T2"), "ready");
    assert_eq!(f.runs()[0].0, "cancelled");
    assert!(f.runs()[0].2.is_some());
    assert!(f.engine.running_tasks().await.is_empty());
}

#[tokio::test]
async fn dropping_the_request_does_not_abandon_its_reservation() {
    let f = Fixture::new(true);
    f.single("draft", "ready");
    f.worker("", 0);
    let mut rx = f.store.subscribe();
    let handle = start(&f.engine, "T1");
    event(&mut rx, "task.started").await;
    handle.abort();
    f.idle().await;
    assert_eq!(f.status("T1"), "done");
    assert_eq!(f.runs()[0].0, "completed");
    assert!(f.runs()[0].2.is_some());
}
