use std::path::{Path, PathBuf};
use std::process::Command;

use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use devhub::{
    api,
    engine::Engine,
    models::{task_payload, Task},
    store::Store,
};
use http_body_util::BodyExt;
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use tower::ServiceExt;

struct Fixture {
    _dir: tempfile::TempDir,
    root: PathBuf,
    repo: PathBuf,
    worktree: PathBuf,
    base: String,
    store: Store,
    engine: Engine,
}

impl Fixture {
    /// flow_nodes 是阶段的 JSON 数组；task_phase 为 None 时不绑定阶段（旧行为）。
    fn new(flow_nodes: Value, task_phase: Option<&str>) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let repo = root.join("repo");
        let worktree = root.join("task-worktree");
        std::fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "-b", "main"]);
        std::fs::write(repo.join("README.md"), "gate fixture\n").unwrap();
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
        let store = Store::open(root.join("temporary-data")).unwrap();
        let flow = json!({ "nodes": flow_nodes, "edges": [] });
        {
            let db = store.db.lock().unwrap();
            db.execute(
                "INSERT INTO rooms (id,name,repo_path,base_branch,flow_json,status,reviewer_id,created_at,updated_at)
                 VALUES ('r1','gate fixture',?,'main',?,'running','m1','now','now')",
                params![repo.to_str().unwrap(), flow.to_string()],
            )
            .unwrap();
            db.execute(
                "INSERT INTO members (id,room_id,name,worker,concurrency) VALUES ('m1','r1','mock worker','codex',2)",
                [],
            )
            .unwrap();
            db.execute(
                "INSERT INTO tasks (id,room_id,key,title,owner_id,phase_id,status,worktree,branch,base_sha,created_at,updated_at)
                 VALUES ('T1','r1','T1','gate fixture','m1',?,'ready',?,'task-one',?,'now','now')",
                params![task_phase, worktree.to_str().unwrap(), base],
            )
            .unwrap();
        }
        let engine = Engine::new(store.clone());
        let fixture = Self {
            _dir: dir,
            root,
            repo,
            worktree,
            base,
            store,
            engine,
        };
        fixture.worker("", json!({ "verdict": "approve", "blocking": [] }), 0);
        fixture
    }

    fn phase(id: &str, gate: &str, max_loop: i64) -> Value {
        json!({
            "id": id, "type": "phase", "name": id, "gate": gate, "maxLoop": max_loop,
            "owner": "", "outputs": [], "x": 40, "y": 90,
        })
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

    fn task(&self) -> Task {
        self.store.task("T1").unwrap().unwrap()
    }

    fn status(&self) -> String {
        self.task().status
    }

    fn sql(&self, sql: &str) {
        self.store.db.lock().unwrap().execute_batch(sql).unwrap();
    }

    fn events(&self, kind: &str) -> Vec<Value> {
        self.store
            .events("r1")
            .unwrap()
            .into_iter()
            .filter(|event| event["type"] == kind)
            .collect()
    }

    fn last_event(&self, kind: &str) -> Value {
        self.events(kind)
            .pop()
            .unwrap_or_else(|| panic!("缺少 {kind} 事件"))
    }

    async fn run_task(&self) {
        self.engine.start_task("T1").await.unwrap();
    }

    async fn review_with(&self, verdict: Value) {
        self.worker("", verdict, 0);
        self.engine.review_task("T1").await.unwrap();
    }

    async fn post(&self, path: &str) -> (StatusCode, Value) {
        let request = Request::builder()
            .method("POST")
            .uri(path)
            .header("content-type", "application/json")
            .body(Body::from(""))
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

fn request_changes() -> Value {
    json!({
        "verdict": "request_changes",
        "blocking": [{ "file": "a.js", "line": 3, "issue": "空实现", "suggestion": "补上" }],
        "notes": "需要修改",
    })
}

fn approved_verdict() -> Value {
    json!({ "verdict": "approve", "blocking": [], "notes": "检查通过" })
}

#[tokio::test]
async fn auto_gate_passes_output_without_review_and_can_merge() {
    let f = Fixture::new(json!([Fixture::phase("n1", "auto", 0)]), Some("n1"));
    f.worker("echo produced>produced.txt", json!("produced"), 0);
    f.run_task().await;

    let task = f.task();
    assert_eq!(task.status, "approved");
    assert_eq!(task.reject_count, 0);
    assert!(!task.result_sha.is_empty());
    assert_eq!(task_payload(&task)["reject_count"], 0);
    assert!(f.events("gate.waiting").is_empty());
    assert!(f.worktree.join("produced.txt").exists());

    let finished = f.last_event("task.finished");
    assert_eq!(finished["payload"]["gate"], "auto");
    assert_eq!(finished["payload"]["maxLoop"], 2);
    assert_eq!(finished["payload"]["rejectCount"], 0);

    let passed = f.last_event("gate.passed");
    assert_eq!(passed["payload"]["gate"], "auto");
    assert_eq!(passed["payload"]["checks"], json!(["diff"]));
    assert_eq!(passed["payload"]["maxLoop"], 2);
    assert_eq!(passed["payload"]["rejectCount"], 0);
    assert_eq!(passed["payload"]["resultSha"], task.result_sha);

    let error = f.engine.review_task("T1").await.unwrap_err().to_string();
    assert_eq!(
        error,
        "这个阶段的门禁是自动通过，有产出就已经通过，不需要自动评审"
    );
    f.engine.merge_task("T1").await.unwrap();
    assert_eq!(f.status(), "merged");
    assert_eq!(git(&f.repo, &["show", "main:produced.txt"]).trim(), "produced");
    assert_ne!(git(&f.repo, &["rev-parse", "main"]), f.base);
}

#[tokio::test]
async fn agent_gate_review_approval_moves_to_approved_and_can_merge() {
    let f = Fixture::new(json!([Fixture::phase("n1", "agent", 2)]), Some("n1"));
    f.worker("echo produced>produced.txt", json!("produced"), 0);
    f.run_task().await;
    assert_eq!(f.status(), "review");
    let waiting = f.last_event("gate.waiting");
    assert_eq!(waiting["payload"]["gate"], "agent");
    assert_eq!(waiting["payload"]["maxLoop"], 2);
    assert_eq!(waiting["payload"]["rejectCount"], 0);

    f.review_with(approved_verdict()).await;
    assert_eq!(f.status(), "approved");
    assert_eq!(f.task().reject_count, 0);
    assert_eq!(f.store.review_count("T1").unwrap(), 1);
    let done = f.last_event("review.done");
    assert_eq!(done["payload"]["verdict"], "approve");
    assert_eq!(done["payload"]["maxLoop"], 2);
    assert_eq!(done["payload"]["rejectCount"], 0);
    assert!(f.events("gate.escalated").is_empty());

    f.engine.merge_task("T1").await.unwrap();
    assert_eq!(f.status(), "merged");
}

#[tokio::test]
async fn agent_gate_escalates_after_two_rejections_and_manual_approval_still_works() {
    let f = Fixture::new(json!([Fixture::phase("n1", "agent", 2)]), Some("n1"));
    f.worker("echo produced>produced.txt", json!("produced"), 0);
    f.run_task().await;
    assert_eq!(f.status(), "review");

    f.review_with(request_changes()).await;
    assert_eq!(f.status(), "changes_requested");
    assert_eq!(f.task().reject_count, 1);
    assert!(f.task().feedback.contains("第 1 轮评审"));

    f.worker("echo more>>produced.txt", json!("produced"), 0);
    f.run_task().await;
    assert_eq!(f.status(), "review");
    f.review_with(request_changes()).await;
    assert_eq!(f.status(), "escalated");
    assert_eq!(f.task().reject_count, 2);

    let escalated = f.last_event("gate.escalated");
    assert_eq!(escalated["payload"]["gate"], "agent");
    assert_eq!(escalated["payload"]["by"], "agent");
    assert_eq!(escalated["payload"]["maxLoop"], 2);
    assert_eq!(escalated["payload"]["rejectCount"], 2);
    assert_eq!(escalated["payload"]["round"], 2);
    let done = f.last_event("review.done");
    assert_eq!(done["payload"]["escalated"], true);
    assert_eq!(done["payload"]["maxLoop"], 2);
    assert_eq!(done["payload"]["rejectCount"], 2);

    f.engine.approve_task("T1").unwrap();
    assert_eq!(f.status(), "approved");
    let manual = f.last_event("gate.passed");
    assert_eq!(manual["payload"]["by"], "human");
    assert_eq!(manual["payload"]["manual"], true);
    assert_eq!(manual["payload"]["gate"], "agent");
    assert_eq!(manual["payload"]["rejectCount"], 2);
    let error = f.engine.approve_task("T1").unwrap_err().to_string();
    assert_eq!(error, "任务已经通过，等待合并即可");

    f.engine.merge_task("T1").await.unwrap();
    assert_eq!(f.status(), "merged");
}

#[tokio::test]
async fn max_loop_one_escalates_on_the_first_rejection() {
    let f = Fixture::new(json!([Fixture::phase("n1", "agent", 1)]), Some("n1"));
    f.worker("echo produced>produced.txt", json!("produced"), 0);
    f.run_task().await;
    f.review_with(request_changes()).await;
    assert_eq!(f.status(), "escalated");
    assert_eq!(f.task().reject_count, 1);
    assert_eq!(f.store.review_count("T1").unwrap(), 1);
    let done = f.last_event("review.done");
    assert_eq!(done["payload"]["maxLoop"], 1);
    assert_eq!(done["payload"]["rejectCount"], 1);
    assert_eq!(done["payload"]["escalated"], true);

    // 升级后人工再给一轮机会：打回计数清零，重跑后可以重新评审。
    f.engine.reject_task("T1", "再给一次机会").unwrap();
    assert_eq!(f.status(), "changes_requested");
    assert_eq!(f.task().reject_count, 0);
    f.worker("echo again>>produced.txt", json!("produced"), 0);
    f.run_task().await;
    assert_eq!(f.status(), "review");
    f.review_with(request_changes()).await;
    // 上限为 1：新一轮的第一次打回仍然升级。
    assert_eq!(f.status(), "escalated");
    assert_eq!(f.task().reject_count, 1);

    // 计数达到上限时，评审接口的守卫文案与 Node 逐字一致。
    f.sql("UPDATE tasks SET status='changes_requested', reject_count=1");
    let error = f.engine.review_task("T1").await.unwrap_err().to_string();
    assert_eq!(
        error,
        "这个任务已经打回 1 次，达到本阶段上限，请人工决定：按意见重跑、人工通过或取消"
    );
}

#[tokio::test]
async fn max_loop_three_escalates_only_on_the_third_rejection() {
    let f = Fixture::new(json!([Fixture::phase("n1", "agent", 3)]), Some("n1"));
    for (round, expected_status, expected_count) in [
        (1, "changes_requested", 1),
        (2, "changes_requested", 2),
        (3, "escalated", 3),
    ] {
        f.worker(
            &format!("echo round-{round}>round-{round}.txt"),
            json!("produced"),
            0,
        );
        f.run_task().await;
        assert_eq!(f.status(), "review", "第 {round} 轮运行");
        f.review_with(request_changes()).await;
        assert_eq!(f.status(), expected_status, "第 {round} 轮评审");
        assert_eq!(f.task().reject_count, expected_count, "第 {round} 轮计数");
        assert_eq!(f.store.review_count("T1").unwrap(), round);
    }
    let escalated = f.last_event("gate.escalated");
    assert_eq!(escalated["payload"]["maxLoop"], 3);
    assert_eq!(escalated["payload"]["rejectCount"], 3);
    assert_eq!(escalated["payload"]["round"], 3);
    let done = f.last_event("review.done");
    assert_eq!(done["payload"]["escalated"], true);
    assert_eq!(done["payload"]["maxLoop"], 3);
    assert_eq!(done["payload"]["rejectCount"], 3);
}

#[tokio::test]
async fn human_gate_waits_for_manual_approval_and_rejections_follow_the_limit() {
    let f = Fixture::new(json!([Fixture::phase("n1", "human", 2)]), Some("n1"));
    f.worker("echo produced>produced.txt", json!("produced"), 0);
    f.run_task().await;
    assert_eq!(f.status(), "review");
    let waiting = f.last_event("gate.waiting");
    assert_eq!(waiting["payload"]["gate"], "human");
    assert_eq!(waiting["payload"]["maxLoop"], 2);
    assert_eq!(waiting["payload"]["rejectCount"], 0);

    let error = f.engine.review_task("T1").await.unwrap_err().to_string();
    assert_eq!(
        error,
        "这个阶段的门禁是人工确认，请点「通过」或「退回修改」，不需要自动评审"
    );

    f.engine.approve_task("T1").unwrap();
    assert_eq!(f.status(), "approved");
    let passed = f.last_event("gate.passed");
    assert_eq!(passed["payload"]["by"], "human");
    assert_eq!(passed["payload"]["manual"], false);
    assert_eq!(passed["payload"]["gate"], "human");

    f.engine.reject_task("T1", "再补一行").unwrap();
    assert_eq!(f.status(), "changes_requested");
    assert_eq!(f.task().reject_count, 1);
    assert!(f.task().feedback.contains("再补一行"));

    f.worker("echo more>>produced.txt", json!("produced"), 0);
    f.run_task().await;
    assert_eq!(f.status(), "review");
    f.engine.reject_task("T1", "还是不对").unwrap();
    assert_eq!(f.status(), "escalated");
    assert_eq!(f.task().reject_count, 2);
    let rejected = f.last_event("task.rejected");
    assert_eq!(rejected["payload"]["escalated"], true);
    assert_eq!(rejected["payload"]["maxLoop"], 2);
    assert_eq!(rejected["payload"]["rejectCount"], 2);
    let escalated = f.last_event("gate.escalated");
    assert_eq!(escalated["payload"]["by"], "human");
    assert_eq!(escalated["payload"]["gate"], "human");
    assert_eq!(escalated["payload"]["maxLoop"], 2);
    assert_eq!(escalated["payload"]["rejectCount"], 2);

    // 升级后再打回是人工再给一轮机会：打回计数清零。
    f.engine.reject_task("T1", "最后再试一次").unwrap();
    assert_eq!(f.status(), "changes_requested");
    assert_eq!(f.task().reject_count, 0);
}

#[tokio::test]
async fn task_without_phase_keeps_review_flow_and_approve_route_reports_errors() {
    let f = Fixture::new(json!([]), None);
    f.worker("echo produced>produced.txt", json!("produced"), 0);
    f.run_task().await;
    assert_eq!(f.status(), "review");
    let waiting = f.last_event("gate.waiting");
    assert_eq!(waiting["payload"]["gate"], "agent");
    assert_eq!(waiting["payload"]["maxLoop"], 2);
    assert_eq!(waiting["payload"]["rejectCount"], 0);

    // 没有绑定阶段时人工通过仍可用，路由与 Node 一致。
    let (status, body) = f.post("/api/tasks/T1/approve").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["status"], "approved");
    assert_eq!(f.status(), "approved");
    let passed = f.last_event("gate.passed");
    assert_eq!(passed["payload"]["by"], "human");
    assert_eq!(passed["payload"]["manual"], true);

    let (status, body) = f.post("/api/tasks/T1/approve").await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(body["error"], "任务已经通过，等待合并即可");

    // 归档会话在状态检查之前拒绝。
    f.sql("UPDATE rooms SET status='archived'");
    f.sql("UPDATE tasks SET status='review', result_sha='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'");
    let error = f.engine.approve_task("T1").unwrap_err().to_string();
    assert_eq!(error, "会话已归档，请先恢复再操作");
}

#[tokio::test]
async fn approve_task_reports_explicit_errors() {
    let f = Fixture::new(json!([]), None);
    assert_eq!(
        f.engine.approve_task("T404").unwrap_err().to_string(),
        "任务不存在，请刷新会话后重试"
    );

    f.sql("UPDATE tasks SET status='backlog'");
    assert_eq!(
        f.engine.approve_task("T1").unwrap_err().to_string(),
        "当前任务没有可确认的成果，请先运行任务"
    );
    assert_eq!(f.status(), "backlog");

    f.sql("UPDATE tasks SET status='running'");
    assert_eq!(
        f.engine.approve_task("T1").unwrap_err().to_string(),
        "任务正在执行，结束后再确认"
    );
    assert_eq!(f.status(), "running");

    f.sql("UPDATE tasks SET status='review', result_sha=''");
    assert_eq!(
        f.engine.approve_task("T1").unwrap_err().to_string(),
        "任务没有可确认的成果，请先运行任务"
    );
    assert_eq!(f.status(), "review");

    f.sql("UPDATE tasks SET status='approved', result_sha='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'");
    assert_eq!(
        f.engine.approve_task("T1").unwrap_err().to_string(),
        "任务已经通过，等待合并即可"
    );
    assert_eq!(f.status(), "approved");

    f.sql("DELETE FROM rooms WHERE id='r1'");
    f.sql("UPDATE tasks SET status='review'");
    assert_eq!(
        f.engine.approve_task("T1").unwrap_err().to_string(),
        "任务所属会话不存在，请刷新后重试"
    );
    assert_eq!(f.status(), "review");
}

fn has_reject_count(conn: &Connection) -> bool {
    conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM pragma_table_info('tasks') WHERE name='reject_count')",
        [],
        |row| row.get(0),
    )
    .unwrap()
}

