use std::collections::HashMap;
use std::convert::Infallible;
use std::time::Duration;

use anyhow::Context;
use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, StatusCode, Uri},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    routing::{get, post},
    Json, Router,
};
use futures::Stream;
use serde_json::{json, Value};
use tokio::sync::broadcast::error::RecvError;

use crate::adapters::detect_workers;
use crate::assets::Assets;
use crate::engine::Engine;
use crate::flow::flow_template_list;
use crate::fs::browse_dir;
use crate::inbox;
use crate::inputs::{self, TaskInputs};
use crate::logs::{self, TaskLog};
use crate::models::now;
use crate::settings::SettingsError;

#[derive(Debug)]
pub struct AppError {
    status: StatusCode,
    message: String,
}

impl AppError {
    fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }

    fn not_found(message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, message)
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({ "error": self.message }))).into_response()
    }
}

impl From<anyhow::Error> for AppError {
    fn from(value: anyhow::Error) -> Self {
        let status = if let Some(error) = value.downcast_ref::<SettingsError>() {
            StatusCode::from_u16(error.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR)
        } else if let Some(error) = value.downcast_ref::<crate::engine::TaskCreationError>() {
            StatusCode::from_u16(error.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR)
        } else if value.is::<crate::engine::ResultConflict>() {
            StatusCode::CONFLICT
        } else if value.is::<inputs::InputsError>() {
            StatusCode::NOT_FOUND
        } else {
            StatusCode::INTERNAL_SERVER_ERROR
        };
        Self::new(status, value.to_string())
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(value: rusqlite::Error) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, value.to_string())
    }
}

pub fn router(engine: Engine) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/workers", get(workers))
        .route("/api/events", get(events))
        .route("/api/fs", get(fs_browse))
        .route("/api/state", get(state))
        .route("/api/stop-all", post(stop_all))
        .route("/api/rooms", post(create_room))
        .route(
            "/api/rooms/{id}",
            get(get_room).patch(patch_room).delete(delete_room),
        )
        .route("/api/rooms/{id}/members", post(add_member))
        .route("/api/rooms/{id}/settings", get(get_settings).patch(patch_settings))
        .route(
            "/api/members/{id}",
            axum::routing::patch(update_member).delete(delete_member),
        )
        .route("/api/rooms/{id}/plan", post(plan))
        .route("/api/rooms/{id}/plan/apply", post(apply_plan))
        .route("/api/rooms/{id}/start", post(start_room))
        .route("/api/rooms/{id}/pause", post(pause_room))
        .route("/api/rooms/{id}/runs/cancel", post(cancel_run))
        .route("/api/rooms/{id}/restore", post(restore_room))
        .route("/api/tasks", post(create_task))
        .route("/api/tasks/{id}/{action}", post(task_action))
        .route("/api/tasks/{id}/diff", get(task_diff))
        .route("/api/tasks/{id}/log", get(task_log))
        .route("/api/tasks/{id}/prompt", get(task_inputs))
        .route("/api/decisions", post(add_decision))
        .fallback(static_handler)
        .with_state(engine)
}

async fn health() -> Json<Value> {
    Json(json!({ "ok": true, "at": now() }))
}

async fn workers(State(engine): State<Engine>) -> Json<Value> {
    Json(json!({ "workers": detect_workers(&engine.store).await }))
}

async fn events(
    State(engine): State<Engine>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let mut rx = engine.store.subscribe();
    let stream = async_stream::stream! {
        loop {
            tokio::select! {
                r = rx.recv() => match r {
                    Ok(v) => yield Ok::<_, Infallible>(Event::default().data(v.to_string())),
                    Err(RecvError::Lagged(_)) => continue,
                    Err(RecvError::Closed) => break,
                },
                _ = tokio::time::sleep(Duration::from_secs(15)) => {
                    yield Ok::<_, Infallible>(Event::default().comment("ping"));
                }
            }
        }
    };
    Sse::new(stream).keep_alive(KeepAlive::default())
}

async fn fs_browse(Query(q): Query<HashMap<String, String>>) -> Result<Json<Value>, AppError> {
    Ok(Json(browse_dir(q.get("path").cloned())?))
}

async fn state(State(engine): State<Engine>) -> Result<Json<Value>, AppError> {
    Ok(Json(json!({
        "rooms": engine.list_rooms()?,
        "running": engine.running_tasks().await,
        "activeWorkers": engine.active_worker_count(),
        "flowTemplates": flow_template_list(),
        "inbox": inbox::list(&engine.store)?,
    })))
}

async fn stop_all(State(engine): State<Engine>) -> Result<Json<Value>, AppError> {
    Ok(Json(json!({ "stopped": engine.stop_all().await? })))
}

