use std::path::Path;
use std::process::Command;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tempfile::tempdir;
use tower::ServiceExt;

use devhub::api;
use devhub::engine::Engine;
use devhub::store::Store;

fn run(repo: &Path, args: &[&str]) {
    let out = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .expect("git");
    assert!(
        out.status.success(),
        "git {:?}: {}",
        args,
        String::from_utf8_lossy(&out.stderr)
    );
}

fn make_repo() -> (tempfile::TempDir, String) {
    let dir = tempdir().unwrap();
    let repo = dir.path().to_path_buf();
    run(&repo, &["init"]);
    std::fs::write(repo.join("README.md"), "# api test\n").unwrap();
    run(&repo, &["add", "-A"]);
    run(
        &repo,
        &[
            "-c",
            "user.name=DevHub",
            "-c",
            "user.email=devhub@local",
            "commit",
            "-m",
            "init",
        ],
    );
    let path = repo.to_string_lossy().to_string();
    (dir, path)
}

async fn json_body(resp: axum::response::Response) -> Value {
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&bytes).unwrap()
}

fn engine() -> (tempfile::TempDir, Engine) {
    let dir = tempdir().unwrap();
    let store = Store::open(dir.path().join("data")).unwrap();
    (dir, Engine::new(store))
}

#[tokio::test]
async fn health_and_state_work() {
    let (_dir, engine) = engine();
    let app = api::router(engine);

    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = json_body(resp).await;
    assert_eq!(body["ok"], true);

    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/state")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = json_body(resp).await;
    assert_eq!(body["rooms"].as_array().unwrap().len(), 0);
    assert_eq!(body["flowTemplates"].as_array().unwrap().len(), 5);
}

#[tokio::test]
async fn create_room_task_and_cancel_without_body() {
    let (_repo_dir, repo) = make_repo();
    let (_data_dir, engine) = engine();
    let app = api::router(engine);

    let body = json!({
        "name": "Rust API 测试",
        "repoPath": repo,
        "requirement": "验证 REST 契约",
        "mode": "parallel",
        "autoApprove": false,
        "flowTemplate": "code",
        "members": [
            { "name": "小前", "worker": "opencode", "roleName": "前端", "roleBrief": "只改前端", "concurrency": 1 },
            { "name": "小后", "worker": "dsh", "roleName": "后端", "roleBrief": "只改后端", "concurrency": 1 }
        ],
        "plannerName": "小前",
        "reviewerName": "小后"
    });
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/rooms")
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let state = json_body(resp).await;
    let room_id = state["room"]["id"].as_str().unwrap().to_string();
    let owner_id = state["members"][0]["id"].as_str().unwrap().to_string();
    assert_eq!(state["room"]["flow"]["nodes"].as_array().unwrap().len(), 5);

    let task_body = json!({
        "roomId": room_id,
        "title": "测试任务",
        "spec": "测试",
        "type": "research",
        "ownerId": owner_id,
        "acceptance": ["能创建"]
    });
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/tasks")
                .header("content-type", "application/json")
                .body(Body::from(task_body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let created = json_body(resp).await;
    let task_id = created["id"].as_str().unwrap().to_string();

    // 前端调用 cancel/run/retry 时不带 body，只带 Content-Type；必须接受空 body。
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/tasks/{}/cancel", task_id))
                .header("content-type", "application/json")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let resp = app
        .oneshot(
            Request::builder()
                .uri(format!("/api/rooms/{}", room_id))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let state = json_body(resp).await;
    assert_eq!(state["tasks"][0]["status"], "cancelled");
}
