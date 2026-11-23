use axum::body::Body;
use axum::http::{Request, StatusCode};
use devhub::{api, engine::Engine, store::Store};
use http_body_util::BodyExt;
use rusqlite::params;
use serde_json::{json, Value};
use std::fs;
use std::io::Write;
use tempfile::{tempdir, TempDir};
use tower::ServiceExt;

const STARTED: &str = "2026-11-20T09:00:00.000Z";

fn fixture() -> (TempDir, Store, axum::Router) {
    let directory = tempdir().unwrap();
    let store = Store::open(directory.path().join("data")).unwrap();
    let app = api::router(Engine::new(store.clone()));
    {
        let db = store.db.lock().unwrap();
        db.execute(
            "INSERT INTO rooms (id, name, repo_path, created_at, updated_at) VALUES ('room', '测试', '.', ?, ?)",
            params![STARTED, STARTED],
        )
        .unwrap();
        db.execute(
            "INSERT INTO members (id, room_id, name, worker) VALUES ('member', 'room', '辅助成员', 'codex')",
            [],
        )
        .unwrap();
        db.execute(
            "INSERT INTO tasks (id, room_id, key, title, created_at, updated_at) VALUES ('task', 'room', 'T1', '说明任务', ?, ?)",
            params![STARTED, STARTED],
        )
        .unwrap();
    }
    (directory, store, app)
}

async fn get_log(app: &axum::Router) -> (StatusCode, Value) {
    let response = app
        .clone()
        .oneshot(
            Request::get("/api/tasks/task/log")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap())
}

fn add_run(store: &Store, id: &str, status: &str, path: Option<&str>, error: &str, code: Option<i64>, started: &str) {
    store.db.lock().unwrap().execute(
        "INSERT INTO runs (id, task_id, member_id, status, log_path, error, exit_code, started_at, ended_at)
         VALUES (?, 'task', 'member', ?, ?, ?, ?, ?, NULL)",
        params![id, status, path.unwrap_or(""), error, code, started],
    ).unwrap();
}

fn assert_metadata(log: &Value, id: &str, status: &str, error: &str, exit_code: Option<i64>, expected: &str) {
    assert_eq!(log["log"], expected);
    assert_eq!(log["runId"], id);
    assert_eq!(log["status"], status);
    assert_eq!(log["error"], error);
    assert_eq!(log["exitCode"], exit_code.map_or(Value::Null, Value::from));
    assert_eq!(log["startedAt"], STARTED);
    assert!(log["endedAt"].is_null());
    assert_eq!(log["readError"], "");
    assert!(log.get("logPath").is_none());
}

#[tokio::test]
async fn a_database_error_is_not_misreported_as_an_empty_run() {
    let (_directory, store, app) = fixture();
    store.db.lock().unwrap().execute_batch("DROP TABLE runs").unwrap();
    let (status, error) = get_log(&app).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert!(error["error"].as_str().is_some());
    assert!(error.get("log").is_none());
}

#[tokio::test]
async fn absent_run_returns_the_exact_empty_contract() {
    let (_directory, _store, app) = fixture();
    let (status, log) = get_log(&app).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        log,
        json!({
            "log": "", "runId": null, "status": "", "error": "", "exitCode": null,
            "startedAt": null, "endedAt": null, "truncated": false, "totalBytes": 0, "readError": ""
        })
    );
}

#[tokio::test]
async fn newest_run_uses_rowid_tie_break_and_blank_path_fallback() {
    let (_directory, store, app) = fixture();
    let fallback = store.logs.join("run-latest.log");
    fs::write(&fallback, "早期内容\r\n最后一行\n").unwrap();
    add_run(&store, "run-older", "completed", None, "旧原因", Some(2), STARTED);
    add_run(&store, "run-latest", "interrupted", Some(""), "重启中断，请手动重试", None, STARTED);

    let (status, log) = get_log(&app).await;
    assert_eq!(status, StatusCode::OK);
    assert_metadata(&log, "run-latest", "interrupted", "重启中断，请手动重试", None, "早期内容\r\n最后一行\n");
    assert_eq!(log["totalBytes"], fs::metadata(fallback).unwrap().len());
    assert_eq!(log["truncated"], false);
}

#[tokio::test]
async fn small_utf8_multibyte_and_crlf_logs_are_byte_exact() {
    let (_directory, store, app) = fixture();
    let path = store.logs.join("compact.log");
    let expected = "第一步\r\n结果 ✅\n末行\r\n";
    fs::write(&path, expected).unwrap();
    add_run(&store, "run-compact", "failed", Some(path.to_str().unwrap()), "worker exit 17", Some(17), STARTED);
    let (_status, log) = get_log(&app).await;
    assert_metadata(&log, "run-compact", "failed", "worker exit 17", Some(17), expected);
    assert_eq!(log["totalBytes"], expected.len());
    assert_eq!(log["truncated"], false);
}