async fn create_room(
    State(engine): State<Engine>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, AppError> {
    Ok(Json(engine.create_room(body).await?))
}

async fn get_room(
    State(engine): State<Engine>,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    engine
        .room_state(&id)
        .await?
        .map(Json)
        .ok_or_else(|| AppError::not_found("房间不存在"))
}

async fn get_settings(
    State(engine): State<Engine>,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    Ok(Json(crate::settings::read(&engine.store, &id).map_err(anyhow::Error::from)?))
}

async fn patch_settings(
    State(engine): State<Engine>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, AppError> {
    Ok(Json(engine.save_room_settings(&id, &body).await?))
}

async fn patch_room(
    State(engine): State<Engine>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, AppError> {
    Ok(Json(engine.update_room(&id, &body).await?))
}

async fn delete_room(
    State(engine): State<Engine>,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    engine.archive_room(&id).await?;
    Ok(Json(json!({ "ok": true })))
}

async fn add_member(
    State(engine): State<Engine>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, AppError> {
    Ok(Json(engine.add_member(&id, &body).await?))
}

async fn update_member(
    State(engine): State<Engine>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, AppError> {
    Ok(Json(engine.update_member(&id, &body).await?))
}

async fn delete_member(
    State(engine): State<Engine>,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    engine.remove_member(&id).await?;
    Ok(Json(json!({ "ok": true })))
}

async fn plan(
    State(engine): State<Engine>,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let plan = engine.generate_plan(&id).await?;
    Ok(Json(json!({ "plan": plan })))
}

async fn apply_plan(
    State(engine): State<Engine>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, AppError> {
    let plan = body.get("plan").unwrap_or(&body);
    Ok(Json(engine.apply_plan(&id, plan)?))
}

async fn start_room(
    State(engine): State<Engine>,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    Ok(Json(engine.start_room(&id).await?))
}

async fn pause_room(
    State(engine): State<Engine>,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    engine.pause_room(&id).await?;
    Ok(Json(json!({ "ok": true })))
}

async fn cancel_run(
    State(engine): State<Engine>,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    Ok(Json(
        json!({ "cancelled": engine.cancel_room_run(&id).await }),
    ))
}

async fn restore_room(
    State(engine): State<Engine>,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    Ok(Json(engine.restore_room(&id).await?))
}

async fn create_task(
    State(engine): State<Engine>,
    body: axum::body::Bytes,
) -> Result<Json<Value>, AppError> {
    let body: Value = serde_json::from_slice(&body)
        .map_err(|_| AppError::new(StatusCode::BAD_REQUEST, "任务内容必须是合法 JSON 对象"))?;
    let id = engine.create_task(&body)?;
    Ok(Json(json!({ "id": id })))
}

async fn task_action(
    State(engine): State<Engine>,
    Path((id, action)): Path<(String, String)>,
    body: axum::body::Bytes,
) -> Result<Json<Value>, AppError> {
    let body: Value = if body.is_empty() {
        json!({})
    } else {
        serde_json::from_slice(&body).unwrap_or_else(|_| json!({}))
    };
    let expected_result = if ["review", "merge"].contains(&action.as_str()) {
        match body.get("resultSha") {
            Some(Value::String(sha)) => Some(sha.clone()),
            Some(_) => {
                return Err(AppError::new(
                    StatusCode::CONFLICT,
                    "任务成果已更新，请刷新 Diff 并重新确认后再操作",
                ))
            }
            None => None,
        }
    } else {
        None
    };
    match action.as_str() {
        "run" => Ok(Json(engine.start_task(&id).await?)),
        "review" => Ok(Json(engine.review_task_result(&id, expected_result).await?)),
        "approve" => Ok(Json(engine.approve_task(&id)?)),
        "merge" => Ok(Json(engine.merge_task_result(&id, expected_result).await?)),
        "reject" => {
            engine.reject_task(&id, body.get("note").and_then(Value::as_str).unwrap_or(""))?;
            Ok(Json(json!({ "ok": true })))
        }
        "retry" => {
            engine.retry_task(&id).await?;
            Ok(Json(json!({ "ok": true })))
        }
        "cancel" => {
            engine.cancel_task(&id).await?;
            Ok(Json(json!({ "ok": true })))
        }
        _ => Err(AppError::not_found("未知任务操作")),
    }
}

async fn task_diff(
    State(engine): State<Engine>,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    Ok(Json(engine.task_diff(&id).await?))
}

async fn task_log(
    State(engine): State<Engine>,
    Path(id): Path<String>,
) -> Result<Json<TaskLog>, AppError> {
    let store = engine.store.clone();
    let log = tokio::task::spawn_blocking(move || logs::latest(&store, &id))
        .await
        .context("查询任务日志记录失败")??;
    Ok(Json(log))
}

async fn task_inputs(
    State(engine): State<Engine>,
    Path(id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Json<TaskInputs>, AppError> {
    let selected = query.get("runId").cloned();
    let store = engine.store.clone();
    let inputs = tokio::task::spawn_blocking(move || inputs::read(&store, &id, selected.as_deref()))
        .await
        .context("读取任务执行输入失败")??;
    Ok(Json(inputs))
}

async fn add_decision(
    State(engine): State<Engine>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, AppError> {
    let id = engine.add_decision(&body)?;
    Ok(Json(json!({ "id": id })))
}

async fn static_handler(uri: Uri) -> Response {
    let mut path = uri.path().trim_start_matches('/');
    if path.is_empty() {
        path = "index.html";
    }
    if path.contains("..") {
        return (StatusCode::FORBIDDEN, "forbidden").into_response();
    }
    match Assets::get(path) {
        Some(file) => {
            let mime = mime_guess::from_path(path).first_or_octet_stream();
            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, mime.as_ref())
                .header(header::CACHE_CONTROL, "no-cache")
                .body(Body::from(file.data.into_owned()))
                .unwrap()
        }
        None => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}
