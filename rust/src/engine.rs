use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use rusqlite::{params, params_from_iter, types::Value as SqlValue, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use tokio::sync::Mutex as AsyncMutex;

use crate::adapters::{is_worker, kill_tree, run_worker, WorkerOpts, WorkerResult};
use crate::flow::{default_flow, starter_flow};
use crate::git;
use crate::models::{member_payload, now, safe_json, uid, Member, Room, Task};
use crate::plan::validate_plan;
use crate::prompts::{build_plan_prompt, build_review_prompt, build_task_prompt};
use crate::store::Store;

const GLOBAL_LIMIT: usize = 3;
const ROOM_LIMIT: usize = 2;

#[derive(Clone)]
pub struct RunHolder {
    pub room_id: String,
    pub member_id: String,
    pub run_id: String,
    pub phase: String,
    pub pid: Arc<Mutex<Option<u32>>>,
    pub cancelled: Arc<AtomicBool>,
}

struct TaskStartContext {
    task: Task,
    room: Room,
    member: Member,
    upstream: Vec<Task>,
}

struct TaskReservation {
    initial: TaskStartContext,
    holder: RunHolder,
    automatic: bool,
}

#[derive(Debug)]
struct TaskStartBlocked(String);

impl std::fmt::Display for TaskStartBlocked {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for TaskStartBlocked {}

/// 基准分支不可用时的错误：文案已经自解释，外层不再加「准备工作区失败」前缀。
#[derive(Debug)]
struct BaseBranchError(String);

impl std::fmt::Display for BaseBranchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for BaseBranchError {}

#[derive(Debug)]
pub struct ResultConflict(pub String);

impl std::fmt::Display for ResultConflict {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ResultConflict {}

#[derive(Debug)]
pub struct TaskCreationError {
    pub status: u16,
    message: String,
}

impl TaskCreationError {
    pub(crate) fn new(status: u16, message: impl Into<String>) -> Self {
        Self { status, message: message.into() }
    }
}

impl std::fmt::Display for TaskCreationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for TaskCreationError {}

type TaskOperations = Arc<Mutex<HashMap<String, (String, LiveRun)>>>;

struct TaskOperation {
    task_id: String,
    token: String,
    holder: LiveRun,
    operations: TaskOperations,
    live_runs: Arc<Mutex<HashMap<String, LiveRun>>>,
}

impl Drop for TaskOperation {
    fn drop(&mut self) {
        let mut operations = self.operations.lock().unwrap();
        if operations.get(&self.task_id).map(|(token, _)| token) == Some(&self.token) {
            operations.remove(&self.task_id);
        }
        if self.holder.kind == "review" {
            self.live_runs.lock().unwrap().remove(&self.token);
        }
    }
}

struct PlanActivity {
    token: String,
    live_runs: Arc<Mutex<HashMap<String, LiveRun>>>,
}

impl Drop for PlanActivity {
    fn drop(&mut self) {
        self.live_runs.lock().unwrap().remove(&self.token);
    }
}

struct TaskResult {
    task: Task,
    room: Room,
    sha: String,
    diff: String,
}

fn stale_result() -> anyhow::Error {
    ResultConflict("任务成果已更新，请刷新 Diff 并重新确认后再操作".into()).into()
}

// 流程没写上限时的旧行为：最多打回 2 次，第 2 次不通过升级到收件箱。
const DEFAULT_MAX_LOOP: i64 = 2;

/// 任务所属阶段的门禁。没绑定阶段、旧流程没有 gate、或数据不合法时按「评审通过」处理，
/// 这样不挂阶段的任务保持原来的人工点「自动检查」流程。
struct TaskGate {
    gate: String,
    max_loop: i64,
}

fn task_gate(room: Option<&Room>, task: Option<&Task>) -> TaskGate {
    let flow = room
        .map(|room| safe_json(&room.flow_json, Value::Null))
        .unwrap_or(Value::Null);
    let phase_id = task.and_then(|task| task.phase_id.as_deref());
    let phase = phase_id.and_then(|phase_id| {
        flow.get("nodes")
            .and_then(Value::as_array)
            .and_then(|nodes| {
                nodes.iter().find(|node| {
                    node.get("type").and_then(Value::as_str) == Some("phase")
                        && node.get("id").and_then(Value::as_str) == Some(phase_id)
                })
            })
    });
    let gate = phase
        .and_then(|phase| phase.get("gate").and_then(Value::as_str))
        .filter(|gate| ["auto", "agent", "human"].contains(gate))
        .unwrap_or("agent");
    let max_loop = phase
        .and_then(|phase| phase.get("maxLoop"))
        .and_then(json_integer)
        .filter(|max_loop| *max_loop >= 1)
        .unwrap_or(DEFAULT_MAX_LOOP);
    TaskGate {
        gate: gate.to_string(),
        max_loop,
    }
}

/// JSON 数字里的整数（与 Node 的 `Number.isInteger` 对齐，`2.0` 也算整数）。
fn json_integer(value: &Value) -> Option<i64> {
    if let Some(integer) = value.as_i64() {
        return Some(integer);
    }
    let number = value.as_f64()?;
    if number.is_finite() && number.fract() == 0.0 {
        Some(number as i64)
    } else {
        None
    }
}

#[derive(Clone)]
pub struct LiveRun {
    pub kind: String,
    pub room_id: String,
    pub task_id: Option<String>,
    pub pid: Arc<Mutex<Option<u32>>>,
    pub cancelled: Arc<AtomicBool>,
}

#[derive(Clone)]
pub struct Engine {
    pub store: Store,
    // This is also the scheduling lock: eligibility, reservations and state changes
    // are synchronous, so apply_plan can hold the same lock through its transaction.
    running: Arc<Mutex<HashMap<String, RunHolder>>>,
    live_runs: Arc<Mutex<HashMap<String, LiveRun>>>,
    task_operations: TaskOperations,
    merge_queue: Arc<AsyncMutex<()>>,
}

#[derive(Clone)]
struct NormalizedMember {
    name: String,
    worker: String,
    role_name: String,
    role_brief: String,
    model: String,
    concurrency: i64,
    enabled: bool,
}

impl Engine {
    pub fn new(store: Store) -> Self {
        Self {
            store,
            running: Arc::new(Mutex::new(HashMap::new())),
            live_runs: Arc::new(Mutex::new(HashMap::new())),
            task_operations: Arc::new(Mutex::new(HashMap::new())),
            merge_queue: Arc::new(AsyncMutex::new(())),
        }
    }

    pub fn list_rooms(&self) -> Result<Vec<Value>> {
        self.store.list_rooms()
    }

    pub async fn running_tasks(&self) -> Vec<Value> {
        self.running
            .lock()
            .unwrap()
            .iter()
            .map(|(task_id, h)| {
                json!({
                    "taskId": task_id,
                    "roomId": h.room_id,
                    "memberId": h.member_id,
                    "runId": h.run_id,
                    "phase": h.phase,
                    "pid": *h.pid.lock().unwrap(),
                })
            })
            .collect()
    }

    async fn running_ids(&self, room_id: &str) -> Vec<String> {
        self.running
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, h)| h.room_id == room_id)
            .map(|(id, _)| id.clone())
            .collect()
    }

    pub async fn room_state(&self, room_id: &str) -> Result<Option<Value>> {
        let running = self.running_ids(room_id).await;
        self.store.room_state(room_id, running)
    }

    pub async fn create_room(&self, input: Value) -> Result<Value> {
        let repo_path = input
            .get("repoPath")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        if repo_path.is_empty() {
            bail!("请填写仓库路径");
        }
        if !git::is_repo(&repo_path).await {
            bail!("不是 git 仓库：{}", repo_path);
        }
        let base_branch = input
            .get("baseBranch")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .map(|s| s.to_string())
            .unwrap_or_else(|| String::new());
        let base_branch = if base_branch.is_empty() {
            git::current_branch(&repo_path).await
        } else {
            base_branch
        };
        // 空仓库（还没有任何提交）会在第一次运行才失败，建会话时就明确拒绝更好。
        if git::rev_parse(&repo_path, &base_branch).await.is_err() {
            bail!(
                "仓库的基准分支「{}」还不能解析成提交：请确认仓库至少有一次提交，或换一个项目",
                base_branch
            );
        }
        let room_id = uid("r");
        let ts = now();

        let mut flow = starter_flow(
            input
                .get("flowTemplate")
                .and_then(Value::as_str)
                .unwrap_or(""),
        )
        .unwrap_or_else(default_flow);
        if let Some(src_id) = input.get("flowFromRoomId").and_then(Value::as_str) {
            if let Some(src) = self.store.room(src_id)? {
                let copied = safe_json(&src.flow_json, Value::Null);
                if copied
                    .get("nodes")
                    .and_then(Value::as_array)
                    .map(|a| !a.is_empty())
                    .unwrap_or(false)
                {
                    flow = copied;
                    flow["id"] = Value::String(uid("flow"));
                }
            }
        }

        let members = input
            .get("members")
            .and_then(Value::as_array)
            .filter(|a| !a.is_empty())
            .map(|arr| arr.iter().map(normalize_member).collect::<Result<Vec<_>>>())
            .transpose()?
            .unwrap_or_else(|| {
                vec![NormalizedMember {
                    name: "成员 1".into(),
                    worker: "claude".into(),
                    role_name: "执行者".into(),
                    role_brief: String::new(),
                    model: String::new(),
                    concurrency: 1,
                    enabled: true,
                }]
            });

        {
            let conn = self.store.db.lock().unwrap();
            conn.execute(
                "INSERT INTO rooms (id, name, requirement, repo_path, base_branch, flow_json, status, mode, auto_approve, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                params![
                    room_id,
                    input.get("name").and_then(Value::as_str).unwrap_or("未命名房间"),
                    input.get("requirement").and_then(Value::as_str).unwrap_or(""),
                    repo_path,
                    base_branch,
                    flow.to_string(),
                    "draft",
                    if input.get("mode").and_then(Value::as_str) == Some("serial") { "serial" } else { "parallel" },
                    if input.get("autoApprove").and_then(Value::as_bool) == Some(false) { 0 } else { 1 },
                    ts,
                    ts,
                ],
            )?;
        }
        for (i, m) in members.iter().enumerate() {
            insert_member(&self.store, &room_id, m, i as i64)?;
        }
        let list = self.store.members(&room_id)?;
        let pick =
            |id: Option<&str>, name: Option<&str>, fallback: Option<&str>| -> Option<String> {
                if let Some(id) = id {
                    if list.iter().any(|m| m.id == id) {
                        return Some(id.to_string());
                    }
                }
                if let Some(name) = name {
                    if let Some(hit) = list.iter().find(|m| m.name == name) {
                        return Some(hit.id.clone());
                    }
                }
                fallback.map(|s| s.to_string())
            };
        let planner_id = pick(
            input.get("plannerId").and_then(Value::as_str),
            input.get("plannerName").and_then(Value::as_str),
            list.first().map(|m| m.id.as_str()),
        );
        let reviewer_id = pick(
            input.get("reviewerId").and_then(Value::as_str),
            input.get("reviewerName").and_then(Value::as_str),
            list.last().map(|m| m.id.as_str()),
        );
        {
            let conn = self.store.db.lock().unwrap();
            conn.execute(
                "UPDATE rooms SET planner_id=?, reviewer_id=? WHERE id=?",
                params![planner_id, reviewer_id, room_id],
            )?;
        }
        self.store.emit(
            Some(&room_id),
            None,
            None,
            "room.created",
            json!({ "name": input.get("name").and_then(Value::as_str).unwrap_or(""), "repo": repo_path }),
        );
        Ok(self.room_state(&room_id).await?.unwrap_or(Value::Null))
    }

    pub async fn save_room_settings(&self, room_id: &str, body: &Value) -> Result<Value> {
        let scheduling = self.running.lock().unwrap();
        let operations = self.task_operations.lock().unwrap();
        let live_runs = self.live_runs.lock().unwrap();
        let busy = scheduling.values().any(|run| run.room_id == room_id)
            || operations.values().any(|(_, run)| run.room_id == room_id)
            || live_runs.values().any(|run| run.room_id == room_id);
        if busy {
            return Err(crate::settings::SettingsError::conflict("会话正在运行任务、计划或评审；请等待完成或先停止后再保存").into());
        }
        let result = crate::settings::save(&self.store, room_id, body)?;
        drop(live_runs);
        drop(operations);
        drop(scheduling);
        self.store.emit(Some(room_id), None, None, "room.settings_updated", json!({}));
        Ok(result)
    }

    pub async fn update_room(&self, room_id: &str, patch: &Value) -> Result<Value> {
        {
            let scheduling = self.running.lock().unwrap();
            let operations = self.task_operations.lock().unwrap();
            let live_runs = self.live_runs.lock().unwrap();
            let room = self
                .store
                .room(room_id)?
                .ok_or_else(|| crate::settings::SettingsError::not_found("会话不存在，请刷新后重新选择"))?;
            if room.status == "archived" {
                return Err(crate::settings::SettingsError::conflict("会话已归档，请先恢复再修改").into());
            }
            let mut name = room.name.clone();
            let mut requirement = room.requirement.clone();
            let mut mode = room.mode.clone();
            let mut auto_approve = room.auto_approve;
            let mut planner_id = room.planner_id.clone();
            let mut reviewer_id = room.reviewer_id.clone();
            let mut flow_json = room.flow_json.clone();

            if let Some(v) = patch.get("name") {
                let s = v.as_str().unwrap_or("").trim().to_string();
                if s.is_empty() {
                    bail!("会话名不能为空");
                }
                name = s;
            }
            if let Some(v) = patch.get("requirement") {
                requirement = v.as_str().unwrap_or("").trim().to_string();
            }
            if let Some(v) = patch.get("mode") {
                let s = v.as_str().unwrap_or("");
                if !["serial", "parallel"].contains(&s) {
                    bail!("未知并发模式");
                }
                mode = s.to_string();
            }
            if let Some(v) = patch.get("autoApprove").and_then(Value::as_bool) {
                auto_approve = if v { 1 } else { 0 };
            }
            for (key, slot) in [
                ("planner_id", &mut planner_id),
                ("reviewer_id", &mut reviewer_id),
            ] {
                if let Some(v) = patch.get(key) {
                    let id = v.as_str().unwrap_or("").to_string();
                    if !id.is_empty() && !self.store.members(room_id)?.iter().any(|m| m.id == id) {
                        bail!("指定的成员不属于这个会话");
                    }
                    *slot = if id.is_empty() { None } else { Some(id) };
                }
            }
            if let Some(v) = patch.get("flow") {
                let busy = scheduling.values().any(|run| run.room_id == room_id)
                    || operations.values().any(|(_, run)| run.room_id == room_id)
                    || live_runs.values().any(|run| run.room_id == room_id);
                if busy {
                    return Err(crate::settings::SettingsError::conflict("会话正在运行任务、计划或评审；请等待完成后再修改流程").into());
                }
                let expected = patch.get("expectedFlow").ok_or_else(||
                    crate::settings::SettingsError::bad_request("缺少流程版本，请重新打开流程后重试"))?;
                let current = safe_json(&room.flow_json, Value::Null);
                if expected != &current {
                    return Err(ResultConflict("流程已在其他地方更新，请重新加载最新流程后再保存".into()).into());
                }
                let member_names = self
                    .store
                    .members(room_id)?
                    .into_iter()
                    .map(|member| member.name)
                    .collect::<Vec<_>>();
                crate::flow::validate_flow(v, &member_names)?;
                flow_json = v.to_string();
            }
            {
                let conn = self.store.db.lock().unwrap();
                conn.execute(
                "UPDATE rooms SET name=?, requirement=?, mode=?, auto_approve=?, planner_id=?, reviewer_id=?, flow_json=?, updated_at=? WHERE id=?",
                params![name, requirement, mode, auto_approve, planner_id, reviewer_id, flow_json, now(), room_id],
            )?;
            }
            let keys = patch
                .as_object()
                .map(|m| m.keys().cloned().collect::<Vec<_>>())
                .unwrap_or_default();
            self.store.emit(
                Some(room_id),
                None,
                None,
                "room.updated",
                json!({ "keys": keys }),
            );
        }
        Ok(self.room_state(room_id).await?.unwrap_or(Value::Null))
    }

    pub async fn archive_room(&self, room_id: &str) -> Result<()> {
        let running = self.running.lock().unwrap();
        let room = self
            .store
            .room(room_id)?
            .ok_or_else(|| anyhow::anyhow!("房间不存在"))?;
        if room.status == "archived" {
            return Ok(());
        }
        let live = running.values().any(|r| r.room_id == room_id)
            || self
                .task_operations
                .lock()
                .unwrap()
                .values()
                .any(|(_, run)| run.room_id == room_id)
            || self
                .live_runs
                .lock()
                .unwrap()
                .values()
                .any(|r| r.room_id == room_id);
        if live {
            bail!("还有任务、计划或评审在运行，不能归档");
        }
        {
            let conn = self.store.db.lock().unwrap();
            conn.execute(
                "UPDATE rooms SET status=?, updated_at=? WHERE id=?",
                params!["archived", now(), room_id],
            )?;
        }
        self.store
            .emit(Some(room_id), None, None, "room.archived", json!({}));
        Ok(())
    }

    pub async fn restore_room(&self, room_id: &str) -> Result<Value> {
        let room = self
            .store
            .room(room_id)?
            .ok_or_else(|| anyhow::anyhow!("房间不存在"))?;
        if room.status != "archived" {
            return Ok(self.room_state(room_id).await?.unwrap_or(Value::Null));
        }
        {
            let conn = self.store.db.lock().unwrap();
            conn.execute(
                "UPDATE rooms SET status=?, updated_at=? WHERE id=?",
                params!["draft", now(), room_id],
            )?;
        }
        self.store
            .emit(Some(room_id), None, None, "room.restored", json!({}));
        Ok(self.room_state(room_id).await?.unwrap_or(Value::Null))
    }

    pub async fn add_member(&self, room_id: &str, m: &Value) -> Result<Value> {
        let _scheduling = self.running.lock().unwrap();
        let room = self
            .store
            .room(room_id)?
            .ok_or_else(|| anyhow::anyhow!("房间不存在"))?;
        if room.status == "archived" {
            bail!("会话已归档，请先恢复再修改");
        }
        let n: i64 = {
            let conn = self.store.db.lock().unwrap();
            conn.query_row(
                "SELECT COALESCE(MAX(sort), -1) + 1 FROM members WHERE room_id=?",
                params![room_id],
                |r| r.get(0),
            )?
        };
        let normalized = normalize_member(m)?;
        let member = insert_member(&self.store, room_id, &normalized, n)?;
        self.store.emit(
            Some(room_id),
            None,
            None,
            "member.added",
            json!({ "name": member.name }),
        );
        Ok(member_payload(&member))
    }

    pub async fn update_member(&self, member_id: &str, patch: &Value) -> Result<Value> {
        let _scheduling = self.running.lock().unwrap();
        let m = self
            .store
            .member(member_id)?
            .ok_or_else(|| anyhow::anyhow!("成员不存在"))?;
        if let Some(room) = self.store.room(&m.room_id)? {
            if room.status == "archived" {
                bail!("会话已归档，请先恢复再修改");
            }
        }
        let mut name = m.name.clone();
        let mut worker = m.worker.clone();
        let mut role_name = m.role_name.clone();
        let mut role_brief = m.role_brief.clone();
        let mut model = m.model.clone();
        let mut concurrency = m.concurrency;
        let mut enabled = m.enabled;
        if let Some(v) = patch.get("name") {
            let s = v.as_str().unwrap_or("").trim().to_string();
            if s.is_empty() {
                bail!("成员名不能为空");
            }
            name = s;
        }
        if let Some(v) = patch.get("worker") {
            let s = v.as_str().unwrap_or("");
            if !is_worker(s) {
                bail!("未知 worker：{}", s);
            }
            worker = s.to_string();
        }
        for (key, slot) in [
            ("role_name", &mut role_name),
            ("role_brief", &mut role_brief),
            ("model", &mut model),
        ] {
            if let Some(v) = patch.get(key) {
                *slot = v.as_str().unwrap_or("").trim().to_string();
            }
        }
        if let Some(v) = patch.get("concurrency").and_then(Value::as_i64) {
            concurrency = v.clamp(1, 10);
        }
        if let Some(v) = patch.get("enabled").and_then(Value::as_bool) {
            enabled = if v { 1 } else { 0 };
        }
        {
            let conn = self.store.db.lock().unwrap();
            conn.execute(
                "UPDATE members SET name=?, worker=?, role_name=?, role_brief=?, model=?, concurrency=?, enabled=? WHERE id=?",
                params![name, worker, role_name, role_brief, model, concurrency, enabled, member_id],
            )?;
        }
        let next = self
            .store
            .member(member_id)?
            .ok_or_else(|| anyhow::anyhow!("成员不存在"))?;
        self.store.emit(
            Some(&m.room_id),
            None,
            None,
            "member.updated",
            json!({ "name": next.name }),
        );
        Ok(member_payload(&next))
    }

    pub async fn remove_member(&self, member_id: &str) -> Result<()> {
        let _scheduling = self.running.lock().unwrap();
        let m = self
            .store
            .member(member_id)?
            .ok_or_else(|| anyhow::anyhow!("成员不存在"))?;
        if let Some(room) = self.store.room(&m.room_id)? {
            if room.status == "archived" {
                bail!("会话已归档，请先恢复再修改");
            }
        }
        let (total, owned, planner_id, reviewer_id) = {
            let conn = self.store.db.lock().unwrap();
            let total: i64 = conn.query_row(
                "SELECT COUNT(*) FROM members WHERE room_id=?",
                params![m.room_id],
                |r| r.get(0),
            )?;
            let owned: i64 = conn.query_row(
                "SELECT COUNT(*) FROM tasks WHERE owner_id=?",
                params![member_id],
                |r| r.get(0),
            )?;
            let room = conn
                .query_row(
                    "SELECT planner_id, reviewer_id FROM rooms WHERE id=?",
                    params![m.room_id],
                    |r| {
                        Ok((
                            r.get::<_, Option<String>>(0)?,
                            r.get::<_, Option<String>>(1)?,
                        ))
                    },
                )
                .optional()?
                .unwrap_or((None, None));
            (total, owned, room.0, room.1)
        };
        if total <= 1 {
            bail!("会话至少要保留一个成员");
        }
        if owned > 0 {
            bail!(
                "「{}」名下还有 {} 个任务，不能删除；可以先停用这个成员。",
                m.name,
                owned
            );
        }
        {
            let conn = self.store.db.lock().unwrap();
            conn.execute("DELETE FROM members WHERE id=?", params![member_id])?;
            let fallback: Option<String> = conn
                .query_row(
                    "SELECT id FROM members WHERE room_id=? ORDER BY sort, name LIMIT 1",
                    params![m.room_id],
                    |r| r.get(0),
                )
                .optional()?;
            if planner_id.as_deref() == Some(member_id) {
                conn.execute(
                    "UPDATE rooms SET planner_id=? WHERE id=?",
                    params![fallback, m.room_id],
                )?;
            }
            if reviewer_id.as_deref() == Some(member_id) {
                conn.execute(
                    "UPDATE rooms SET reviewer_id=? WHERE id=?",
                    params![fallback, m.room_id],
                )?;
            }
        }
        self.store.emit(
            Some(&m.room_id),
            None,
            None,
            "member.removed",
            json!({ "name": m.name }),
        );
        Ok(())
    }

    pub async fn generate_plan(&self, room_id: &str) -> Result<Value> {
        let (room, planner, members, flow, prompt, run_id, pid, cancelled) = {
        let _scheduling = self.running.lock().unwrap();
        let room = self
            .store
            .room(room_id)?
            .ok_or_else(|| anyhow::anyhow!("房间不存在"))?;
        if room.status == "archived" {
            bail!("会话已归档，请先恢复再生成计划");
        }
        let members = self.store.members(room_id)?;
        if members.is_empty() {
            bail!("房间还没有成员");
        }
        let planner = members
            .iter()
            .find(|m| Some(&m.id) == room.planner_id.as_ref())
            .or_else(|| members.first())
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("没有可用的计划者"))?;
        if planner.enabled == 0 {
            bail!(
                "计划者「{}」已停用，请先在会话设置里启用或换人",
                planner.name
            );
        }
        if self
            .live_runs
            .lock()
            .unwrap()
            .values()
            .any(|r| r.kind == "plan" && r.room_id == room_id)
        {
            bail!("计划正在生成，请等待或先点停止");
        }
        let flow = safe_json(&room.flow_json, default_flow());
        let decisions = self.store.active_decisions(room_id)?;
        let prompt = build_plan_prompt(&room, &members, &flow, &decisions);
        let run_id = uid("run");
        self.store.emit(
            Some(room_id),
            None,
            Some(&run_id),
            "plan.started",
            json!({ "planner": planner.name, "worker": planner.worker }),
        );
        let pid = Arc::new(Mutex::new(None));
        let cancelled = Arc::new(AtomicBool::new(false));
        self.live_runs.lock().unwrap().insert(
            run_id.clone(),
            LiveRun {
                kind: "plan".into(),
                room_id: room_id.to_string(),
                task_id: None,
                pid: pid.clone(),
                cancelled: cancelled.clone(),
            },
        );
        (room, planner, members, flow, prompt, run_id, pid, cancelled)
        };
        let _activity = PlanActivity { token: run_id.clone(), live_runs: self.live_runs.clone() };
        let res = run_worker(WorkerOpts {
            store: self.store.clone(),
            worker: planner.worker.clone(),
            model: planner.model.clone(),
            auto_approve: false,
            cwd: room.repo_path.clone(),
            prompt,
            run_id: run_id.clone(),
            room_id: Some(room_id.to_string()),
            task_id: None,
            actor: Some(json!({ "name": planner.name, "worker": planner.worker, "kind": "plan" })),
            timeout: Duration::from_secs(600),
            pid_slot: pid,
            cancel: cancelled.clone(),
        })
        .await;
        if cancelled.load(Ordering::SeqCst) {
            self.store.emit(
                Some(room_id),
                None,
                Some(&run_id),
                "plan.cancelled",
                json!({}),
            );
            bail!("计划生成已取消");
        }
        let res = res?;
        let draft = extract_json(&res.text).filter(|plan| {
            plan.is_object() && plan.get("tasks").and_then(Value::as_array).is_some()
        });
        let Some(draft) = draft else {
            self.store.emit(
                Some(room_id),
                None,
                Some(&run_id),
                "plan.failed",
                json!({ "error": res.error, "raw": res.text.chars().take(2000).collect::<String>() }),
            );
            bail!(
                "计划生成失败：{}\n{}",
                if res.error.is_empty() {
                    "模型没有返回合法 JSON"
                } else {
                    &res.error
                },
                res.text.chars().take(800).collect::<String>()
            );
        };
        let (plan, validation_errors) = match validate_plan(&draft, &members, &flow) {
            Ok(plan) => (plan, Vec::new()),
            Err(error) => {
                let mut draft = draft;
                if let Some(object) = draft.as_object_mut() {
                    object.insert("validationErrors".into(), json!(error.issues));
                }
                (draft, error.issues)
            }
        };
        {
            let conn = self.store.db.lock().unwrap();
            conn.execute(
                "UPDATE rooms SET plan_json=?, status=?, updated_at=? WHERE id=?",
                params![plan.to_string(), "planning", now(), room_id],
            )?;
        }
        self.store.emit(
            Some(room_id),
            None,
            Some(&run_id),
            "plan.ready",
            json!({
                "count": plan.get("tasks").and_then(Value::as_array).map(|a| a.len()).unwrap_or(0),
                "summary": plan.get("summary").and_then(Value::as_str).unwrap_or(""),
                "validationErrors": validation_errors,
            }),
        );
        Ok(plan)
    }

    pub fn apply_plan(&self, room_id: &str, plan: &Value) -> Result<Value> {
        let room = self
            .store
            .room(room_id)?
            .ok_or_else(|| anyhow::anyhow!("房间不存在"))?;
        if room.status == "archived" {
            bail!("会话已归档，请先恢复再修改计划");
        }
        let members = self.store.members(room_id)?;
        let flow = safe_json(&room.flow_json, default_flow());
        // Validation (including graph and member/phase references) must finish before
        // beginning a replacement transaction, so rejected drafts leave all records intact.
        let plan = validate_plan(plan, &members, &flow)?;

        let running = self.running.lock().unwrap();
        let active: i64 = {
            let conn = self.store.db.lock().unwrap();
            conn.query_row(
                "SELECT COUNT(*) FROM tasks WHERE room_id=? AND status='running'",
                params![room_id],
                |r| r.get(0),
            )?
        };
        if active > 0
            || running.values().any(|holder| holder.room_id == room_id)
            || self
                .task_operations
                .lock()
                .unwrap()
                .values()
                .any(|(_, holder)| holder.room_id == room_id)
        {
            bail!("还有任务正在准备、运行或收尾，不能覆盖计划");
        }
        let existing = self.store.tasks(room_id)?;
        let executed = existing.iter().any(|t| {
            !["backlog", "ready"].contains(&t.status.as_str())
                || !t.worktree.is_empty()
                || !t.branch.is_empty()
        });
        if executed {
            bail!("这个会话已经有执行记录，重新生成计划会覆盖它们。请新建会话，或先归档当前会话。");
        }
        let plan_tasks = plan
            .get("tasks")
            .and_then(Value::as_array)
            .expect("validated plans contain a tasks array");
        let phases = flow
            .get("nodes")
            .and_then(Value::as_array)
            .map(|nodes| {
                nodes
                    .iter()
                    .filter(|node| node.get("type").and_then(Value::as_str) == Some("phase"))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let ts = now();
        {
            let mut conn = self.store.db.lock().unwrap();
            let tx = conn.transaction()?;
            tx.execute("DELETE FROM tasks WHERE room_id=?", params![room_id])?;
            for (index, task) in plan_tasks.iter().enumerate() {
                let key = format!("T{}", index + 1);
                let owner_name = task
                    .get("owner")
                    .and_then(Value::as_str)
                    .expect("validated plans contain an owner");
                let owner = members
                    .iter()
                    .find(|member| member.name == owner_name)
                    .expect("validated plan owners belong to the room");
                // 只有计划里明确指定了阶段才绑定：门禁按阶段执行，不能拿任务顺序猜阶段。
                let phase = task
                    .get("phase")
                    .and_then(Value::as_str)
                    .and_then(|name| {
                        phases
                            .iter()
                            .find(|phase| phase.get("name").and_then(Value::as_str) == Some(name))
                    });
                let phase_id = phase.and_then(|phase| phase.get("id").and_then(Value::as_str));
                let deps = task
                    .get("dependsOn")
                    .and_then(Value::as_array)
                    .expect("validated plans contain a dependsOn array")
                    .iter()
                    .map(|dependency| {
                        format!(
                            "T{}",
                            dependency.as_u64().expect("validated positive integer")
                        )
                    })
                    .collect::<Vec<_>>();
                let status = if deps.is_empty() { "ready" } else { "backlog" };
                let id = uid("t");
                tx.execute(
                    "INSERT INTO tasks (id, room_id, key, title, spec, type, owner_id, phase_id, status, deps_json, acceptance_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    params![
                        id,
                        room_id,
                        key,
                        task.get("title").and_then(Value::as_str).expect("validated title"),
                        task.get("spec").and_then(Value::as_str).expect("normalized spec"),
                        task.get("type").and_then(Value::as_str).expect("normalized task type"),
                        owner.id,
                        phase_id,
                        status,
                        serde_json::to_string(&deps)?,
                        task.get("acceptance").expect("normalized acceptance").to_string(),
                        ts,
                        ts,
                    ],
                )?;
            }
            if let Some(decisions) = plan.get("decisions").and_then(Value::as_array) {
                for decision in decisions {
                    tx.execute(
                        "INSERT INTO decisions (id, room_id, text, rationale, status, created_at) VALUES (?,?,?,?,?,?)",
                        params![uid("d"), room_id, decision.as_str().expect("validated decision"), "", "active", ts],
                    )?;
                }
            }
            tx.execute(
                "UPDATE rooms SET plan_json='', status='planning', updated_at=? WHERE id=?",
                params![ts, room_id],
            )?;
            tx.commit()?;
        }
        self.store.emit(
            Some(room_id),
            None,
            None,
            "plan.applied",
            json!({ "count": plan_tasks.len() }),
        );
        Ok(self.room_state_sync(room_id)?.unwrap_or(Value::Null))
    }

    fn room_state_sync(&self, room_id: &str) -> Result<Option<Value>> {
        self.store.room_state(room_id, Vec::new())
    }

    pub async fn start_room(&self, room_id: &str) -> Result<Value> {
        {
            let _scheduling = self.running.lock().unwrap();
            let room = self
                .store
                .room(room_id)?
                .ok_or_else(|| anyhow::anyhow!("房间不存在"))?;
            if room.status == "archived" {
                bail!("会话已归档，请先恢复再执行");
            }
            {
                let conn = self.store.db.lock().unwrap();
                conn.execute(
                    "UPDATE rooms SET status=?, updated_at=? WHERE id=?",
                    params!["running", now(), room_id],
                )?;
            }
            self.refresh_ready(room_id)?;
            self.store
                .emit(Some(room_id), None, None, "room.started", json!({}));
        }
        let engine = self.clone();
        tokio::spawn(async move {
            engine.schedule().await;
        });
        Ok(self.room_state(room_id).await?.unwrap_or(Value::Null))
    }

    pub async fn pause_room(&self, room_id: &str) -> Result<()> {
        let _scheduling = self.running.lock().unwrap();
        let room = self
            .store
            .room(room_id)?
            .ok_or_else(|| anyhow::anyhow!("房间不存在"))?;
        if room.status == "archived" {
            bail!("会话已归档，请先恢复再操作");
        }
        {
            let conn = self.store.db.lock().unwrap();
            conn.execute(
                "UPDATE rooms SET status=?, updated_at=? WHERE id=?",
                params!["paused", now(), room_id],
            )?;
        }
        self.store
            .emit(Some(room_id), None, None, "room.paused", json!({}));
        Ok(())
    }

    fn running_rooms(&self) -> Vec<Room> {
        let conn = self.store.db.lock().unwrap();
        let mut stmt = match conn.prepare("SELECT * FROM rooms WHERE status='running'") {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        let rows = stmt.query_map([], Room::from_row);
        match rows {
            Ok(rows) => rows.flatten().collect(),
            Err(_) => Vec::new(),
        }
    }

    fn schedule_later(&self) {
        let engine = self.clone();
        tokio::spawn(async move {
            engine.schedule().await;
        });
    }

    // Callers hold the scheduling lock, making claims atomic with task startup.
    fn assert_task_available(
        &self,
        task_id: &str,
        running: &HashMap<String, RunHolder>,
    ) -> Result<()> {
        let operations = self.task_operations.lock().unwrap();
        let kind = if running.contains_key(task_id) {
            Some("run")
        } else {
            operations
                .get(task_id)
                .map(|(_, holder)| holder.kind.as_str())
        };
        if let Some(kind) = kind {
            let label = match kind {
                "run" => "运行或收尾",
                "review" => "评审",
                "merge" => "合并",
                "diff" => "读取成果",
                _ => "处理",
            };
            bail!("任务正在{}，请等待完成后刷新再操作", label);
        }
        Ok(())
    }

    fn claim_task_operation(
        &self,
        task_id: &str,
        kind: &str,
        statuses: &[&str],
    ) -> Result<(Task, Room, TaskOperation)> {
        let running = self.running.lock().unwrap();
        self.assert_task_available(task_id, &running)?;
        let task = self
            .store
            .task(task_id)?
            .ok_or_else(|| anyhow::anyhow!("任务不存在，请刷新会话后重试"))?;
        let room = self
            .store
            .room(&task.room_id)?
            .ok_or_else(|| anyhow::anyhow!("任务所属会话不存在，请刷新后重试"))?;
        if kind != "diff" && room.status == "archived" {
            bail!("会话已归档，请先恢复再操作");
        }
        if !statuses.is_empty() && !statuses.contains(&task.status.as_str()) {
            if kind == "review" {
                bail!("当前任务没有可自动评审的成功产出，请先完成运行；需人工状态请直接审阅 Diff 后决定");
            }
            bail!("当前任务没有可合并的成功产出，请先完成运行并查看最新 Diff");
        }
        let holder = LiveRun {
            kind: kind.into(),
            room_id: room.id.clone(),
            task_id: Some(task_id.into()),
            pid: Arc::new(Mutex::new(None)),
            cancelled: Arc::new(AtomicBool::new(false)),
        };
        let token = uid("run");
        self.task_operations
            .lock()
            .unwrap()
            .insert(task_id.into(), (token.clone(), holder.clone()));
        if kind == "review" {
            self.live_runs
                .lock()
                .unwrap()
                .insert(token.clone(), holder.clone());
        }
        let operation = TaskOperation {
            task_id: task_id.into(),
            token,
            holder,
            operations: self.task_operations.clone(),
            live_runs: self.live_runs.clone(),
        };
        Ok((task, room, operation))
    }

    fn assert_result_snapshot(
        &self,
        task: &Task,
        room: &Room,
        operation: Option<&TaskOperation>,
    ) -> Result<()> {
        if let Some(operation) = operation {
            if operation.holder.cancelled.load(Ordering::SeqCst) {
                bail!("操作已取消，请刷新任务后再操作");
            }
            if self
                .task_operations
                .lock()
                .unwrap()
                .get(&task.id)
                .map(|(token, _)| token)
                != Some(&operation.token)
            {
                return Err(stale_result());
            }
        }
        let latest = self.store.task(&task.id)?.ok_or_else(stale_result)?;
        let current_room = self.store.room(&room.id)?.ok_or_else(stale_result)?;
        if latest.status != task.status
            || latest.base_sha != task.base_sha
            || latest.branch != task.branch
            || latest.result_sha != task.result_sha
            || latest.worktree != task.worktree
            || current_room.repo_path != room.repo_path
            || current_room.base_branch != room.base_branch
        {
            return Err(stale_result());
        }
        Ok(())
    }

    async fn read_task_result(
        &self,
        task_id: &str,
        expected_sha: Option<&str>,
        operation: Option<&TaskOperation>,
    ) -> Result<TaskResult> {
        let mut task = self
            .store
            .task(task_id)?
            .ok_or_else(|| anyhow::anyhow!("任务不存在，请刷新会话后重试"))?;
        let room = self
            .store
            .room(&task.room_id)?
            .ok_or_else(|| anyhow::anyhow!("任务所属会话不存在，请刷新后重试"))?;
        let legacy = task.result_sha.is_empty();
        if legacy
            && (![
                "review",
                "approved",
                "changes_requested",
                "escalated",
                "merged",
                "done",
            ]
            .contains(&task.status.as_str())
                || task.branch.is_empty())
        {
            bail!("任务尚无成功产出，请先完成运行后再查看、评审或合并");
        }
        if task.base_sha.is_empty() {
            bail!("任务基准提交缺失，请重新运行任务后再查看成果");
        }
        let reference = if legacy {
            &task.branch
        } else {
            &task.result_sha
        };
        let sha = git::commit_sha(&room.repo_path, reference).await?;
        {
            let _scheduling = self.running.lock().unwrap();
            self.assert_result_snapshot(&task, &room, operation)?;
            if expected_sha
                .map(|expected| !expected.eq_ignore_ascii_case(&sha))
                .unwrap_or(false)
            {
                return Err(stale_result());
            }
            if legacy {
                self.store.db.lock().unwrap().execute(
                    "UPDATE tasks SET result_sha=?, updated_at=? WHERE id=?",
                    params![sha, now(), task_id],
                )?;
                task.result_sha = sha.clone();
                self.store.emit(
                    Some(&room.id),
                    Some(task_id),
                    None,
                    "task.result",
                    json!({ "resultSha": sha }),
                );
            }
        }
        let diff = git::diff_commit(&room.repo_path, &task.base_sha, &sha).await?;
        {
            let _scheduling = self.running.lock().unwrap();
            self.assert_result_snapshot(&task, &room, operation)?;
        }
        Ok(TaskResult {
            task,
            room,
            sha,
            diff,
        })
    }
    fn task_start_context(
        &self,
        task_id: &str,
        automatic: bool,
        reserved: bool,
        running: &HashMap<String, RunHolder>,
    ) -> Result<TaskStartContext> {
        if !reserved {
            self.assert_task_available(task_id, running)?;
        }
        let blocked = |message: String| anyhow::Error::new(TaskStartBlocked(message));
        let task = self
            .store
            .task(task_id)?
            .ok_or_else(|| blocked("任务不存在，请刷新会话后重试".into()))?;
        let room = self
            .store
            .room(&task.room_id)?
            .ok_or_else(|| blocked("任务所属会话不存在，请刷新后重新选择任务".into()))?;
        if room.status == "archived" {
            return Err(blocked("会话已归档，请先恢复会话再运行任务".into()));
        }
        if automatic && room.status != "running" {
            return Err(blocked(
                "会话尚未开始或已暂停，请开始执行会话，或手动运行该任务".into(),
            ));
        }
        let startable = [
            "backlog",
            "ready",
            "failed",
            "cancelled",
            "changes_requested",
            "escalated",
        ];
        if if reserved {
            task.status != "running"
        } else {
            !startable.contains(&task.status.as_str())
        } {
            let message = match task.status.as_str() {
                "merged" | "done" => "任务已经完成，不能重复运行；后续需求请新建任务",
                "running" => "任务仍记录为运行中，请先取消该任务，再重试运行",
                _ => "当前任务状态不能运行，请先打回任务再按意见重跑，或继续评审、合并",
            };
            return Err(blocked(message.into()));
        }
        if automatic && !reserved && task.status != "ready" {
            return Err(blocked("任务尚未就绪，请先完成上游依赖".into()));
        }
        let member = task
            .owner_id
            .as_deref()
            .map(|id| self.store.member(id))
            .transpose()?
            .flatten()
            .ok_or_else(|| blocked("任务没有有效负责人，请在计划中分配会话成员后再运行".into()))?;
        if member.room_id != room.id {
            return Err(blocked(
                "任务负责人不属于当前会话，请在计划中重新分配负责人".into(),
            ));
        }
        if member.enabled == 0 {
            return Err(blocked(format!(
                "负责人「{}」已停用，请在会话设置中启用或更换负责人",
                member.name
            )));
        }
        if !is_worker(&member.worker) {
            return Err(blocked(format!(
                "负责人「{}」的 CLI 无效，请在会话设置中重新选择 CLI",
                member.name
            )));
        }
        if self
            .live_runs
            .lock()
            .unwrap()
            .values()
            .any(|run| run.kind == "review" && run.task_id.as_deref() == Some(task_id))
        {
            return Err(blocked(
                "这个任务正在评审，请等待评审结束，或先在会话顶部停止评审".into(),
            ));
        }
        let deps: Vec<String> = serde_json::from_str(&task.deps_json).map_err(|_| {
            blocked("任务依赖格式无效，请重新确认计划，或新建依赖配置正确的任务".into())
        })?;
        let tasks = self.store.tasks(&room.id)?;
        let by_key: HashMap<_, _> = tasks.iter().map(|task| (task.key.as_str(), task)).collect();
        let mut upstream = Vec::new();
        for key in deps {
            let dependency = by_key
                .get(key.as_str())
                .filter(|dependency| dependency.id != task.id)
                .ok_or_else(|| {
                    blocked(format!(
                        "依赖 {} 无效，请重新确认计划，或新建依赖配置正确的任务",
                        key
                    ))
                })?;
            if !["merged", "done"].contains(&dependency.status.as_str()) {
                return Err(blocked(format!(
                    "依赖 {} 尚未完成，请先完成上游任务；有代码改动时还需合并，再运行当前任务",
                    key
                )));
            }
            upstream.push((*dependency).clone());
        }
        let occupied = running
            .iter()
            .filter(|(id, _)| !reserved || id.as_str() != task_id)
            .map(|(_, holder)| holder)
            .collect::<Vec<_>>();
        if occupied.len() >= GLOBAL_LIMIT {
            return Err(blocked(format!(
                "全局 {} 个执行名额已满，请等待其他任务结束后再运行",
                GLOBAL_LIMIT
            )));
        }
        let room_limit = if room.mode == "serial" { 1 } else { ROOM_LIMIT };
        if occupied
            .iter()
            .filter(|holder| holder.room_id == room.id)
            .count()
            >= room_limit
        {
            return Err(blocked(format!(
                "当前会话的 {} 个执行名额已满，请等待会话内任务结束后再运行",
                room_limit
            )));
        }
        if occupied
            .iter()
            .filter(|holder| holder.member_id == member.id)
            .count()
            >= member.concurrency.max(1) as usize
        {
            return Err(blocked(format!(
                "负责人「{}」的并发已满，请等待其任务结束，或在会话设置中提高并发",
                member.name
            )));
        }
        Ok(TaskStartContext {
            task,
            room,
            member,
            upstream,
        })
    }

    fn reserve_task(&self, task_id: &str, automatic: bool) -> Result<Option<TaskReservation>> {
        let mut running = self.running.lock().unwrap();
        if running.contains_key(task_id) {
            return Ok(None);
        }
        let initial = self.task_start_context(task_id, automatic, false, &running)?;
        let holder = RunHolder {
            room_id: initial.room.id.clone(),
            member_id: initial.member.id.clone(),
            run_id: uid("run"),
            phase: "starting".into(),
            pid: Arc::new(Mutex::new(None)),
            cancelled: Arc::new(AtomicBool::new(false)),
        };
        // The DB transition and reservation happen before worktree preparation or spawn.
        {
            let mut conn = self.store.db.lock().unwrap();
            let tx = conn.transaction()?;
            tx.execute(
                "INSERT INTO runs (id, task_id, member_id, status, log_path, started_at, flow_json) VALUES (?,?,?,?,?,?,?)",
                params![holder.run_id, task_id, initial.member.id, "running", "", now(), initial.room.flow_json],
            )?;
            // 升级后由人点「按意见重跑」是明确再给一轮机会：打回计数从 0 重新开始。
            if initial.task.status == "escalated" {
                tx.execute(
                    "UPDATE tasks SET status='running', summary='', diff_stat='', reject_count=0, updated_at=? WHERE id=?",
                    params![now(), task_id],
                )?;
            } else {
                tx.execute(
                    "UPDATE tasks SET status='running', summary='', diff_stat='', updated_at=? WHERE id=?",
                    params![now(), task_id],
                )?;
            }
            tx.commit()?;
        }
        running.insert(task_id.to_string(), holder.clone());
        self.store.emit(
            Some(&initial.room.id),
            Some(task_id),
            None,
            "task.status",
            json!({ "status": "running", "key": initial.task.key, "title": initial.task.title }),
        );
        self.store.emit(Some(&initial.room.id), Some(task_id), Some(&holder.run_id), "task.started",
            json!({ "member": initial.member.name, "worker": initial.member.worker, "key": initial.task.key, "phase": "starting" }));
        Ok(Some(TaskReservation {
            initial,
            holder,
            automatic,
        }))
    }

    pub async fn schedule(&self) {
        for room in self.running_rooms() {
            let tasks = self.store.tasks(&room.id).unwrap_or_default();
            for task in tasks.into_iter().filter(|task| task.status == "ready") {
                // All schedulers and manual runs reserve under the same lock. A blocked
                // task stays queued; actual execution failures are finalized separately.
                if let Ok(Some(reservation)) = self.reserve_task(&task.id, true) {
                    let engine = self.clone();
                    tokio::spawn(async move {
                        let _ = engine.execute_reserved_task(&task.id, reservation).await;
                    });
                }
            }
        }
    }

    async fn ensure_worktree(&self, task: &Task, room: &Room) -> Result<String> {
        if !task.worktree.is_empty() && std::path::Path::new(&task.worktree).join(".git").exists() {
            return Ok(task.worktree.clone());
        }
        let configured = room.base_branch.clone();
        let mut base = if configured.is_empty() {
            git::current_branch(&room.repo_path).await
        } else {
            configured.clone()
        };
        let sha = match git::rev_parse(&room.repo_path, &base).await {
            Ok(sha) => sha,
            Err(_) => {
                // 旧会话可能记着已经不存在或改名的基准分支（例如仓库从 main 改成 master）。
                let detected = git::current_branch(&room.repo_path).await;
                if detected.is_empty() || detected == base {
                    return Err(BaseBranchError(format!(
                        "无法确定基准分支：会话记录的是「{}」，仓库当前分支是「{}」。请确认仓库已有提交，或新建会话重新选择项目",
                        base,
                        if detected.is_empty() { "未知" } else { detected.as_str() }
                    ))
                    .into());
                }
                let fallback = match git::rev_parse(&room.repo_path, &detected).await {
                    Ok(sha) => sha,
                    Err(_) => {
                        return Err(BaseBranchError(format!(
                            "无法确定基准分支：会话记录的是「{}」，仓库当前分支「{}」也无法解析。请确认仓库已有提交",
                            base, detected
                        ))
                        .into())
                    }
                };
                {
                    let conn = self.store.db.lock().unwrap();
                    conn.execute(
                        "UPDATE rooms SET base_branch=?, updated_at=? WHERE id=?",
                        params![&detected, now(), &room.id],
                    )?;
                }
                let previous = base.clone();
                self.store.emit(
                    Some(&room.id),
                    Some(&task.id),
                    None,
                    "room.updated",
                    json!({
                        "keys": ["base_branch"], "baseBranch": &detected, "previous": &previous,
                    }),
                );
                base = detected;
                fallback
            }
        };
        let wt = self.store.worktrees.join(&room.id).join(&task.id);
        let wt_s = wt.to_string_lossy().to_string();
        let suffix = if task.id.len() > 6 {
            &task.id[task.id.len() - 6..]
        } else {
            &task.id
        };
        let branch = format!("devhub/{}/{}-{}", room.id, task.key, suffix);
        git::add_worktree(&room.repo_path, &wt_s, &branch, &sha).await?;
        {
            let conn = self.store.db.lock().unwrap();
            conn.execute(
                "UPDATE tasks SET worktree=?, branch=?, base_sha=?, updated_at=? WHERE id=?",
                params![wt_s, branch, sha, now(), task.id],
            )?;
        }
        self.store.emit(
            Some(&room.id),
            Some(&task.id),
            None,
            "task.worktree",
            json!({ "path": wt_s, "branch": branch }),
        );
        Ok(wt_s)
    }

    pub async fn start_task(&self, task_id: &str) -> Result<Value> {
        let Some(reservation) = self.reserve_task(task_id, false)? else {
            return Ok(json!({ "ok": true, "already": true }));
        };
        // A disconnected HTTP caller must not abandon a live reservation or child.
        let engine = self.clone();
        let task_id = task_id.to_string();
        tokio::spawn(async move { engine.execute_reserved_task(&task_id, reservation).await })
            .await
            .map_err(|error| anyhow::anyhow!("任务执行调度中断：{}", error))?
    }

    fn reservation_is_current(
        &self,
        task_id: &str,
        reservation: &TaskReservation,
        running: &HashMap<String, RunHolder>,
    ) -> Result<bool> {
        Ok(!reservation.holder.cancelled.load(Ordering::SeqCst)
            && running.get(task_id).map(|holder| holder.run_id.as_str())
                == Some(reservation.holder.run_id.as_str())
            && self.store.task(task_id)?.map(|task| task.status) == Some("running".into()))
    }

    fn advance_task_phase(
        &self,
        task_id: &str,
        reservation: &TaskReservation,
        phase: &str,
    ) -> Result<bool> {
        let mut running = self.running.lock().unwrap();
        if !self.reservation_is_current(task_id, reservation, &running)? {
            return Ok(false);
        }
        let holder = running.get_mut(task_id).expect("current reservation");
        holder.phase = phase.to_string();
        self.store.emit(
            Some(&holder.room_id),
            Some(task_id),
            Some(&holder.run_id),
            "task.phase",
            json!({ "phase": phase }),
        );
        Ok(true)
    }

    async fn run_reserved_task(
        &self,
        task_id: &str,
        reservation: &TaskReservation,
        result: &mut Option<WorkerResult>,
    ) -> Result<Option<(bool, String, String)>> {
        let initial = &reservation.initial;
        let wt = self.ensure_worktree(&initial.task, &initial.room).await?;
        let current = {
            let mut running = self.running.lock().unwrap();
            if !self.reservation_is_current(task_id, reservation, &running)? {
                return Ok(None);
            }
            // Recheck pause, membership, dependencies and quotas after asynchronous Git
            // preparation. A business rejection restores the queue in finalization.
            let current =
                self.task_start_context(task_id, reservation.automatic, true, &running)?;
            if current.task.base_sha.is_empty() {
                bail!("无法确定任务基准提交（base_sha 为空）");
            }
            let holder = running.get_mut(task_id).expect("current reservation");
            holder.member_id = current.member.id.clone();
            holder.phase = "running".into();
            self.store.emit(
                Some(&holder.room_id),
                Some(task_id),
                Some(&holder.run_id),
                "task.phase",
                json!({ "phase": "running" }),
            );
            current
        };
        let decisions = self.store.active_decisions(&current.room.id)?;
        let prompt = build_task_prompt(
            &current.room,
            &current.task,
            &current.member,
            &decisions,
            &current.upstream,
            &current.task.feedback,
            &wt,
        );
        *result = Some(run_worker(WorkerOpts {
            store: self.store.clone(),
            worker: current.member.worker.clone(),
            model: current.member.model.clone(),
            auto_approve: current.room.auto_approve != 0,
            cwd: wt.clone(),
            prompt,
            run_id: reservation.holder.run_id.clone(),
            room_id: Some(current.room.id.clone()),
            task_id: Some(task_id.to_string()),
            actor: Some(json!({ "name": current.member.name, "worker": current.member.worker, "kind": "task" })),
            timeout: Duration::from_secs(if current.task.task_type == "code" { 1800 } else { 1200 }),
            pid_slot: reservation.holder.pid.clone(),
            cancel: reservation.holder.cancelled.clone(),
        }).await?);
        *reservation.holder.pid.lock().unwrap() = None;
        if !self.advance_task_phase(task_id, reservation, "collecting")? {
            return Ok(None);
        }
        // These Git operations must throw. An unreadable status/diff is not a
        // successful run with no changes, and collection still occupies its slot.
        let changes = git::git(&wt, &["status", "--porcelain"]).await?.0;
        if !self.reservation_is_current(task_id, reservation, &self.running.lock().unwrap())? {
            return Ok(None);
        }
        let committed = if changes.trim().is_empty() {
            false
        } else {
            git::git(&wt, &["add", "-A"]).await?;
            if !self.reservation_is_current(task_id, reservation, &self.running.lock().unwrap())? {
                return Ok(None);
            }
            git::git(
                &wt,
                &[
                    "-c",
                    "user.name=DevHub",
                    "-c",
                    "user.email=devhub@local",
                    "commit",
                    "-m",
                    &format!("devhub({}): {}", current.task.key, current.task.title),
                    "--no-verify",
                ],
            )
            .await?;
            true
        };
        if !self.reservation_is_current(task_id, reservation, &self.running.lock().unwrap())? {
            return Ok(None);
        }
        let result_sha = git::commit_sha(&wt, "HEAD").await?;
        if !self.reservation_is_current(task_id, reservation, &self.running.lock().unwrap())? {
            return Ok(None);
        }
        let stat = git::git(
            &wt,
            &["diff", "--stat", &current.task.base_sha, &result_sha],
        )
        .await?
        .0;
        Ok(Some((committed, stat, result_sha)))
    }

    async fn execute_reserved_task(
        &self,
        task_id: &str,
        reservation: TaskReservation,
    ) -> Result<Value> {
        let mut worker_result = None;
        let outcome = self
            .run_reserved_task(task_id, &reservation, &mut worker_result)
            .await;
        *reservation.holder.pid.lock().unwrap() = None;
        let finalized = {
            let mut running = self.running.lock().unwrap();
            let finalized = self.finalize_reserved_task(
                task_id,
                &reservation,
                outcome,
                worker_result.as_ref(),
                &running,
            );
            // Cleanup happens even when finalization returns a database or Git error.
            if running.get(task_id).map(|holder| &holder.run_id) == Some(&reservation.holder.run_id)
            {
                running.remove(task_id);
            }
            finalized
        };
        let completed = self.maybe_complete_room(&reservation.initial.room.id);
        self.schedule_later();
        completed?;
        finalized
    }

    fn finalize_reserved_task(
        &self,
        task_id: &str,
        reservation: &TaskReservation,
        outcome: Result<Option<(bool, String, String)>>,
        result: Option<&WorkerResult>,
        running: &HashMap<String, RunHolder>,
    ) -> Result<Value> {
        let holder = &reservation.holder;
        let latest = self.store.task(task_id)?;
        if holder.cancelled.load(Ordering::SeqCst)
            || latest.as_ref().map(|task| task.status.as_str()) == Some("cancelled")
        {
            if latest.as_ref().map(|task| task.status.as_str()) != Some("cancelled") {
                self.set_status(task_id, "cancelled", &[])?;
            }
            self.update_run(&holder.run_id, "cancelled", result, "已取消")?;
            return Ok(json!({ "ok": false, "cancelled": true }));
        }
        if !self.reservation_is_current(task_id, reservation, running)? {
            self.update_run(
                &holder.run_id,
                "cancelled",
                result,
                "任务状态已变化，未采用旧运行结果",
            )?;
            return Ok(json!({ "ok": false, "interrupted": true }));
        }
        let (committed, stat, result_sha) = match outcome {
            Err(error) if error.is::<TaskStartBlocked>() => {
                let initial = &reservation.initial.task;
                self.set_status(
                    task_id,
                    &initial.status,
                    &[
                        ("summary", initial.summary.clone()),
                        ("diff_stat", initial.diff_stat.clone()),
                        ("result_sha", initial.result_sha.clone()),
                        ("reject_count", initial.reject_count.to_string()),
                    ],
                )?;
                self.update_run(&holder.run_id, "cancelled", result, &error.to_string())?;
                self.store.emit(
                    Some(&holder.room_id),
                    Some(task_id),
                    Some(&holder.run_id),
                    "task.deferred",
                    json!({ "reason": error.to_string() }),
                );
                return Err(error);
            }
            Err(error) => {
                let phase = running
                    .get(task_id)
                    .map(|holder| holder.phase.as_str())
                    .unwrap_or("starting");
                let action = match phase {
                    "starting" => "准备工作区失败，请检查仓库路径和基准分支后重试",
                    "collecting" => "收集改动失败，请检查工作区和 Git 错误后重试",
                    _ => "启动或执行失败，请检查 CLI 配置和日志后重试",
                };
                let message = if error.downcast_ref::<BaseBranchError>().is_some() {
                    error.to_string()
                } else {
                    format!("{}：{}", action, error)
                };
                self.update_run(&holder.run_id, "failed", result, &message)?;
                self.set_status(task_id, "failed", &[("summary", message.clone())])?;
                self.store.emit(
                    Some(&holder.room_id),
                    Some(task_id),
                    Some(&holder.run_id),
                    "task.error",
                    json!({ "error": message }),
                );
                bail!(message);
            }
            Ok(Some(collected)) => collected,
            Ok(None) => {
                self.update_run(
                    &holder.run_id,
                    "cancelled",
                    result,
                    "任务状态已变化，未采用旧运行结果",
                )?;
                return Ok(json!({ "ok": false, "interrupted": true }));
            }
        };
        let res = result.ok_or_else(|| anyhow::anyhow!("worker 没有返回执行结果"))?;
        let failed = res.code != 0;
        let no_change = !failed && stat.trim().is_empty();
        // 门禁决定这次产出要谁来确认：auto 有产出即通过，agent 等评审，human 等用户点通过。
        let room = self.store.room(&holder.room_id)?;
        let gate = task_gate(room.as_ref(), latest.as_ref());
        let reject_count = latest.as_ref().map(|task| task.reject_count).unwrap_or(0);
        let next_status = if failed {
            "failed"
        } else if no_change {
            "done"
        } else if gate.gate == "auto" {
            "approved"
        } else {
            "review"
        };
        let summary = if !res.text.trim().is_empty() {
            res.text.trim().to_string()
        } else if !res.error.is_empty() {
            format!("执行失败：{}", res.error)
        } else {
            "（没有文本输出）".to_string()
        };
        self.update_run(
            &holder.run_id,
            if failed { "failed" } else { "completed" },
            Some(res),
            &res.error,
        )?;
        self.set_status(
            task_id,
            next_status,
            &[
                ("summary", summary.chars().take(20000).collect()),
                ("diff_stat", stat.clone()),
                (
                    "result_sha",
                    if failed {
                        reservation.initial.task.result_sha.clone()
                    } else {
                        result_sha.clone()
                    },
                ),
            ],
        )?;
        self.store.emit(
            Some(&holder.room_id),
            Some(task_id),
            Some(&holder.run_id),
            if failed {
                "task.failed"
            } else {
                "task.finished"
            },
            json!({
                "code": res.code, "summary": summary.chars().take(4000).collect::<String>(),
                "stat": stat, "committed": committed, "noChange": no_change, "status": next_status,
                "resultSha": if failed { &reservation.initial.task.result_sha } else { &result_sha },
                "session": res.session, "cost": res.cost, "usage": res.usage,
                "gate": gate.gate.as_str(), "maxLoop": gate.max_loop, "rejectCount": reject_count,
            }),
        );
        if !failed && !no_change {
            if gate.gate == "auto" {
                self.store.emit(
                    Some(&holder.room_id),
                    Some(task_id),
                    Some(&holder.run_id),
                    "gate.passed",
                    json!({
                        "gate": "auto", "resultSha": &result_sha, "checks": ["diff"],
                        "maxLoop": gate.max_loop, "rejectCount": reject_count,
                    }),
                );
            } else {
                self.store.emit(
                    Some(&holder.room_id),
                    Some(task_id),
                    Some(&holder.run_id),
                    "gate.waiting",
                    json!({
                        "gate": gate.gate.as_str(), "maxLoop": gate.max_loop,
                        "rejectCount": reject_count, "resultSha": &result_sha,
                    }),
                );
            }
        }
        self.refresh_ready(&holder.room_id)?;
        Ok(json!({ "ok": !failed, "code": res.code }))
    }

    fn update_run(
        &self,
        run_id: &str,
        status: &str,
        res: Option<&WorkerResult>,
        error: &str,
    ) -> Result<()> {
        let conn = self.store.db.lock().unwrap();
        conn.execute(
            "UPDATE runs SET status=?, session_id=?, exit_code=?, error=?, log_path=?, ended_at=? WHERE id=?",
            params![status, res.map(|res| res.session.as_str()).unwrap_or(""), res.map(|res| res.code),
                error, res.map(|res| res.log_path.as_str()).unwrap_or(""), now(), run_id],
        )?;
        Ok(())
    }
    pub async fn review_task(&self, task_id: &str) -> Result<Value> {
        self.review_task_result(task_id, None).await
    }

    /// 门禁不是「评审」的阶段不需要再跑评审进程：人工门禁等用户点通过，自动门禁已经通过。
    /// 打回次数达到阶段上限时也直接转人工决定。调用方已占用任务操作，这里同步抛错，
    /// 错误文案才不会被包成「自动评审失败」。
    fn assert_review_gate(&self, task_id: &str) -> Result<()> {
        let Some(task) = self.store.task(task_id)? else {
            return Ok(());
        };
        let Some(room) = self.store.room(&task.room_id)? else {
            return Ok(());
        };
        let gate = task_gate(Some(&room), Some(&task));
        if gate.gate == "human" {
            bail!("这个阶段的门禁是人工确认，请点「通过」或「退回修改」，不需要自动评审");
        }
        if gate.gate == "auto" {
            bail!("这个阶段的门禁是自动通过，有产出就已经通过，不需要自动评审");
        }
        let reject_count = task.reject_count.max(0);
        if reject_count >= gate.max_loop {
            bail!(
                "这个任务已经打回 {} 次，达到本阶段上限，请人工决定：按意见重跑、人工通过或取消",
                gate.max_loop
            );
        }
        Ok(())
    }

    pub async fn review_task_result(
        &self,
        task_id: &str,
        expected_sha: Option<String>,
    ) -> Result<Value> {
        let (_, _, operation) = self.claim_task_operation(
            task_id,
            "review",
            &["review", "approved", "changes_requested"],
        )?;
        // 门禁守卫在占用操作之后同步执行，既不会被并发打回改变计数，也保持原文案。
        self.assert_review_gate(task_id)?;
        let engine = self.clone();
        let task_id = task_id.to_string();
        tokio::spawn(async move {
            let run_id = operation.token.clone();
            let result = engine
                .execute_review(&task_id, expected_sha.as_deref(), &operation, &run_id)
                .await;
            let result = result.map_err(|error| {
                let cancelled = operation.holder.cancelled.load(Ordering::SeqCst);
                let message = if cancelled {
                    "评审已取消，未采用评审结论".into()
                } else {
                    format!("自动评审失败：{}", error)
                };
                engine.store.emit(
                    Some(&operation.holder.room_id),
                    Some(&task_id),
                    Some(&run_id),
                    if cancelled {
                        "review.cancelled"
                    } else {
                        "review.failed"
                    },
                    json!({ "error": message }),
                );
                error.context(message)
            });
            engine.live_runs.lock().unwrap().remove(&run_id);
            let room_id = operation.holder.room_id.clone();
            drop(operation);
            let _ = engine.maybe_complete_room(&room_id);
            engine.schedule_later();
            result
        })
        .await
        .map_err(|error| anyhow::anyhow!("评审调度中断：{}", error))?
    }

    async fn execute_review(
        &self,
        task_id: &str,
        expected_sha: Option<&str>,
        operation: &TaskOperation,
        run_id: &str,
    ) -> Result<Value> {
        let task = self.store.task(task_id)?.ok_or_else(stale_result)?;
        let room = self.store.room(&task.room_id)?.ok_or_else(stale_result)?;
        let gate = task_gate(Some(&room), Some(&task));
        let members = self.store.members(&room.id)?;
        let reviewer = members
            .iter()
            .find(|member| Some(&member.id) == room.reviewer_id.as_ref())
            .or_else(|| members.last())
            .filter(|member| member.enabled != 0)
            .ok_or_else(|| anyhow::anyhow!("没有启用的评审者，请在会话设置中启用或更换评审者"))?;
        if !is_worker(&reviewer.worker) {
            bail!("评审者 CLI 无效，请在会话设置中重新选择 CLI");
        }
        let reviewed = self.store.review_count(task_id)?;
        let reject_count = task.reject_count.max(0);
        self.store.emit(
            Some(&room.id),
            Some(task_id),
            Some(run_id),
            "review.started",
            json!({ "reviewer": reviewer.name, "worker": reviewer.worker, "key": task.key }),
        );
        let frozen = self
            .read_task_result(task_id, expected_sha, Some(operation))
            .await?;
        if frozen.diff.is_empty() {
            bail!("固定成果没有可评审的改动，请刷新 Diff 后确认是否需要重跑");
        }
        let dirty = git::tracked_status_checked(&task.worktree).await?;
        let head = git::commit_sha(&task.worktree, "HEAD").await?;
        self.assert_result_snapshot(&frozen.task, &room, Some(operation))?;
        if !dirty.is_empty() || head != frozen.sha {
            return Err(ResultConflict("评审工作区已偏离固定成果，请先保留并处理工作区中的改动，重跑任务或恢复到已展示的提交后重试".into()).into());
        }
        let acceptance: Vec<String> =
            serde_json::from_str(&task.acceptance_json).unwrap_or_default();
        let prompt = build_review_prompt(
            &room,
            &frozen.task,
            reviewer,
            &frozen.diff,
            &acceptance,
            &task.worktree,
        );
        let res = run_worker(WorkerOpts {
            store: self.store.clone(),
            worker: reviewer.worker.clone(),
            model: reviewer.model.clone(),
            auto_approve: false,
            cwd: task.worktree.clone(),
            prompt,
            run_id: run_id.into(),
            room_id: Some(room.id.clone()),
            task_id: Some(task_id.into()),
            actor: Some(
                json!({ "name": reviewer.name, "worker": reviewer.worker, "kind": "review" }),
            ),
            timeout: Duration::from_secs(480),
            pid_slot: operation.holder.pid.clone(),
            cancel: operation.holder.cancelled.clone(),
        })
        .await?;
        *operation.holder.pid.lock().unwrap() = None;
        if operation.holder.cancelled.load(Ordering::SeqCst) {
            bail!("评审已取消");
        }
        if res.code != 0 {
            bail!(
                "评审进程未成功结束（{}）：{}",
                res.code,
                if res.error.is_empty() {
                    "请检查 CLI 日志后重试，或人工审阅 Diff 后合并"
                } else {
                    &res.error
                }
            );
        }
        let dirty = git::tracked_status_checked(&task.worktree).await?;
        let head = git::commit_sha(&task.worktree, "HEAD").await?;
        if !dirty.is_empty() || head != frozen.sha {
            bail!("评审过程中修改了已跟踪文件或提交，结果不能采用；请保留并处理这些改动后重试，或人工审阅固定 Diff");
        }
        let mut verdict = extract_json(&res.text)
            .filter(|verdict| {
                verdict.is_object()
                    && matches!(
                        verdict.get("verdict").and_then(Value::as_str),
                        Some("approve" | "request_changes")
                    )
                    && verdict
                        .get("blocking")
                        .map(|blocking| {
                            blocking
                                .as_array()
                                .map(|items| items.iter().all(Value::is_object))
                                .unwrap_or(false)
                        })
                        .unwrap_or(true)
            })
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "评审没有返回合法结论，请检查评审角色约束后重试，或人工审阅 Diff 后合并"
                )
            })?;
        if verdict.get("blocking").is_none() {
            verdict["blocking"] = json!([]);
        }
        verdict["resultSha"] = json!(frozen.sha);
        let blocking = verdict["blocking"]
            .as_array()
            .expect("validated blocking array");
        let approve = verdict["verdict"] == "approve";
        if approve && !blocking.is_empty() {
            bail!("评审同时返回通过和阻塞问题，请人工审阅 Diff 后决定");
        }
        let round = reviewed + 1;
        let next_reject_count = if approve { reject_count } else { reject_count + 1 };
        let next_status = if approve {
            "approved"
        } else if next_reject_count >= gate.max_loop {
            "escalated"
        } else {
            "changes_requested"
        };
        let feedback = if approve {
            task.feedback.clone()
        } else {
            let lines = blocking
                .iter()
                .map(|item| {
                    format!(
                        "- {}:{} {} → {}",
                        item.get("file").and_then(Value::as_str).unwrap_or("?"),
                        item.get("line")
                            .map(Value::to_string)
                            .unwrap_or_else(|| "?".into()),
                        item.get("issue").and_then(Value::as_str).unwrap_or(""),
                        item.get("suggestion").and_then(Value::as_str).unwrap_or(""),
                    )
                })
                .collect::<Vec<_>>()
                .join("\n");
            let detail = if lines.is_empty() {
                verdict
                    .get("notes")
                    .and_then(Value::as_str)
                    .unwrap_or("需要修改")
            } else {
                &lines
            };
            format!(
                "{}{}第 {} 轮评审：\n{}",
                task.feedback,
                if task.feedback.is_empty() { "" } else { "\n\n" },
                round,
                detail
            )
            .chars()
            .take(20000)
            .collect()
        };
        {
            let _scheduling = self.running.lock().unwrap();
            self.assert_result_snapshot(&frozen.task, &room, Some(operation))?;
            let mut conn = self.store.db.lock().unwrap();
            let tx = conn.transaction()?;
            tx.execute("INSERT INTO reviews (id, task_id, round, verdict, payload, created_at) VALUES (?,?,?,?,?,?)",
                params![uid("rv"), task_id, round, verdict["verdict"].as_str(), verdict.to_string(), now()])?;
            tx.execute(
                "UPDATE tasks SET status=?, feedback=?, reject_count=?, updated_at=? WHERE id=?",
                params![next_status, feedback, next_reject_count, now(), task_id],
            )?;
            tx.commit()?;
            drop(conn);
            self.store.emit(
                Some(&room.id),
                Some(task_id),
                None,
                "task.status",
                json!({ "status": next_status, "key": task.key, "title": task.title }),
            );
            self.store.emit(Some(&room.id), Some(task_id), Some(run_id), "review.done", json!({
                "verdict": verdict["verdict"], "round": round, "escalated": next_status == "escalated",
                "notes": verdict.get("notes").and_then(Value::as_str).unwrap_or(""), "resultSha": frozen.sha,
                "maxLoop": gate.max_loop, "rejectCount": next_reject_count,
            }));
            if next_status == "escalated" {
                self.store.emit(Some(&room.id), Some(task_id), Some(run_id), "gate.escalated", json!({
                    "gate": gate.gate.as_str(), "by": "agent",
                    "maxLoop": gate.max_loop, "rejectCount": next_reject_count, "round": round,
                }));
            }
        }
        Ok(json!({ "verdict": verdict, "round": round, "resultSha": frozen.sha }))
    }
    pub fn reject_task(&self, task_id: &str, note: &str) -> Result<()> {
        let running = self.running.lock().unwrap();
        self.assert_task_available(task_id, &running)?;
        let task = self
            .store
            .task(task_id)?
            .ok_or_else(|| anyhow::anyhow!("任务不存在"))?;
        if !["review", "approved", "escalated"].contains(&task.status.as_str()) {
            bail!("当前状态不能打回，请刷新任务后选择运行、评审或新建任务");
        }
        let room = self.store.room(&task.room_id)?;
        if room
            .as_ref()
            .map(|room| room.status == "archived")
            .unwrap_or(false)
        {
            bail!("会话已归档，请先恢复再操作");
        }
        let gate = task_gate(room.as_ref(), Some(&task));
        let old = if task.feedback.is_empty() {
            String::new()
        } else {
            format!("{}\n\n", task.feedback)
        };
        let reject_count = task.reject_count.max(0);
        // 已经升级的任务再打回，是人工明确再给一轮机会：回到「待修改」并把计数清零。
        let next_reject_count = if task.status == "escalated" {
            0
        } else {
            reject_count + 1
        };
        let next_status = if task.status == "escalated" {
            "changes_requested"
        } else if next_reject_count >= gate.max_loop {
            "escalated"
        } else {
            "changes_requested"
        };
        let feedback = format!(
            "{}人工打回：{}",
            old,
            if note.is_empty() { "请修改" } else { note }
        );
        {
            let conn = self.store.db.lock().unwrap();
            conn.execute(
                "UPDATE tasks SET status=?, feedback=?, reject_count=?, updated_at=? WHERE id=?",
                params![
                    next_status,
                    feedback.chars().take(20000).collect::<String>(),
                    next_reject_count,
                    now(),
                    task_id
                ],
            )?;
        }
        self.store.emit(
            Some(&task.room_id),
            Some(task_id),
            None,
            "task.status",
            json!({ "status": next_status, "key": task.key, "title": task.title }),
        );
        self.store.emit(
            Some(&task.room_id),
            Some(task_id),
            None,
            "task.rejected",
            json!({
                "note": note, "escalated": next_status == "escalated",
                "maxLoop": gate.max_loop, "rejectCount": next_reject_count,
            }),
        );
        if next_status == "escalated" {
            self.store.emit(
                Some(&task.room_id),
                Some(task_id),
                None,
                "gate.escalated",
                json!({
                    "gate": gate.gate.as_str(), "by": "human",
                    "maxLoop": gate.max_loop, "rejectCount": next_reject_count,
                }),
            );
        }
        Ok(())
    }

    /// 人工确认门禁：把固定成果标记为通过，之后仍由用户手动合并。
    pub fn approve_task(&self, task_id: &str) -> Result<Value> {
        let running = self.running.lock().unwrap();
        self.assert_task_available(task_id, &running)?;
        let task = self
            .store
            .task(task_id)?
            .ok_or_else(|| anyhow::anyhow!("任务不存在，请刷新会话后重试"))?;
        let room = self
            .store
            .room(&task.room_id)?
            .ok_or_else(|| anyhow::anyhow!("任务所属会话不存在，请刷新后重试"))?;
        if room.status == "archived" {
            bail!("会话已归档，请先恢复再操作");
        }
        if task.status == "approved" {
            bail!("任务已经通过，等待合并即可");
        }
        if task.status == "running" {
            bail!("任务正在执行，结束后再确认");
        }
        if !["review", "escalated"].contains(&task.status.as_str()) {
            bail!("当前任务没有可确认的成果，请先运行任务");
        }
        if task.result_sha.is_empty() {
            bail!("任务没有可确认的成果，请先运行任务");
        }
        let gate = task_gate(Some(&room), Some(&task));
        self.set_status(task_id, "approved", &[])?;
        self.store.emit(
            Some(&room.id),
            Some(task_id),
            None,
            "gate.passed",
            json!({
                "gate": gate.gate.as_str(), "by": "human", "manual": gate.gate != "human",
                "maxLoop": gate.max_loop, "rejectCount": task.reject_count.max(0),
                "resultSha": task.result_sha,
            }),
        );
        Ok(json!({ "status": "approved" }))
    }

    pub async fn retry_task(&self, task_id: &str) -> Result<()> {
        {
            let running = self.running.lock().unwrap();
            if running.contains_key(task_id) {
                bail!("任务仍在准备、执行或收尾，请等待结束后再重试");
            }
            let context = self.task_start_context(task_id, false, false, &running)?;
            self.set_status(task_id, "ready", &[])?;
            self.store.emit(
                Some(&context.room.id),
                Some(task_id),
                None,
                "task.retry",
                json!({}),
            );
        }
        self.schedule_later();
        Ok(())
    }

    pub async fn stop_all(&self) -> Result<usize> {
        let (task_ids, rooms) = {
            let scheduling = self.running.lock().unwrap();
            let task_ids = scheduling.keys().cloned().collect::<Vec<_>>();
            let mut rooms = scheduling
                .values()
                .map(|run| run.room_id.clone())
                .collect::<Vec<_>>();
            rooms.extend(
                self.live_runs
                    .lock()
                    .unwrap()
                    .values()
                    .filter(|run| matches!(run.kind.as_str(), "plan" | "review"))
                    .map(|run| run.room_id.clone()),
            );
            rooms.sort();
            rooms.dedup();

            // Pause automatic dispatch under the scheduler lock, before
            // cancelled runs can free capacity and schedule queued tasks.
            for room_id in &rooms {
                if self
                    .store
                    .room(room_id)?
                    .map(|room| !["paused", "archived"].contains(&room.status.as_str()))
                    .unwrap_or(false)
                {
                    {
                        let conn = self.store.db.lock().unwrap();
                        conn.execute("UPDATE rooms SET status=?, updated_at=? WHERE id=?", params!["paused", now(), room_id])?;
                    }
                    self.store.emit(Some(room_id), None, None, "room.paused", json!({}));
                }
            }
            (task_ids, rooms)
        };

        let mut stopped = 0;
        for task_id in task_ids {
            if self.cancel_task(&task_id).await.is_ok() {
                stopped += 1;
            }
        }
        for room_id in rooms {
            stopped += self.cancel_room_run(&room_id).await;
        }
        Ok(stopped)
    }

    pub fn active_worker_count(&self) -> usize {
        let task_runs = self.running.lock().unwrap().len();
        let live_runs = self.live_runs.lock().unwrap();
        task_runs
            + live_runs
                .values()
                .filter(|run| matches!(run.kind.as_str(), "plan" | "review"))
                .count()
    }

    pub async fn cancel_task(&self, task_id: &str) -> Result<()> {
        let (room_id, pid) = {
            let running = self.running.lock().unwrap();
            let task = self
                .store
                .task(task_id)?
                .ok_or_else(|| anyhow::anyhow!("任务不存在，请刷新会话后重试"))?;
            if self.store.room(&task.room_id)?.map(|room| room.status) == Some("archived".into()) {
                bail!("会话已归档，请先恢复会话再取消任务");
            }
            if ["merged", "done"].contains(&task.status.as_str()) {
                bail!("任务已经完成，不能取消；后续需求请新建任务");
            }
            let operation = self
                .task_operations
                .lock()
                .unwrap()
                .get(task_id)
                .map(|(_, holder)| holder.clone());
            if operation
                .as_ref()
                .map(|holder| holder.kind.as_str() != "review")
                .unwrap_or(false)
            {
                bail!("任务正在合并或读取成果，请等待完成后刷新再操作");
            }
            let review_pid = operation.and_then(|holder| {
                holder.cancelled.store(true, Ordering::SeqCst);
                let pid = *holder.pid.lock().unwrap();
                pid
            });
            let pid = running
                .get(task_id)
                .and_then(|holder| {
                    // Sticky cancellation also covers the interval before a PID exists.
                    holder.cancelled.store(true, Ordering::SeqCst);
                    *holder.pid.lock().unwrap()
                })
                .or(review_pid);
            if task.status != "cancelled" {
                self.set_status(task_id, "cancelled", &[])?;
                self.store.emit(
                    Some(&task.room_id),
                    Some(task_id),
                    None,
                    "task.cancelled",
                    json!({}),
                );
            }
            (task.room_id, pid)
        };
        if let Some(pid) = pid {
            kill_tree(pid);
        }
        // Keep the reservation until preparation, child exit or Git collection drains.
        self.maybe_complete_room(&room_id)?;
        Ok(())
    }
    pub async fn cancel_room_run(&self, room_id: &str) -> usize {
        let mut count = 0;
        for (_, r) in self.live_runs.lock().unwrap().iter() {
            if r.room_id != room_id || !["plan", "review"].contains(&r.kind.as_str()) {
                continue;
            }
            r.cancelled.store(true, Ordering::SeqCst);
            if let Some(pid) = *r.pid.lock().unwrap() {
                kill_tree(pid);
            }
            count += 1;
        }
        if count > 0 {
            self.store.emit(
                Some(room_id),
                None,
                None,
                "run.cancel.requested",
                json!({ "count": count }),
            );
        }
        count
    }

    pub async fn merge_task(&self, task_id: &str) -> Result<Value> {
        self.merge_task_result(task_id, None).await
    }

    pub async fn merge_task_result(
        &self,
        task_id: &str,
        expected_sha: Option<String>,
    ) -> Result<Value> {
        // Claim before queueing: another request cannot rerun or review this task
        // while a merge for a different task owns the repository's queue.
        let (_, _, operation) =
            self.claim_task_operation(task_id, "merge", &["review", "approved", "escalated"])?;
        let engine = self.clone();
        let task_id = task_id.to_string();
        tokio::spawn(async move {
            let result = {
                let _queue = engine.merge_queue.lock().await;
                engine
                    .execute_merge(&task_id, expected_sha.as_deref(), &operation)
                    .await
            };
            if let Err(error) = &result {
                engine.store.emit(
                    Some(&operation.holder.room_id),
                    Some(&task_id),
                    None,
                    "task.merge_failed",
                    json!({ "error": error.to_string() }),
                );
            }
            drop(operation);
            engine.schedule_later();
            result
        })
        .await
        .map_err(|error| anyhow::anyhow!("合并调度中断：{}", error))?
    }

    async fn execute_merge(
        &self,
        task_id: &str,
        expected_sha: Option<&str>,
        operation: &TaskOperation,
    ) -> Result<Value> {
        let frozen = self
            .read_task_result(task_id, expected_sha, Some(operation))
            .await?;
        if frozen.room.status == "archived" {
            bail!("会话不可合并，请先恢复会话并刷新 Diff");
        }
        self.store.emit(
            Some(&frozen.room.id),
            Some(task_id),
            None,
            "task.merge_started",
            json!({ "resultSha": frozen.sha }),
        );
        if !frozen.diff.is_empty() {
            git::merge_squash(
                &frozen.room.repo_path,
                &frozen.room.base_branch,
                &frozen.sha,
                &format!("devhub({}): {}", frozen.task.key, frozen.task.title),
            )
            .await?;
        }
        self.finalize_merge(&frozen, operation)?;
        Ok(json!({ "ok": true, "resultSha": frozen.sha, "noChange": frozen.diff.is_empty() }))
    }

    fn finalize_merge(&self, frozen: &TaskResult, operation: &TaskOperation) -> Result<()> {
        let running = self.running.lock().unwrap();
        let operations = self.task_operations.lock().unwrap();
        if operation.holder.cancelled.load(Ordering::SeqCst) {
            bail!("操作已取消，请刷新任务后再操作");
        }
        if operations.get(&frozen.task.id).map(|(token, _)| token) != Some(&operation.token) {
            return Err(stale_result());
        }
        let other_activity = running.values().any(|holder| holder.room_id == frozen.room.id)
            || operations.values().any(|(token, holder)| {
                holder.room_id == frozen.room.id && token != &operation.token
            });
        let events = {
            let mut conn = self.store.db.lock().unwrap();
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let latest = tx.query_row(
                "SELECT * FROM tasks WHERE id=?", params![frozen.task.id], Task::from_row,
            ).optional()?.ok_or_else(stale_result)?;
            let room = tx.query_row(
                "SELECT * FROM rooms WHERE id=?", params![frozen.room.id], Room::from_row,
            ).optional()?.ok_or_else(stale_result)?;
            if latest.status != frozen.task.status
                || latest.owner_id != frozen.task.owner_id
                || latest.base_sha != frozen.task.base_sha
                || latest.branch != frozen.task.branch
                || latest.result_sha != frozen.task.result_sha
                || latest.worktree != frozen.task.worktree
                || room.repo_path != frozen.room.repo_path
                || room.base_branch != frozen.room.base_branch
                || room.status == "archived"
            {
                return Err(stale_result());
            }
            let ts = now();
            let status = if frozen.diff.is_empty() { "done" } else { "merged" };
            tx.execute(
                "UPDATE tasks SET status=?, updated_at=? WHERE id=?",
                params![status, ts, latest.id],
            )?;
            let mut events = vec![Store::record_event(
                &tx, Some(&room.id), Some(&latest.id), None, "task.status",
                json!({ "status": status, "key": latest.key, "title": latest.title }),
            )?];
            events.push(Store::record_event(
                &tx, Some(&room.id), Some(&latest.id), None, "task.merged",
                json!({ "branch": latest.branch, "resultSha": frozen.sha, "noChange": frozen.diff.is_empty() }),
            )?);
            let mut tasks = {
                let mut stmt = tx.prepare("SELECT * FROM tasks WHERE room_id=? ORDER BY created_at")?;
                let rows = stmt.query_map(params![room.id], Task::from_row)?;
                rows.collect::<rusqlite::Result<Vec<_>>>()?
            };
            let by_key: HashMap<_, _> = tasks.iter()
                .map(|task| (task.key.clone(), task.status.clone())).collect();
            for task in &mut tasks {
                if task.status != "backlog" {
                    continue;
                }
                let deps: Vec<String> = serde_json::from_str(&task.deps_json).unwrap_or_default();
                let ready = deps.iter().all(|key| by_key.get(key)
                    .map(|status| ["merged", "done"].contains(&status.as_str())).unwrap_or(false));
                if ready {
                    tx.execute(
                        "UPDATE tasks SET status='ready', updated_at=? WHERE id=?", params![ts, task.id],
                    )?;
                    task.status = "ready".into();
                    events.push(Store::record_event(
                        &tx, Some(&room.id), Some(&task.id), None, "task.status",
                        json!({ "status": "ready", "key": task.key, "title": task.title }),
                    )?);
                }
            }
            if !other_activity && room.status == "running" && !tasks.is_empty()
                && tasks.iter().all(|task| ["merged", "done", "cancelled"].contains(&task.status.as_str()))
            {
                tx.execute(
                    "UPDATE rooms SET status='completed', updated_at=? WHERE id=?", params![ts, room.id],
                )?;
                events.push(Store::record_event(&tx, Some(&room.id), None, None, "room.completed", json!({}))?);
            }
            tx.commit()?;
            events
        };
        // Both persisted state and event IDs are visible before any status is published.
        for event in events {
            self.store.publish_event(event);
        }
        Ok(())
    }

    pub async fn task_diff(&self, task_id: &str) -> Result<Value> {
        let (task, operation) = {
            let running = self.running.lock().unwrap();
            let task = self
                .store
                .task(task_id)?
                .ok_or_else(|| anyhow::anyhow!("任务不存在，请刷新会话后重试"))?;
            if !task.result_sha.is_empty() {
                (task, None)
            } else {
                if ![
                    "review",
                    "approved",
                    "changes_requested",
                    "escalated",
                    "merged",
                    "done",
                ]
                .contains(&task.status.as_str())
                    || task.branch.is_empty()
                {
                    return Ok(json!({ "diff": "", "resultSha": "" }));
                }
                self.assert_task_available(task_id, &running)?;
                drop(running);
                let (task, _, operation) = self.claim_task_operation(task_id, "diff", &[])?;
                (task, Some(operation))
            }
        };
        let frozen = self
            .read_task_result(&task.id, None, operation.as_ref())
            .await
            .context("无法读取固定成果，请检查仓库、任务分支或重新运行任务")?;
        Ok(json!({ "diff": frozen.diff, "resultSha": frozen.sha }))
    }
    pub fn task_log(&self, task_id: &str) -> String {
        let path: Option<String> = {
            let conn = self.store.db.lock().unwrap();
            conn.query_row(
                "SELECT log_path FROM runs WHERE task_id=? ORDER BY started_at DESC LIMIT 1",
                params![task_id],
                |r| r.get(0),
            )
            .optional()
            .ok()
            .flatten()
        };
        let Some(path) = path else {
            return String::new();
        };
        std::fs::read_to_string(path).unwrap_or_default()
    }

    pub fn create_task(&self, body: &Value) -> Result<String> {
        if !body.is_object() {
            return Err(TaskCreationError::new(400, "任务内容必须是 JSON 对象").into());
        }
        let room_id = creation_text(body, "roomId", "")?.trim();
        if room_id.is_empty() {
            return Err(TaskCreationError::new(400, "请指定任务所属会话").into());
        }
        let title = creation_text(body, "title", "新任务")?.trim();
        let title = if title.is_empty() { "新任务" } else { title };
        let spec = creation_text(body, "spec", "")?;
        let task_type = creation_text(body, "type", "code")?;
        if !["code", "document", "research"].contains(&task_type) {
            return Err(TaskCreationError::new(400, "任务类型必须是 code、document 或 research").into());
        }
        let owner_id = match body.get("ownerId") {
            None | Some(Value::Null) => "",
            Some(Value::String(value)) => value.trim(),
            Some(_) => return Err(TaskCreationError::new(400, "负责人必须是成员 ID").into()),
        };
        let deps = creation_strings(body.get("deps"), "任务依赖")?;
        ensure_creation_unique(&deps)?;
        let acceptance = creation_strings(body.get("acceptance"), "验收标准")?;
        let _scheduling = self.running.lock().unwrap();
        let id = uid("t");
        let events = {
            let mut conn = self.store.db.lock().unwrap();
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let room = tx.query_row(
                "SELECT * FROM rooms WHERE id=?", params![room_id], Room::from_row,
            ).optional()?.ok_or_else(|| TaskCreationError::new(404, "会话不存在，请刷新后重试"))?;
            if room.status == "archived" {
                return Err(TaskCreationError::new(409, "会话已归档，请先恢复再添加任务").into());
            }
            let members = {
                let mut stmt = tx.prepare("SELECT * FROM members WHERE room_id=? ORDER BY sort,name")?;
                let rows = stmt.query_map(params![room_id], Member::from_row)?;
                rows.collect::<rusqlite::Result<Vec<_>>>()?
            };
            let owner = if owner_id.is_empty() {
                members.iter().find(|member| member.enabled != 0)
                    .ok_or_else(|| TaskCreationError::new(400, "会话没有启用的成员，请先启用或添加负责人"))?
            } else {
                members.iter().find(|member| member.id == owner_id && member.enabled != 0)
                    .ok_or_else(|| TaskCreationError::new(400, "负责人必须是当前会话中已启用的成员"))?
            };
            if !is_worker(&owner.worker) {
                return Err(TaskCreationError::new(400, "负责人 CLI 无效，请在会话设置中重新选择 CLI").into());
            }
            let tasks = {
                let mut stmt = tx.prepare("SELECT * FROM tasks WHERE room_id=?")?;
                let rows = stmt.query_map(params![room_id], Task::from_row)?;
                rows.collect::<rusqlite::Result<Vec<_>>>()?
            };
            let occupied: HashSet<_> = tasks.iter().map(|task| task.key.as_str()).collect();
            let mut number = tasks.len() + 1;
            let key = loop {
                let key = format!("T{number}");
                if !occupied.contains(key.as_str()) { break key; }
                number += 1;
            };
            validate_creation_dependencies(&tasks, &deps, &key)?;
            let ts = now();
            tx.execute(
                "INSERT INTO tasks (id, room_id, key, title, spec, type, owner_id, status, deps_json, acceptance_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                params![id, room_id, key, title, spec, task_type, owner.id, "backlog",
                    serde_json::to_string(&deps)?, serde_json::to_string(&acceptance)?, ts, ts],
            )?;
            let mut events = Vec::new();
            if room.status == "completed" {
                tx.execute("UPDATE rooms SET status='paused', updated_at=? WHERE id=?", params![ts, room_id])?;
                events.push(Store::record_event(&tx, Some(room_id), None, None, "room.paused", json!({"reason":"task.created"}))?);
            }
            events.push(Store::record_event(&tx, Some(room_id), Some(&id), None, "task.created", json!({"title":title}))?);
            tx.commit()?;
            events
        };
        for event in events {
            self.store.publish_event(event);
        }
        Ok(id)
    }

    pub fn add_decision(&self, body: &Value) -> Result<String> {
        let room_id = body.get("roomId").and_then(Value::as_str).unwrap_or("");
        if self.store.room(room_id)?.is_none() {
            bail!("房间不存在");
        }
        let id = uid("d");
        {
            let conn = self.store.db.lock().unwrap();
            conn.execute(
                "INSERT INTO decisions (id, room_id, text, rationale, status, created_at) VALUES (?,?,?,?,?,?)",
                params![
                    id,
                    room_id,
                    body.get("text").and_then(Value::as_str).unwrap_or("").chars().take(2000).collect::<String>(),
                    body.get("rationale").and_then(Value::as_str).unwrap_or("").chars().take(2000).collect::<String>(),
                    "active",
                    now(),
                ],
            )?;
        }
        self.store.emit(
            Some(room_id),
            None,
            None,
            "decision.added",
            json!({ "text": body.get("text").and_then(Value::as_str).unwrap_or("") }),
        );
        Ok(id)
    }

    fn set_status(&self, task_id: &str, status: &str, extra: &[(&str, String)]) -> Result<()> {
        let mut sets = vec!["status=?".to_string(), "updated_at=?".to_string()];
        let mut vals: Vec<SqlValue> =
            vec![SqlValue::Text(status.to_string()), SqlValue::Text(now())];
        for (k, v) in extra {
            sets.push(format!("{}=?", k));
            vals.push(SqlValue::Text(v.clone()));
        }
        vals.push(SqlValue::Text(task_id.to_string()));
        {
            let conn = self.store.db.lock().unwrap();
            conn.execute(
                &format!("UPDATE tasks SET {} WHERE id=?", sets.join(",")),
                params_from_iter(vals),
            )?;
        }
        if let Some(t) = self.store.task(task_id)? {
            self.store.emit(
                Some(&t.room_id),
                Some(task_id),
                None,
                "task.status",
                json!({ "status": status, "key": t.key, "title": t.title }),
            );
        }
        Ok(())
    }

    fn refresh_ready(&self, room_id: &str) -> Result<()> {
        let tasks = self.store.tasks(room_id)?;
        let by_key: HashMap<String, String> = tasks
            .iter()
            .map(|t| (t.key.clone(), t.status.clone()))
            .collect();
        for t in tasks {
            if t.status != "backlog" {
                continue;
            }
            let deps: Vec<String> = serde_json::from_str(&t.deps_json).unwrap_or_default();
            let ok = deps.iter().all(|k| {
                by_key
                    .get(k)
                    .map(|s| ["merged", "done"].contains(&s.as_str()))
                    .unwrap_or(false)
            });
            if ok {
                self.set_status(&t.id, "ready", &[])?;
            }
        }
        Ok(())
    }

    fn maybe_complete_room(&self, room_id: &str) -> Result<()> {
        let running = self.running.lock().unwrap();
        if running.values().any(|holder| holder.room_id == room_id)
            || self
                .task_operations
                .lock()
                .unwrap()
                .values()
                .any(|(_, holder)| holder.room_id == room_id)
        {
            return Ok(());
        }
        let room = self.store.room(room_id)?;
        let Some(room) = room else { return Ok(()) };
        if room.status != "running" {
            return Ok(());
        }
        let tasks = self.store.tasks(room_id)?;
        if tasks.is_empty() {
            return Ok(());
        }
        let terminal = tasks
            .iter()
            .all(|t| ["merged", "done", "cancelled"].contains(&t.status.as_str()));
        if terminal {
            let conn = self.store.db.lock().unwrap();
            conn.execute(
                "UPDATE rooms SET status=?, updated_at=? WHERE id=?",
                params!["completed", now(), room_id],
            )?;
            drop(conn);
            self.store
                .emit(Some(room_id), None, None, "room.completed", json!({}));
        }
        Ok(())
    }
}