#[tokio::test]
async fn missing_file_keeps_run_metadata_without_a_read_error() {
    let (_directory, store, app) = fixture();
    add_run(&store, "run-missing", "interrupted", Some(store.logs.join("missing.log").to_str().unwrap()), "检查工作区后重试", None, STARTED);
    let (_status, log) = get_log(&app).await;
    assert_metadata(&log, "run-missing", "interrupted", "检查工作区后重试", None, "");
    assert_eq!(log["totalBytes"], 0);
    assert_eq!(log["truncated"], false);
}

#[tokio::test]
async fn a_non_file_path_reports_read_error_without_rewriting_the_worker_error() {
    let (directory, store, app) = fixture();
    let folder = directory.path().join("log-directory");
    fs::create_dir(&folder).unwrap();
    add_run(&store, "run-directory", "failed", Some(folder.to_str().unwrap()), "worker process failed", Some(9), STARTED);
    let (_status, log) = get_log(&app).await;
    assert_eq!(log["runId"], "run-directory");
    assert_eq!(log["status"], "failed");
    assert_eq!(log["error"], "worker process failed");
    assert_eq!(log["exitCode"], 9);
    assert_eq!(log["readError"], "无法读取运行日志，请重试。");
    assert_eq!(log["log"], "");
}

#[tokio::test]
async fn a_multimegabyte_file_returns_only_a_bounded_utf8_tail() {
    let (_directory, store, app) = fixture();
    let path = store.logs.join("large.log");
    let mut file = fs::File::create(&path).unwrap();
    for index in 0..3_000 {
        writeln!(file, "row-{index:04}-{}", "x".repeat(500)).unwrap();
    }
    writeln!(file, "最新记录 ✅").unwrap();
    file.flush().unwrap();
    let size = file.metadata().unwrap().len();
    assert!(size > 1_000_000);
    add_run(&store, "run-large", "completed", Some(path.to_str().unwrap()), "", Some(0), STARTED);

    let (_status, log) = get_log(&app).await;
    let text = log["log"].as_str().unwrap();
    assert!(text.len() <= 140_000, "actual returned bytes: {}", text.len());
    assert_eq!(log["totalBytes"], size);
    assert_eq!(log["truncated"], true);
    assert!(text.contains("最新记录 ✅"));
    assert!(text.lines().count() <= 2_000);
    assert!(std::str::from_utf8(text.as_bytes()).is_ok());
}

#[tokio::test]
async fn an_oversized_single_line_is_retained_even_when_only_terminal_lf_remains() {
    let (_directory, store, app) = fixture();
    let path = store.logs.join("single-line.log");
    let mut file = fs::File::create(&path).unwrap();
    file.write_all(&"文".repeat(400_000).into_bytes()).unwrap();
    file.write_all(b"\n").unwrap();
    file.flush().unwrap();
    let size = file.metadata().unwrap().len();
    add_run(&store, "run-single-line", "running", Some(path.to_str().unwrap()), "", None, STARTED);

    let (_status, log) = get_log(&app).await;
    let text = log["log"].as_str().unwrap();
    assert!(!text.is_empty());
    assert!(text.len() <= 140_000);
    assert!(text.ends_with('\n'));
    assert_eq!(log["totalBytes"], size);
    assert_eq!(log["truncated"], true);
    assert!(std::str::from_utf8(text.as_bytes()).is_ok());
}

#[tokio::test]
async fn seek_aligns_on_newline_and_caps_recent_lines_independently() {
    let (_directory, store, app) = fixture();
    let path = store.logs.join("line-count.log");
    let mut file = fs::File::create(&path).unwrap();
    for index in 0..3_000 {
        writeln!(file, "r{index:04}").unwrap();
    }
    file.flush().unwrap();
    let size = file.metadata().unwrap().len();
    assert!(size < 128 * 1024);
    add_run(&store, "run-lines", "completed", Some(path.to_str().unwrap()), "", Some(0), STARTED);

    let (_status, log) = get_log(&app).await;
    let text = log["log"].as_str().unwrap();
    assert!(text.len() <= 140_000);
    assert_eq!(text.lines().count(), 2_000);
    assert!(text.starts_with("r1000\n"));
    assert!(text.ends_with("r2999\n"));
    assert_eq!(log["totalBytes"], size);
    assert_eq!(log["truncated"], true);
    assert!(std::str::from_utf8(text.as_bytes()).is_ok());
}

#[tokio::test]
async fn a_long_record_without_any_newline_returns_a_valid_bounded_tail() {
    let (_directory, store, app) = fixture();
    let path = store.logs.join("no-newline.log");
    fs::write(&path, "界".repeat(400_000)).unwrap();
    let size = fs::metadata(&path).unwrap().len();
    add_run(&store, "run-no-newline", "running", Some(path.to_str().unwrap()), "", None, STARTED);

    let (_status, log) = get_log(&app).await;
    let text = log["log"].as_str().unwrap();
    assert!(!text.is_empty());
    assert!(text.len() <= 140_000);
    assert_eq!(text.lines().count(), 1);
    assert!(text.chars().all(|character| character == '界'));
    assert_eq!(log["totalBytes"], size);
    assert_eq!(log["truncated"], true);
}

