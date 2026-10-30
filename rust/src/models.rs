use chrono::Utc;
use rusqlite::Row;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::flow::default_flow;

pub fn now() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub fn uid(prefix: &str) -> String {
    let s = Uuid::new_v4().simple().to_string();
    format!("{}_{}", prefix, &s[..8])
}

pub fn safe_json(text: &str, fallback: Value) -> Value {
    if text.trim().is_empty() {
        return fallback;
    }
    serde_json::from_str(text).unwrap_or(fallback)
}

pub fn b(v: i64) -> bool {
    v != 0
}

#[derive(Clone, Debug)]
pub struct Room {
    pub id: String,
    pub name: String,
    pub requirement: String,
    pub repo_path: String,
    pub base_branch: String,
    pub flow_json: String,
    pub plan_json: String,
    pub status: String,
    pub mode: String,
    pub auto_approve: i64,
    pub planner_id: Option<String>,
    pub reviewer_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl Room {
    pub fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            name: row.get("name")?,
            requirement: row.get("requirement")?,
            repo_path: row.get("repo_path")?,
            base_branch: row.get("base_branch")?,
            flow_json: row.get("flow_json")?,
            plan_json: row.get("plan_json")?,
            status: row.get("status")?,
            mode: row.get("mode")?,
            auto_approve: row.get("auto_approve")?,
            planner_id: row.get("planner_id")?,
            reviewer_id: row.get("reviewer_id")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
        })
    }
}

#[derive(Clone, Debug)]
pub struct Member {
    pub id: String,
    pub room_id: String,
    pub name: String,
    pub worker: String,
    pub role_name: String,
    pub role_brief: String,
    pub model: String,
    pub concurrency: i64,
    pub enabled: i64,
    pub sort: i64,
}

impl Member {
    pub fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            room_id: row.get("room_id")?,
            name: row.get("name")?,
            worker: row.get("worker")?,
            role_name: row.get("role_name")?,
            role_brief: row.get("role_brief")?,
            model: row.get("model")?,
            concurrency: row.get("concurrency")?,
            enabled: row.get("enabled")?,
            sort: row.get("sort")?,
        })
    }
}

#[derive(Clone, Debug)]
pub struct Task {
    pub id: String,
    pub room_id: String,
    pub key: String,
    pub title: String,
    pub spec: String,
    pub task_type: String,
    pub owner_id: Option<String>,
    pub phase_id: Option<String>,
    pub status: String,
    pub deps_json: String,
    pub acceptance_json: String,
    pub worktree: String,
    pub branch: String,
    pub base_sha: String,
    pub feedback: String,
    pub summary: String,
    pub diff_stat: String,
    pub created_at: String,
    pub updated_at: String,
}

impl Task {
    pub fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            room_id: row.get("room_id")?,
            key: row.get("key")?,
            title: row.get("title")?,
            spec: row.get("spec")?,
            task_type: row.get("type")?,
            owner_id: row.get("owner_id")?,
            phase_id: row.get("phase_id")?,
            status: row.get("status")?,
            deps_json: row.get("deps_json")?,
            acceptance_json: row.get("acceptance_json")?,
            worktree: row.get("worktree")?,
            branch: row.get("branch")?,
            base_sha: row.get("base_sha")?,
            feedback: row.get("feedback")?,
            summary: row.get("summary")?,
            diff_stat: row.get("diff_stat")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
        })
    }
}

#[derive(Clone, Debug)]
pub struct Decision {
    pub id: String,
    pub room_id: String,
    pub text: String,
    pub rationale: String,
    pub status: String,
    pub created_at: String,
}

impl Decision {
    pub fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            room_id: row.get("room_id")?,
            text: row.get("text")?,
            rationale: row.get("rationale")?,
            status: row.get("status")?,
            created_at: row.get("created_at")?,
        })
    }
}

#[derive(Clone, Debug)]
pub struct Review {
    pub id: String,
    pub task_id: String,
    pub round: i64,
    pub verdict: String,
    pub payload: String,
    pub created_at: String,
}

impl Review {
    pub fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            task_id: row.get("task_id")?,
            round: row.get("round")?,
            verdict: row.get("verdict")?,
            payload: row.get("payload")?,
            created_at: row.get("created_at")?,
        })
    }
}

pub fn room_payload(r: &Room) -> Value {
    json!({
        "id": r.id,
        "name": r.name,
        "requirement": r.requirement,
        "repo_path": r.repo_path,
        "base_branch": r.base_branch,
        "status": r.status,
        "mode": r.mode,
        "auto_approve": b(r.auto_approve),
        "planner_id": r.planner_id,
        "reviewer_id": r.reviewer_id,
        "created_at": r.created_at,
        "updated_at": r.updated_at,
        "flow": safe_json(&r.flow_json, default_flow()),
        "plan": safe_json(&r.plan_json, Value::Null),
    })
}

pub fn member_payload(m: &Member) -> Value {
    json!({
        "id": m.id,
        "room_id": m.room_id,
        "name": m.name,
        "worker": m.worker,
        "role_name": m.role_name,
        "role_brief": m.role_brief,
        "model": m.model,
        "concurrency": m.concurrency,
        "enabled": b(m.enabled),
        "sort": m.sort,
    })
}

pub fn task_payload(t: &Task) -> Value {
    json!({
        "id": t.id,
        "room_id": t.room_id,
        "key": t.key,
        "title": t.title,
        "spec": t.spec,
        "type": t.task_type,
        "owner_id": t.owner_id,
        "phase_id": t.phase_id,
        "status": t.status,
        "deps": safe_json(&t.deps_json, json!([])),
        "acceptance": safe_json(&t.acceptance_json, json!([])),
        "worktree": t.worktree,
        "branch": t.branch,
        "base_sha": t.base_sha,
        "feedback": t.feedback,
        "summary": t.summary,
        "diff_stat": t.diff_stat,
        "created_at": t.created_at,
        "updated_at": t.updated_at,
    })
}