#[test]
fn legacy_database_migration_adds_reject_count_and_backfills_reviews() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    drop(Store::open(data.clone()).unwrap());
    let conn = Connection::open(data.join("devhub.db")).unwrap();
    // 模拟第 9 轮之前的旧库：没有 reject_count 列，但已有评审记录。
    conn.execute_batch(
        "ALTER TABLE tasks DROP COLUMN reject_count;
         INSERT INTO rooms (id,name,repo_path,status,created_at,updated_at)
            VALUES ('r1','legacy','unused-fixture-repo','paused','old','old');
         INSERT INTO tasks (id,room_id,key,title,created_at,updated_at)
            VALUES ('t1','r1','T1','legacy rejected','old','old'),
                   ('t2','r1','T2','never rejected','old','old');
         INSERT INTO reviews (id,task_id,round,verdict,created_at) VALUES
            ('rv1','t1',1,'request_changes','old'),
            ('rv2','t1',2,'request_changes','old'),
            ('rv3','t1',3,'approve','old');",
    )
    .unwrap();
    assert!(!has_reject_count(&conn));
    drop(conn);

    let store = Store::open(data.clone()).unwrap();
    assert_eq!(store.task("t1").unwrap().unwrap().reject_count, 2);
    assert_eq!(store.task("t2").unwrap().unwrap().reject_count, 0);
    assert_eq!(
        task_payload(&store.task("t1").unwrap().unwrap())["reject_count"],
        2
    );

    // 迁移幂等：再次打开不会重新回填或覆盖运行期计数。
    {
        let db = store.db.lock().unwrap();
        db.execute("UPDATE tasks SET reject_count=1 WHERE id='t2'", [])
            .unwrap();
    }
    drop(store);
    let store = Store::open(data).unwrap();
    assert_eq!(store.task("t1").unwrap().unwrap().reject_count, 2);
    assert_eq!(store.task("t2").unwrap().unwrap().reject_count, 1);
}
