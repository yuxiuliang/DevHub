use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use tokio::sync::broadcast;

use crate::models::{
    member_payload, now, room_payload, safe_json, task_payload, Decision, Member, Review, Room,
    Task,
};

#[derive(Clone)]
pub struct Store {
    pub db: Arc<Mutex<Connection>>,
    pub data: PathBuf,
    pub prompts: PathBuf,
    pub logs: PathBuf,
    pub worktrees: PathBuf,
    pub bus: broadcast::Sender<Value>,
}

impl Store {
    pub fn open(data: PathBuf) -> Result<Self> {
        let prompts = data.join("prompts");
        let logs = data.join("logs");
        let worktrees = data.join("worktrees");
        for d in [&data, &prompts, &logs, &worktrees] {
            fs::create_dir_all(d).with_context(|| format!("创建目录失败：{}", d.display()))?;
        }
        let db = Connection::open(data.join("devhub.db"))
            .with_context(|| format!("打开数据库失败：{}", data.join("devhub.db").display()))?;
        db.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA busy_timeout=5000;
             CREATE TABLE IF NOT EXISTS rooms (
               id TEXT PRIMARY KEY,
               name TEXT NOT NULL,
               requirement TEXT NOT NULL DEFAULT '',
               repo_path TEXT NOT NULL,
               base_branch TEXT NOT NULL DEFAULT '',
               flow_json TEXT NOT NULL DEFAULT '{}',
               plan_json TEXT NOT NULL DEFAULT '',
               status TEXT NOT NULL DEFAULT 'draft',
               mode TEXT NOT NULL DEFAULT 'parallel',
               auto_approve INTEGER NOT NULL DEFAULT 1,
               planner_id TEXT,
               reviewer_id TEXT,
               created_at TEXT NOT NULL,
               updated_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS members (
               id TEXT PRIMARY KEY,
               room_id TEXT NOT NULL,
               name TEXT NOT NULL,
               worker TEXT NOT NULL,
               role_name TEXT DEFAULT '',
               role_brief TEXT DEFAULT '',
               model TEXT DEFAULT '',
               concurrency INTEGER NOT NULL DEFAULT 1,
               enabled INTEGER NOT NULL DEFAULT 1,
               sort INTEGER NOT NULL DEFAULT 0
             );
             CREATE TABLE IF NOT EXISTS tasks (
               id TEXT PRIMARY KEY,
               room_id TEXT NOT NULL,
               key TEXT NOT NULL,
               title TEXT NOT NULL,
               spec TEXT NOT NULL DEFAULT '',
               type TEXT NOT NULL DEFAULT 'code',
               owner_id TEXT,
               phase_id TEXT,
               status TEXT NOT NULL DEFAULT 'backlog',
               deps_json TEXT NOT NULL DEFAULT '[]',
               acceptance_json TEXT NOT NULL DEFAULT '[]',
               worktree TEXT DEFAULT '',
               branch TEXT DEFAULT '',
               base_sha TEXT DEFAULT '',
               feedback TEXT DEFAULT '',
               summary TEXT DEFAULT '',
               diff_stat TEXT DEFAULT '',
               created_at TEXT NOT NULL,
               updated_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS runs (
               id TEXT PRIMARY KEY,
               task_id TEXT NOT NULL,
               member_id TEXT NOT NULL,
               status TEXT NOT NULL,
               session_id TEXT DEFAULT '',
               exit_code INTEGER,
               log_path TEXT DEFAULT '',
               error TEXT DEFAULT '',
               started_at TEXT NOT NULL,
               ended_at TEXT
             );
             CREATE TABLE IF NOT EXISTS events (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               room_id TEXT,
               task_id TEXT,
               run_id TEXT,
               type TEXT NOT NULL,
               payload TEXT NOT NULL DEFAULT '{}',
               created_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS decisions (
               id TEXT PRIMARY KEY,
               room_id TEXT NOT NULL,
               text TEXT NOT NULL,
               rationale TEXT DEFAULT '',
               status TEXT NOT NULL DEFAULT 'active',
               created_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS reviews (
               id TEXT PRIMARY KEY,
               task_id TEXT NOT NULL,
               round INTEGER NOT NULL DEFAULT 1,
               verdict TEXT NOT NULL,
               payload TEXT NOT NULL DEFAULT '{}',
               created_at TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_tasks_room ON tasks(room_id);
             CREATE INDEX IF NOT EXISTS idx_events_room ON events(room_id, id);",
        )
        .context("初始化数据库 schema 失败")?;
        let (bus, _) = broadcast::channel(2048);
        Ok(Self {
            db: Arc::new(Mutex::new(db)),
            data,
            prompts,
            logs,
            worktrees,
            bus,
        })
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Value> {
        self.bus.subscribe()
    }

    /// 本地运行时环境变量：.data/env.json，不落库、不打印。
    pub fn worker_env(&self) -> HashMap<String, String> {
        let file = self.data.join("env.json");
        let Ok(text) = fs::read_to_string(file) else {
            return HashMap::new();
        };
        let Ok(Value::Object(map)) = serde_json::from_str::<Value>(&text) else {
            return HashMap::new();
        };
        let mut out = HashMap::new();
        for (k, v) in map {
            if !valid_env_key(&k) {
                continue;
            }
            if let Value::String(s) = v {
                out.insert(k, s);
            }
        }
        out
    }

    pub fn emit(
        &self,
        room_id: Option<&str>,
        task_id: Option<&str>,
        run_id: Option<&str>,
        type_: &str,
        payload: Value,
    ) {
        let created = now();
        let id = {
            let conn = self.db.lock().unwrap();
            let _ = conn.execute(
                "INSERT INTO events (room_id, task_id, run_id, type, payload, created_at) VALUES (?,?,?,?,?,?)",
                params![room_id, task_id, run_id, type_, payload.to_string(), created],
            );
            conn.last_insert_rowid()
        };
        let ev = json!({
            "kind": "event",
            "id": id,
            "room_id": room_id,
            "task_id": task_id,
            "run_id": run_id,
            "type": type_,
            "payload": payload,
            "created_at": created,
        });
        let _ = self.bus.send(ev);
    }

    pub fn log(
        &self,
        room_id: Option<&str>,
        task_id: Option<&str>,
        run_id: &str,
        line: &str,
        stream: &str,
        activity: &str,
        actor: Option<Value>,
    ) {
        let ev = json!({
            "kind": "log",
            "roomId": room_id,
            "taskId": task_id,
            "runId": run_id,
            "line": line,
            "stream": stream,
            "activity": activity,
            "actor": actor,
            "at": now(),
        });
        let _ = self.bus.send(ev);
    }

    pub fn room(&self, id: &str) -> Result<Option<Room>> {
        let conn = self.db.lock().unwrap();
        let mut stmt = conn.prepare("SELECT * FROM rooms WHERE id=?")?;
        let row = stmt.query_row(params![id], Room::from_row).optional()?;
        Ok(row)
    }

    pub fn member(&self, id: &str) -> Result<Option<Member>> {
        let conn = self.db.lock().unwrap();
        let mut stmt = conn.prepare("SELECT * FROM members WHERE id=?")?;
        let row = stmt.query_row(params![id], Member::from_row).optional()?;
        Ok(row)
    }

    pub fn task(&self, id: &str) -> Result<Option<Task>> {
        let conn = self.db.lock().unwrap();
        let mut stmt = conn.prepare("SELECT * FROM tasks WHERE id=?")?;
        let row = stmt.query_row(params![id], Task::from_row).optional()?;
        Ok(row)
    }

    pub fn members(&self, room_id: &str) -> Result<Vec<Member>> {
        let conn = self.db.lock().unwrap();
        let mut stmt = conn.prepare("SELECT * FROM members WHERE room_id=? ORDER BY sort, name")?;
        let rows = stmt.query_map(params![room_id], Member::from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn tasks(&self, room_id: &str) -> Result<Vec<Task>> {
        let conn = self.db.lock().unwrap();
        let mut stmt = conn.prepare("SELECT * FROM tasks WHERE room_id=? ORDER BY created_at")?;
        let rows = stmt.query_map(params![room_id], Task::from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn decisions(&self, room_id: &str) -> Result<Vec<Decision>> {
        let conn = self.db.lock().unwrap();
        let mut stmt =
            conn.prepare("SELECT * FROM decisions WHERE room_id=? ORDER BY created_at")?;
        let rows = stmt.query_map(params![room_id], Decision::from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn active_decisions(&self, room_id: &str) -> Result<Vec<Decision>> {
        let conn = self.db.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT * FROM decisions WHERE room_id=? AND status='active' ORDER BY created_at",
        )?;
        let rows = stmt.query_map(params![room_id], Decision::from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn reviews(&self, room_id: &str) -> Result<Vec<Review>> {
        let conn = self.db.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT rv.* FROM reviews rv JOIN tasks t ON t.id = rv.task_id WHERE t.room_id=? ORDER BY rv.created_at",
        )?;
        let rows = stmt.query_map(params![room_id], Review::from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn review_count(&self, task_id: &str) -> Result<i64> {
        let conn = self.db.lock().unwrap();
        let n: i64 = conn.query_row(
            "SELECT COUNT(*) FROM reviews WHERE task_id=?",
            params![task_id],
            |r| r.get(0),
        )?;
        Ok(n)
    }

    pub fn events(&self, room_id: &str) -> Result<Vec<Value>> {
        let conn = self.db.lock().unwrap();
        let mut stmt =
            conn.prepare("SELECT * FROM events WHERE room_id=? ORDER BY id DESC LIMIT 200")?;
        let rows = stmt.query_map(params![room_id], |row| {
            let payload: String = row.get("payload")?;
            Ok(json!({
                "id": row.get::<_, i64>("id")?,
                "room_id": row.get::<_, Option<String>>("room_id")?,
                "task_id": row.get::<_, Option<String>>("task_id")?,
                "run_id": row.get::<_, Option<String>>("run_id")?,
                "type": row.get::<_, String>("type")?,
                "payload": safe_json(&payload, json!({})),
                "created_at": row.get::<_, String>("created_at")?,
            }))
        })?;
        let mut out = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        out.reverse();
        Ok(out)
    }

    pub fn list_rooms(&self) -> Result<Vec<Value>> {
        let rooms = {
            let conn = self.db.lock().unwrap();
            let mut stmt = conn.prepare("SELECT * FROM rooms ORDER BY created_at DESC")?;
            let rows = stmt.query_map([], Room::from_row)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        let mut out = Vec::new();
        for r in rooms {
            let tasks = self.tasks(&r.id)?;
            let total = tasks.len() as i64;
            let running = tasks.iter().filter(|t| t.status == "running").count() as i64;
            let review = tasks
                .iter()
                .filter(|t| {
                    ["review", "changes_requested", "approved"].contains(&t.status.as_str())
                })
                .count() as i64;
            let done = tasks
                .iter()
                .filter(|t| ["merged", "done"].contains(&t.status.as_str()))
                .count() as i64;
            let failed = tasks
                .iter()
                .filter(|t| ["failed", "escalated"].contains(&t.status.as_str()))
                .count() as i64;
            let mut v = room_payload(&r);
            v["counts"] = json!({ "total": total, "running": running, "review": review, "done": done, "failed": failed });
            out.push(v);
        }
        Ok(out)
    }

    pub fn room_state(&self, room_id: &str, running: Vec<String>) -> Result<Option<Value>> {
        let Some(room) = self.room(room_id)? else {
            return Ok(None);
        };
        let members = self.members(room_id)?;
        let tasks = self.tasks(room_id)?;
        let decisions = self.decisions(room_id)?;
        let reviews = self.reviews(room_id)?;
        let events = self.events(room_id)?;
        Ok(Some(json!({
            "room": room_payload(&room),
            "members": members.iter().map(member_payload).collect::<Vec<_>>(),
            "tasks": tasks.iter().map(task_payload).collect::<Vec<_>>(),
            "decisions": decisions.iter().map(|d| json!({
                "id": d.id,
                "room_id": d.room_id,
                "text": d.text,
                "rationale": d.rationale,
                "status": d.status,
                "created_at": d.created_at,
            })).collect::<Vec<_>>(),
            "reviews": reviews.iter().map(|r| json!({
                "id": r.id,
                "task_id": r.task_id,
                "round": r.round,
                "verdict": r.verdict,
                "payload": safe_json(&r.payload, json!({})),
                "created_at": r.created_at,
            })).collect::<Vec<_>>(),
            "events": events,
            "running": running,
        })))
    }
}

fn valid_env_key(k: &str) -> bool {
    let mut chars = k.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}
