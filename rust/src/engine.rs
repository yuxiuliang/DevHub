use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{bail, Result};
use rusqlite::{params, params_from_iter, types::Value as SqlValue, OptionalExtension};
use serde_json::{json, Value};
use tokio::sync::Mutex as AsyncMutex;

use crate::adapters::{is_worker, kill_tree, run_worker, WorkerOpts, WorkerResult};
use crate::flow::{default_flow, starter_flow};
use crate::git;
use crate::models::{member_payload, now, safe_json, uid, Member, Room, Task};
use crate::prompts::{build_plan_prompt, build_review_prompt, build_task_prompt};
use crate::store::Store;

const GLOBAL_LIMIT: usize = 3;
const ROOM_LIMIT: usize = 2;

#[derive(Clone)]
pub struct RunHolder {
    pub room_id: String,
    pub member_id: String,
    pub run_id: String,
    pub pid: Arc<Mutex<Option<u32>>>,
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
    running: Arc<AsyncMutex<HashMap<String, RunHolder>>>,
    starting: Arc<AsyncMutex<HashSet<String>>>,
    live_runs: Arc<AsyncMutex<HashMap<String, LiveRun>>>,
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
            running: Arc::new(AsyncMutex::new(HashMap::new())),
            starting: Arc::new(AsyncMutex::new(HashSet::new())),
            live_runs: Arc::new(AsyncMutex::new(HashMap::new())),
            merge_queue: Arc::new(AsyncMutex::new(())),
        }
    }

    pub fn list_rooms(&self) -> Result<Vec<Value>> {
        self.store.list_rooms()
    }

    pub async fn running_tasks(&self) -> Vec<Value> {
        self.running
            .lock()
            .await
            .iter()
            .map(|(task_id, h)| {
                json!({
                    "taskId": task_id,
                    "roomId": h.room_id,
                    "memberId": h.member_id,
                    "runId": h.run_id,
                    "pid": *h.pid.lock().unwrap(),
                })
            })
            .collect()
    }

    async fn running_ids(&self, room_id: &str) -> Vec<String> {
        self.running
            .lock()
            .await
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

    pub async fn update_room(&self, room_id: &str, patch: &Value) -> Result<Value> {
        let room = self
            .store
            .room(room_id)?
            .ok_or_else(|| anyhow::anyhow!("房间不存在"))?;
        if room.status == "archived" {
            bail!("会话已归档，请先恢复再修改");
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
        Ok(self.room_state(room_id).await?.unwrap_or(Value::Null))
    }

    pub async fn archive_room(&self, room_id: &str) -> Result<()> {
        let room = self
            .store
            .room(room_id)?
            .ok_or_else(|| anyhow::anyhow!("房间不存在"))?;
        if room.status == "archived" {
            return Ok(());
        }
        let live = self
            .running
            .lock()
            .await
            .values()
            .any(|r| r.room_id == room_id)
            || self
                .live_runs
                .lock()
                .await
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
            .await
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
        self.live_runs.lock().await.insert(
            run_id.clone(),
            LiveRun {
                kind: "plan".into(),
                room_id: room_id.to_string(),
                task_id: None,
                pid: pid.clone(),
                cancelled: cancelled.clone(),
            },
        );
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
        self.live_runs.lock().await.remove(&run_id);
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
        let plan = extract_json(&res.text).filter(|p| {
            p.get("tasks")
                .and_then(Value::as_array)
                .map(|a| !a.is_empty())
                .unwrap_or(false)
        });
        let Some(plan) = plan else {
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
            json!({ "count": plan.get("tasks").and_then(Value::as_array).map(|a| a.len()).unwrap_or(0), "summary": plan.get("summary").and_then(Value::as_str).unwrap_or("") }),
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
        let plan_tasks = plan
            .get("tasks")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if plan_tasks.is_empty() {
            bail!("计划里没有任务");
        }
        let active: i64 = {
            let conn = self.store.db.lock().unwrap();
            conn.query_row(
                "SELECT COUNT(*) FROM tasks WHERE room_id=? AND status='running'",
                params![room_id],
                |r| r.get(0),
            )?
        };
        if active > 0 {
            bail!("还有任务在运行，不能覆盖计划");
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
        let members = self.store.members(room_id)?;
        let flow = safe_json(&room.flow_json, default_flow());
        let phases = flow
            .get("nodes")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter(|n| n.get("type").and_then(Value::as_str) == Some("phase"))
                    .cloned()
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let ts = now();
        let mut created = 0usize;
        {
            let conn = self.store.db.lock().unwrap();
            conn.execute("DELETE FROM tasks WHERE room_id=?", params![room_id])?;
            for (i, t) in plan_tasks.iter().enumerate() {
                let key = format!("T{}", i + 1);
                let owner_name = t.get("owner").and_then(Value::as_str).unwrap_or("");
                let owner = members
                    .iter()
                    .find(|m| m.name == owner_name)
                    .or_else(|| {
                        members
                            .iter()
                            .find(|m| m.name.contains(owner_name) || owner_name.contains(&m.name))
                    })
                    .or_else(|| members.first());
                let phase = t
                    .get("phase")
                    .and_then(Value::as_str)
                    .and_then(|name| {
                        phases
                            .iter()
                            .find(|p| p.get("name").and_then(Value::as_str) == Some(name))
                    })
                    .or_else(|| phases.get(i.min(phases.len().saturating_sub(1))));
                let id = uid("t");
                let deps = t
                    .get("dependsOn")
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .filter_map(Value::as_i64)
                            .map(|n| format!("T{}", n))
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                let acceptance = t.get("acceptance").cloned().unwrap_or(json!([]));
                conn.execute(
                    "INSERT INTO tasks (id, room_id, key, title, spec, type, owner_id, phase_id, status, deps_json, acceptance_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    params![
                        id,
                        room_id,
                        key,
                        t.get("title").and_then(Value::as_str).unwrap_or(&format!("任务 {}", i + 1)),
                        t.get("spec").and_then(Value::as_str).unwrap_or(""),
                        t.get("type").and_then(Value::as_str).unwrap_or("code"),
                        owner.map(|m| m.id.clone()),
                        phase.and_then(|p| p.get("id").and_then(Value::as_str)).map(|s| s.to_string()),
                        "backlog",
                        serde_json::to_string(&deps).unwrap_or_else(|_| "[]".into()),
                        acceptance.to_string(),
                        ts,
                        ts,
                    ],
                )?;
                created += 1;
            }
            if let Some(decisions) = plan.get("decisions").and_then(Value::as_array) {
                for d in decisions {
                    conn.execute(
                        "INSERT INTO decisions (id, room_id, text, rationale, status, created_at) VALUES (?,?,?,?,?,?)",
                        params![uid("d"), room_id, d.as_str().unwrap_or(""), "", "active", ts],
                    )?;
                }
            }
            conn.execute(
                "UPDATE rooms SET plan_json='', status='planning', updated_at=? WHERE id=?",
                params![ts, room_id],
            )?;
        }
        self.store.emit(
            Some(room_id),
            None,
            None,
            "plan.applied",
            json!({ "count": created }),
        );
        self.refresh_ready(room_id)?;
        Ok(self.room_state_sync(room_id)?.unwrap_or(Value::Null))
    }

    fn room_state_sync(&self, room_id: &str) -> Result<Option<Value>> {
        self.store.room_state(room_id, Vec::new())
    }

    pub async fn start_room(&self, room_id: &str) -> Result<Value> {
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
        let engine = self.clone();
        tokio::spawn(async move {
            engine.schedule().await;
        });
        Ok(self.room_state(room_id).await?.unwrap_or(Value::Null))
    }

    pub async fn pause_room(&self, room_id: &str) -> Result<()> {
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

    pub async fn schedule(&self) {
        let rooms = self.running_rooms();
        for room in rooms {
            let limit = if room.mode == "serial" { 1 } else { ROOM_LIMIT };
            let room_id = room.id.clone();
            if self
                .running
                .lock()
                .await
                .values()
                .filter(|r| r.room_id == room_id)
                .count()
                >= limit
            {
                continue;
            }
            let tasks = self.store.tasks(&room_id).unwrap_or_default();
            for t in tasks.into_iter().filter(|t| t.status == "ready") {
                if self.running.lock().await.len() >= GLOBAL_LIMIT {
                    return;
                }
                let room_count = self
                    .running
                    .lock()
                    .await
                    .values()
                    .filter(|r| r.room_id == room_id)
                    .count();
                if room_count >= limit {
                    break;
                }
                let Some(owner_id) = t.owner_id.clone() else {
                    continue;
                };
                if self.starting.lock().await.contains(&t.id)
                    || self.running.lock().await.contains_key(&t.id)
                {
                    continue;
                }
                let Some(member) = self.store.member(&owner_id).ok().flatten() else {
                    continue;
                };
                if member.enabled == 0 {
                    continue;
                }
                let member_count = self
                    .running
                    .lock()
                    .await
                    .values()
                    .filter(|r| r.member_id == member.id)
                    .count();
                if member_count >= member.concurrency.max(1) as usize {
                    continue;
                }
                self.starting.lock().await.insert(t.id.clone());
                let engine = self.clone();
                let id = t.id.clone();
                let room_id_for_spawn = room_id.clone();
                tokio::spawn(async move {
                    if let Err(e) = engine.start_task(&id).await {
                        engine
                            .set_status(&id, "failed", &[("summary", e.to_string())])
                            .ok();
                        engine.store.emit(
                            Some(&room_id_for_spawn),
                            Some(&id),
                            None,
                            "task.error",
                            json!({ "error": e.to_string() }),
                        );
                    }
                    engine.starting.lock().await.remove(&id);
                });
            }
        }
    }

    async fn ensure_worktree(&self, task: &Task, room: &Room) -> Result<String> {
        if !task.worktree.is_empty() && std::path::Path::new(&task.worktree).join(".git").exists() {
            return Ok(task.worktree.clone());
        }
        let base = if room.base_branch.is_empty() {
            git::current_branch(&room.repo_path).await
        } else {
            room.base_branch.clone()
        };
        let sha = git::rev_parse(&room.repo_path, &base).await?;
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
        if self.running.lock().await.contains_key(task_id) {
            return Ok(json!({ "ok": true, "already": true }));
        }
        let task = self
            .store
            .task(task_id)?
            .ok_or_else(|| anyhow::anyhow!("任务不存在"))?;
        let room = self
            .store
            .room(&task.room_id)?
            .ok_or_else(|| anyhow::anyhow!("房间不存在"))?;
        if room.status == "archived" {
            bail!("会话已归档，请先恢复再运行任务");
        }
        let member = task
            .owner_id
            .as_deref()
            .and_then(|id| self.store.member(id).ok().flatten())
            .ok_or_else(|| anyhow::anyhow!("任务没有负责人"))?;
        if member.enabled == 0 {
            bail!("负责人「{}」已停用，请先启用或换人", member.name);
        }
        let wt = self.ensure_worktree(&task, &room).await?;
        let base_sha = self
            .store
            .task(task_id)?
            .map(|t| t.base_sha)
            .unwrap_or_default();
        if base_sha.is_empty() {
            bail!("无法确定任务基准提交（base_sha 为空）");
        }
        if self.store.task(task_id)?.map(|t| t.status) == Some("cancelled".into()) {
            return Ok(json!({ "ok": false, "cancelled": true }));
        }
        let decisions = self.store.active_decisions(&room.id)?;
        let all_tasks = self.store.tasks(&room.id)?;
        let by_key: HashMap<String, Task> = all_tasks
            .iter()
            .map(|t| (t.key.clone(), t.clone()))
            .collect();
        let deps: Vec<String> = serde_json::from_str(&task.deps_json).unwrap_or_default();
        let upstream = deps
            .iter()
            .filter_map(|k| by_key.get(k).cloned())
            .collect::<Vec<_>>();
        let prompt = build_task_prompt(
            &room,
            &task,
            &member,
            &decisions,
            &upstream,
            &task.feedback,
            &wt,
        );
        let run_id = uid("run");
        {
            let conn = self.store.db.lock().unwrap();
            conn.execute(
                "INSERT INTO runs (id, task_id, member_id, status, log_path, started_at) VALUES (?,?,?,?,?,?)",
                params![run_id, task_id, member.id, "running", "", now()],
            )?;
        }
        self.set_status(
            task_id,
            "running",
            &[("summary", String::new()), ("diff_stat", String::new())],
        )?;
        self.store.emit(
            Some(&room.id),
            Some(task_id),
            Some(&run_id),
            "task.started",
            json!({ "member": member.name, "worker": member.worker, "key": task.key }),
        );
        let pid = Arc::new(Mutex::new(None));
        let holder = RunHolder {
            room_id: room.id.clone(),
            member_id: member.id.clone(),
            run_id: run_id.clone(),
            pid: pid.clone(),
        };
        self.running
            .lock()
            .await
            .insert(task_id.to_string(), holder);
        let timeout = if task.task_type == "code" { 1800 } else { 1200 };
        let res = run_worker(WorkerOpts {
            store: self.store.clone(),
            worker: member.worker.clone(),
            model: member.model.clone(),
            auto_approve: room.auto_approve != 0,
            cwd: wt.clone(),
            prompt,
            run_id: run_id.clone(),
            room_id: Some(room.id.clone()),
            task_id: Some(task_id.to_string()),
            actor: Some(json!({ "name": member.name, "worker": member.worker, "kind": "task" })),
            timeout: Duration::from_secs(timeout),
            pid_slot: pid,
            cancel: Arc::new(AtomicBool::new(false)),
        })
        .await;
        self.running.lock().await.remove(task_id);
        let res = match res {
            Ok(r) => r,
            Err(e) => {
                self.set_status(task_id, "failed", &[("summary", e.to_string())])?;
                self.store.emit(
                    Some(&room.id),
                    Some(task_id),
                    Some(&run_id),
                    "task.error",
                    json!({ "error": e.to_string() }),
                );
                self.schedule_later();
                return Err(e);
            }
        };
        let latest = self
            .store
            .task(task_id)?
            .map(|t| t.status)
            .unwrap_or_default();
        if latest == "cancelled" {
            self.update_run(&run_id, "cancelled", &res, "已取消")?;
            self.schedule_later();
            return Ok(json!({ "ok": false, "cancelled": true }));
        }
        let mut committed = false;
        match git::commit_all(&wt, &format!("devhub({}): {}", task.key, task.title)).await {
            Ok(v) => committed = v,
            Err(e) => {
                self.store.log(
                    Some(&room.id),
                    Some(task_id),
                    &run_id,
                    &format!("[devhub] 收集改动失败：{}", e),
                    "err",
                    "",
                    None,
                );
            }
        }
        let stat = git::diff_stat(&wt, &base_sha).await;
        let failed = res.code != 0;
        let no_change = !failed && stat.trim().is_empty();
        let next_status = if failed {
            "failed"
        } else if no_change {
            "done"
        } else {
            "review"
        };
        let summary = if res.text.trim().is_empty() {
            if res.error.is_empty() {
                "（没有文本输出）".to_string()
            } else {
                format!("执行失败：{}", res.error)
            }
        } else {
            res.text.trim().to_string()
        };
        self.set_status(
            task_id,
            next_status,
            &[
                ("summary", summary.chars().take(20000).collect()),
                ("diff_stat", stat.clone()),
            ],
        )?;
        self.update_run(
            &run_id,
            if failed { "failed" } else { "completed" },
            &res,
            &res.error,
        )?;
        self.store.emit(
            Some(&room.id),
            Some(task_id),
            Some(&run_id),
            if failed {
                "task.failed"
            } else {
                "task.finished"
            },
            json!({
                "code": res.code,
                "summary": summary.chars().take(4000).collect::<String>(),
                "stat": stat,
                "committed": committed,
                "noChange": no_change,
                "status": next_status,
                "session": res.session,
                "cost": res.cost,
                "usage": res.usage,
            }),
        );
        self.refresh_ready(&room.id)?;
        self.maybe_complete_room(&room.id)?;
        self.schedule_later();
        Ok(json!({ "ok": !failed, "code": res.code }))
    }

    fn update_run(
        &self,
        run_id: &str,
        status: &str,
        res: &WorkerResult,
        error: &str,
    ) -> Result<()> {
        let conn = self.store.db.lock().unwrap();
        conn.execute(
            "UPDATE runs SET status=?, session_id=?, exit_code=?, error=?, log_path=?, ended_at=? WHERE id=?",
            params![status, res.session, res.code, error, res.log_path, now(), run_id],
        )?;
        Ok(())
    }

    pub async fn review_task(&self, task_id: &str) -> Result<Value> {
        let task = self
            .store
            .task(task_id)?
            .ok_or_else(|| anyhow::anyhow!("任务不存在"))?;
        let room = self
            .store
            .room(&task.room_id)?
            .ok_or_else(|| anyhow::anyhow!("房间不存在"))?;
        if room.status == "archived" {
            bail!("会话已归档，请先恢复再评审");
        }
        let members = self.store.members(&room.id)?;
        let reviewer = members
            .iter()
            .find(|m| Some(&m.id) == room.reviewer_id.as_ref())
            .or_else(|| members.last())
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("没有可用的评审者"))?;
        if reviewer.enabled == 0 {
            bail!("评审者「{}」已停用，请先启用或换人", reviewer.name);
        }
        if self
            .live_runs
            .lock()
            .await
            .values()
            .any(|r| r.kind == "review" && r.task_id.as_deref() == Some(task_id))
        {
            bail!("这个任务正在评审，请等待或先点停止");
        }
        let reviewed = self.store.review_count(task_id)?;
        if reviewed >= 2 {
            bail!("这个任务已经评审 2 轮，达到上限；请人工判断后合并，或按意见重跑后人工合并。");
        }
        let diff = git::diff(&task.worktree, &task.base_sha).await;
        if diff.is_empty() {
            bail!("这个任务没有可评审的改动");
        }
        let acceptance: Vec<String> =
            serde_json::from_str(&task.acceptance_json).unwrap_or_default();
        let prompt =
            build_review_prompt(&room, &task, &reviewer, &diff, &acceptance, &task.worktree);
        let run_id = uid("run");
        self.store.emit(
            Some(&room.id),
            Some(task_id),
            Some(&run_id),
            "review.started",
            json!({ "reviewer": reviewer.name, "worker": reviewer.worker, "key": task.key }),
        );
        let dirty_before = git::tracked_status(&task.worktree).await;
        let head_before = git::rev_parse(&task.worktree, "HEAD")
            .await
            .unwrap_or_default();
        let pid = Arc::new(Mutex::new(None));
        let cancelled = Arc::new(AtomicBool::new(false));
        self.live_runs.lock().await.insert(
            run_id.clone(),
            LiveRun {
                kind: "review".into(),
                room_id: room.id.clone(),
                task_id: Some(task_id.to_string()),
                pid: pid.clone(),
                cancelled: cancelled.clone(),
            },
        );
        let res = run_worker(WorkerOpts {
            store: self.store.clone(),
            worker: reviewer.worker.clone(),
            model: reviewer.model.clone(),
            auto_approve: false,
            cwd: task.worktree.clone(),
            prompt,
            run_id: run_id.clone(),
            room_id: Some(room.id.clone()),
            task_id: Some(task_id.to_string()),
            actor: Some(
                json!({ "name": reviewer.name, "worker": reviewer.worker, "kind": "review" }),
            ),
            timeout: Duration::from_secs(480),
            pid_slot: pid,
            cancel: cancelled.clone(),
        })
        .await;
        self.live_runs.lock().await.remove(&run_id);
        if cancelled.load(Ordering::SeqCst) {
            self.store.emit(
                Some(&room.id),
                Some(task_id),
                Some(&run_id),
                "review.cancelled",
                json!({}),
            );
            bail!("评审已取消");
        }
        let res = res?;
        let dirty_after = git::tracked_status(&task.worktree).await;
        let head_after = git::rev_parse(&task.worktree, "HEAD")
            .await
            .unwrap_or_default();
        if dirty_after != dirty_before || head_after != head_before {
            self.store.emit(
                Some(&room.id),
                Some(task_id),
                Some(&run_id),
                "review.failed",
                json!({ "error": "评审过程中修改了工作区或提交，评审结果不可信" }),
            );
            bail!(
                "评审过程中修改了工作区或提交，评审结果不可信；请检查该 reviewer 的角色约束后重试"
            );
        }
        let verdict = extract_json(&res.text).unwrap_or_else(|| {
            json!({
                "verdict": "request_changes",
                "blocking": [],
                "notes": if res.text.trim().is_empty() { res.error.clone() } else { res.text.chars().take(1000).collect::<String>() },
            })
        });
        let round = self.store.review_count(task_id)? + 1;
        {
            let conn = self.store.db.lock().unwrap();
            conn.execute(
                "INSERT INTO reviews (id, task_id, round, verdict, payload, created_at) VALUES (?,?,?,?,?,?)",
                params![uid("rv"), task_id, round, verdict.get("verdict").and_then(Value::as_str).unwrap_or("request_changes"), verdict.to_string(), now()],
            )?;
        }
        let approve = verdict.get("verdict").and_then(Value::as_str) == Some("approve");
        if approve {
            self.set_status(task_id, "approved", &[])?;
        } else {
            let lines = verdict
                .get("blocking")
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .map(|b| {
                            format!(
                                "- {}:{} {} → {}",
                                b.get("file").and_then(Value::as_str).unwrap_or("?"),
                                b.get("line").and_then(Value::as_i64).unwrap_or(0),
                                b.get("issue").and_then(Value::as_str).unwrap_or(""),
                                b.get("suggestion").and_then(Value::as_str).unwrap_or(""),
                            )
                        })
                        .collect::<Vec<_>>()
                        .join("\n")
                })
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| {
                    verdict
                        .get("notes")
                        .and_then(Value::as_str)
                        .unwrap_or("需要修改")
                        .to_string()
                });
            let feedback = format!("第 {} 轮评审：\n{}", round, lines);
            let old = if task.feedback.is_empty() {
                String::new()
            } else {
                format!("{}\n\n", task.feedback)
            };
            self.set_status(
                task_id,
                if round >= 2 {
                    "escalated"
                } else {
                    "changes_requested"
                },
                &[(
                    "feedback",
                    format!("{}{}", old, feedback).chars().take(20000).collect(),
                )],
            )?;
        }
        self.store.emit(
            Some(&room.id),
            Some(task_id),
            Some(&run_id),
            "review.done",
            json!({
                "verdict": verdict.get("verdict").and_then(Value::as_str).unwrap_or("request_changes"),
                "round": round,
                "escalated": !approve && round >= 2,
                "notes": verdict.get("notes").and_then(Value::as_str).unwrap_or(""),
            }),
        );
        Ok(json!({ "verdict": verdict, "round": round }))
    }

    pub fn reject_task(&self, task_id: &str, note: &str) -> Result<()> {
        let task = self
            .store
            .task(task_id)?
            .ok_or_else(|| anyhow::anyhow!("任务不存在"))?;
        if let Some(room) = self.store.room(&task.room_id)? {
            if room.status == "archived" {
                bail!("会话已归档，请先恢复再操作");
            }
        }
        let old = if task.feedback.is_empty() {
            String::new()
        } else {
            format!("{}\n\n", task.feedback)
        };
        let feedback = format!(
            "{}人工打回：{}",
            old,
            if note.is_empty() { "请修改" } else { note }
        );
        self.set_status(
            task_id,
            "changes_requested",
            &[("feedback", feedback.chars().take(20000).collect())],
        )?;
        self.store.emit(
            Some(&task.room_id),
            Some(task_id),
            None,
            "task.rejected",
            json!({ "note": note }),
        );
        Ok(())
    }

    pub async fn retry_task(&self, task_id: &str) -> Result<()> {
        let task = self
            .store
            .task(task_id)?
            .ok_or_else(|| anyhow::anyhow!("任务不存在"))?;
        if let Some(room) = self.store.room(&task.room_id)? {
            if room.status == "archived" {
                bail!("会话已归档，请先恢复再操作");
            }
        }
        self.set_status(task_id, "ready", &[])?;
        self.store.emit(
            Some(&task.room_id),
            Some(task_id),
            None,
            "task.retry",
            json!({}),
        );
        self.schedule_later();
        Ok(())
    }

    pub async fn cancel_task(&self, task_id: &str) -> Result<()> {
        let pid = self
            .running
            .lock()
            .await
            .get(task_id)
            .and_then(|h| *h.pid.lock().unwrap());
        if let Some(pid) = pid {
            kill_tree(pid);
        }
        let task = self.store.task(task_id)?;
        self.set_status(task_id, "cancelled", &[])?;
        if let Some(task) = task {
            self.store.emit(
                Some(&task.room_id),
                Some(task_id),
                None,
                "task.cancelled",
                json!({}),
            );
            self.maybe_complete_room(&task.room_id)?;
        }
        Ok(())
    }

    pub async fn cancel_room_run(&self, room_id: &str) -> usize {
        let mut count = 0;
        for (_, r) in self.live_runs.lock().await.iter() {
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
        let _guard = self.merge_queue.lock().await;
        let task = self
            .store
            .task(task_id)?
            .ok_or_else(|| anyhow::anyhow!("任务不存在"))?;
        let room = self
            .store
            .room(&task.room_id)?
            .ok_or_else(|| anyhow::anyhow!("房间不存在"))?;
        if room.status == "archived" {
            bail!("会话已归档，请先恢复再合并");
        }
        if task.branch.is_empty() {
            bail!("任务还没有分支");
        }
        if task.diff_stat.trim().is_empty() {
            self.set_status(task_id, "done", &[])?;
            self.store.emit(
                Some(&room.id),
                Some(task_id),
                None,
                "task.merged",
                json!({ "branch": task.branch, "noChange": true }),
            );
            self.refresh_ready(&room.id)?;
            self.maybe_complete_room(&room.id)?;
            self.schedule_later();
            return Ok(json!({ "ok": true, "noChange": true }));
        }
        let _ = git::commit_all(
            &task.worktree,
            &format!("devhub({}): {}", task.key, task.title),
        )
        .await;
        git::merge_squash(
            &room.repo_path,
            &room.base_branch,
            &task.branch,
            &format!("devhub({}): {}", task.key, task.title),
        )
        .await?;
        self.set_status(task_id, "merged", &[])?;
        self.store.emit(
            Some(&room.id),
            Some(task_id),
            None,
            "task.merged",
            json!({ "branch": task.branch }),
        );
        self.refresh_ready(&room.id)?;
        self.maybe_complete_room(&room.id)?;
        self.schedule_later();
        Ok(json!({ "ok": true }))
    }

    pub async fn task_diff(&self, task_id: &str) -> String {
        let Ok(Some(task)) = self.store.task(task_id) else {
            return String::new();
        };
        if task.worktree.is_empty() {
            return String::new();
        }
        git::diff(&task.worktree, &task.base_sha).await
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
        let room_id = body.get("roomId").and_then(Value::as_str).unwrap_or("");
        let room = self
            .store
            .room(room_id)?
            .ok_or_else(|| anyhow::anyhow!("房间不存在"))?;
        if room.status == "archived" {
            bail!("会话已归档，请先恢复再修改");
        }
        let id = uid("t");
        let key = {
            let conn = self.store.db.lock().unwrap();
            let n: i64 = conn.query_row(
                "SELECT COUNT(*) FROM tasks WHERE room_id=?",
                params![room_id],
                |r| r.get(0),
            )?;
            format!("T{}", n + 1)
        };
        let ts = now();
        {
            let conn = self.store.db.lock().unwrap();
            conn.execute(
                "INSERT INTO tasks (id, room_id, key, title, spec, type, owner_id, status, deps_json, acceptance_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                params![
                    id,
                    room_id,
                    key,
                    body.get("title").and_then(Value::as_str).unwrap_or("新任务"),
                    body.get("spec").and_then(Value::as_str).unwrap_or(""),
                    body.get("type").and_then(Value::as_str).unwrap_or("code"),
                    body.get("ownerId").and_then(Value::as_str),
                    "backlog",
                    body.get("deps").cloned().unwrap_or(json!([])).to_string(),
                    body.get("acceptance").cloned().unwrap_or(json!([])).to_string(),
                    ts,
                    ts,
                ],
            )?;
        }
        self.store.emit(
            Some(room_id),
            Some(&id),
            None,
            "task.created",
            json!({ "title": body.get("title").and_then(Value::as_str).unwrap_or("") }),
        );
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

fn extract_json(text: &str) -> Option<Value> {
    let cleaned = text.replace("```json", "").replace("```", "");
    let start = cleaned.find('{')?;
    let end = cleaned.rfind('}')?;
    if end <= start {
        return None;
    }
    serde_json::from_str(&cleaned[start..=end]).ok()
}