fn creation_text<'a>(body: &'a Value, field: &str, fallback: &'a str) -> Result<&'a str> {
    match body.get(field) {
        None => Ok(fallback),
        Some(Value::String(value)) => Ok(value),
        Some(_) => Err(TaskCreationError::new(400, format!("{field} 必须是文字")).into()),
    }
}

fn creation_strings(value: Option<&Value>, label: &str) -> Result<Vec<String>> {
    let Some(value) = value else { return Ok(Vec::new()) };
    let values = value.as_array().ok_or_else(|| TaskCreationError::new(400, format!("{label}必须是文字列表")))?;
    values.iter().map(|value| {
        value.as_str().map(str::trim).filter(|value| !value.is_empty())
            .map(str::to_string)
            .ok_or_else(|| TaskCreationError::new(400, format!("{label}不能包含空白或非文字项")).into())
    }).collect()
}

fn ensure_creation_unique(deps: &[String]) -> Result<()> {
    let mut seen = HashSet::new();
    for key in deps {
        if !seen.insert(key) {
            return Err(TaskCreationError::new(400, format!("任务依赖重复：{key}")).into());
        }
    }
    Ok(())
}

fn validate_creation_dependencies(tasks: &[Task], deps: &[String], new_key: &str) -> Result<()> {
    let mut by_key: HashMap<&str, Vec<&Task>> = HashMap::new();
    for task in tasks {
        by_key.entry(&task.key).or_default().push(task);
    }
    let mut states = HashMap::new();
    let mut stack = deps.iter().rev().map(|key| (key.clone(), false)).collect::<Vec<_>>();
    while let Some((key, leaving)) = stack.pop() {
        if leaving {
            states.insert(key, 2);
            continue;
        }
        if key == new_key {
            return Err(TaskCreationError::new(400, "任务不能依赖自身或形成依赖循环").into());
        }
        match states.get(&key) {
            Some(1) => return Err(TaskCreationError::new(400, format!("依赖链存在循环：{key}")).into()),
            Some(2) => continue,
            _ => {}
        }
        let matching = by_key.get(key.as_str())
            .ok_or_else(|| TaskCreationError::new(400, format!("依赖 {key} 不属于当前会话或已不存在")))?;
        if matching.len() != 1 {
            return Err(TaskCreationError::new(400, format!("依赖 {key} 的任务编号重复，请先处理旧任务")).into());
        }
        let task = matching[0];
        if ["merged", "done"].contains(&task.status.as_str()) {
            states.insert(key, 2);
            continue;
        }
        let upstream: Vec<String> = serde_json::from_str(&task.deps_json)
            .map_err(|_| TaskCreationError::new(400, format!("依赖 {key} 的上游配置无效")))?;
        if upstream.iter().any(|key| key.trim().is_empty()) {
            return Err(TaskCreationError::new(400, format!("依赖 {key} 的上游不能包含空白项")).into());
        }
        ensure_creation_unique(&upstream)?;
        states.insert(key.clone(), 1);
        stack.push((key, true));
        stack.extend(upstream.into_iter().rev().map(|key| (key, false)));
    }
    Ok(())
}

fn normalize_member(m: &Value) -> Result<NormalizedMember> {
    let worker = m.get("worker").and_then(Value::as_str).unwrap_or("");
    if !is_worker(worker) {
        bail!(
            "未知 worker：{}",
            if worker.is_empty() {
                "（空）"
            } else {
                worker
            }
        );
    }
    let name = m
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if name.is_empty() {
        bail!("成员名不能为空");
    }
    let concurrency = m
        .get("concurrency")
        .and_then(Value::as_i64)
        .unwrap_or(1)
        .clamp(1, 10);
    Ok(NormalizedMember {
        name,
        worker: worker.to_string(),
        role_name: m
            .get("roleName")
            .or_else(|| m.get("role_name"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        role_brief: m
            .get("roleBrief")
            .or_else(|| m.get("role_brief"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        model: m
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        concurrency,
        enabled: m.get("enabled").and_then(Value::as_bool).unwrap_or(true),
    })
}

fn insert_member(store: &Store, room_id: &str, m: &NormalizedMember, sort: i64) -> Result<Member> {
    let id = uid("m");
    {
        let conn = store.db.lock().unwrap();
        conn.execute(
            "INSERT INTO members (id, room_id, name, worker, role_name, role_brief, model, concurrency, enabled, sort) VALUES (?,?,?,?,?,?,?,?,?,?)",
            params![id, room_id, m.name, m.worker, m.role_name, m.role_brief, m.model, m.concurrency, if m.enabled { 1 } else { 0 }, sort],
        )?;
    }
    store
        .member(&id)?
        .ok_or_else(|| anyhow::anyhow!("成员创建失败"))
}

#[cfg(test)]
mod merge_completion_tests {
    use super::*;

    #[test]
    fn completing_a_merge_ignores_its_own_operation_but_respects_other_activity() {
        for source in ["none", "run", "operation", "other_room"] {
            let temp = tempfile::tempdir().unwrap();
            let store = Store::open(temp.path().join("data")).unwrap();
            {
                let db = store.db.lock().unwrap();
                db.execute("INSERT INTO rooms (id,name,repo_path,status,created_at,updated_at) VALUES ('room','room','unused','running','now','now')", []).unwrap();
                db.execute("INSERT INTO tasks (id,room_id,key,title,status,created_at,updated_at) VALUES ('task','room','T1','merge','approved','now','now')", []).unwrap();
            }
            let engine = Engine::new(store);
            let (task, room, operation) = engine.claim_task_operation("task", "merge", &["approved"]).unwrap();
            let room_id = if source == "other_room" { "other" } else { "room" };
            if source == "run" || source == "other_room" {
                engine.running.lock().unwrap().insert("running-task".into(), RunHolder {
                    room_id: room_id.into(), member_id: "member".into(), run_id: "worker".into(),
                    phase: "running".into(), pid: Arc::new(Mutex::new(None)),
                    cancelled: Arc::new(AtomicBool::new(false)),
                });
            } else if source == "operation" {
                engine.task_operations.lock().unwrap().insert("other-task".into(), ("other-token".into(), LiveRun {
                    kind: "diff".into(), room_id: room_id.into(), task_id: Some("other-task".into()),
                    pid: Arc::new(Mutex::new(None)), cancelled: Arc::new(AtomicBool::new(false)),
                }));
            }
            let frozen = TaskResult { task, room, sha: "fixed-sha".into(), diff: "diff".into() };
            engine.finalize_merge(&frozen, &operation).unwrap();
            let expected = if source == "run" || source == "operation" { "running" } else { "completed" };
            assert_eq!(engine.store.room("room").unwrap().unwrap().status, expected, "{source}");
            assert_eq!(engine.store.task("task").unwrap().unwrap().status, "merged");
        }
    }
}

#[cfg(test)]
mod settings_activity_tests {
    use super::*;

    fn live(room_id: &str, kind: &str) -> LiveRun {
        LiveRun { kind: kind.into(), room_id: room_id.into(), task_id: None,
            pid: Arc::new(Mutex::new(None)), cancelled: Arc::new(AtomicBool::new(false)) }
    }

    #[tokio::test]
    async fn active_tasks_plans_and_reviews_block_settings_and_flow_only_in_their_room() {
        let dir = tempfile::tempdir().unwrap();
        let engine = Engine::new(Store::open(dir.path().join("data")).unwrap());
        {
            let db = engine.store.db.lock().unwrap();
            db.execute("INSERT INTO rooms (id,name,repo_path,flow_json,planner_id,reviewer_id,created_at,updated_at) VALUES ('room','room','unused',?,'m','m','then','then')", [default_flow().to_string()]).unwrap();
            db.execute("INSERT INTO members (id,room_id,name,worker) VALUES ('m','room','member','claude')", []).unwrap();
        }
        for source in ["task", "operation", "plan", "review"] {
            let current = crate::settings::read(&engine.store, "room").unwrap();
            let settings = json!({"version":current["version"],"settings":current["settings"]});
            let patch = json!({"flow":{"nodes":[],"edges":[]},"expectedFlow":default_flow()});
            match source {
                "task" => { engine.running.lock().unwrap().insert("task".into(), RunHolder {
                    room_id:"room".into(), member_id:"m".into(),run_id:"run".into(),phase:"preparing".into(),
                    pid:Arc::new(Mutex::new(None)),cancelled:Arc::new(AtomicBool::new(false)) }); }
                "operation" => { engine.task_operations.lock().unwrap().insert("task".into(), ("run".into(),live("room","merge"))); }
                kind => { engine.live_runs.lock().unwrap().insert("run".into(),live("room",kind)); }
            }
            let error = engine.save_room_settings("room", &settings).await.unwrap_err();
            assert_eq!(error.downcast_ref::<crate::settings::SettingsError>().unwrap().status, 409);
            let error = engine.update_room("room", &patch).await.unwrap_err();
            assert_eq!(error.downcast_ref::<crate::settings::SettingsError>().unwrap().status, 409);
            assert_eq!(crate::settings::read(&engine.store, "room").unwrap(), current);
            assert_eq!(engine.store.room("room").unwrap().unwrap().flow_json, default_flow().to_string());
            engine.running.lock().unwrap().clear();
            engine.task_operations.lock().unwrap().clear();
            engine.live_runs.lock().unwrap().clear();
        }
        engine.live_runs.lock().unwrap().insert("run".into(),live("other","plan"));
        engine.store.db.lock().unwrap().execute("UPDATE rooms SET status='paused' WHERE id='room'", []).unwrap();
        let current = crate::settings::read(&engine.store, "room").unwrap();
        assert!(engine.save_room_settings("room", &json!({"version":current["version"],"settings":current["settings"]})).await.is_ok());
        assert!(engine.update_room("room", &json!({"flow":{"nodes":[],"edges":[]},"expectedFlow":default_flow()})).await.is_ok());
    }

    #[test]
    fn plan_activity_cleans_up_on_early_return() {
        let runs = Arc::new(Mutex::new(HashMap::from([("run".into(),live("room","plan"))])));
        { let _guard = PlanActivity { token:"run".into(), live_runs:runs.clone() }; }
        assert!(runs.lock().unwrap().is_empty());
    }
}

fn extract_json(text: &str) -> Option<Value> {
    let cleaned = text.replace("```json", "").replace("```", "");
    let start = cleaned.find('{')?;
    let end = cleaned.rfind('}')?;
    if end <= start {
        return None;
    }
    serde_json::from_str(&cleaned[start..=end]).ok()
}
