use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, Result};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::process::Command;

use crate::store::Store;

pub const WORKER_DEFS: &[(&str, &str, &str)] = &[
    ("claude", "Claude Code", "stream-json / --resume"),
    ("codex", "Codex", "exec --json"),
    ("opencode", "OpenCode", "run --format json"),
    ("agy", "Antigravity (agy)", "print / stream-json"),
    ("dsh", "DeepSeek Harness", "headless --json"),
];

pub fn is_worker(key: &str) -> bool {
    WORKER_DEFS.iter().any(|(k, _, _)| *k == key)
}

fn known_path(store: &Store, key: &str) -> Option<String> {
    let name = format!("DEVHUB_{}_PATH", key.to_uppercase());
    let env = store.worker_env();
    env.get(&name)
        .cloned()
        .or_else(|| std::env::var(&name).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn path_exists(path: &str) -> bool {
    Path::new(path).exists()
}

pub async fn detect_workers(store: &Store) -> Vec<Value> {
    let mut out = Vec::new();
    for (key, label, note) in WORKER_DEFS {
        let mut found = where_bin(key).await;
        if found.is_empty() {
            if let Some(p) = known_path(store, key) {
                if path_exists(&p) {
                    found = p;
                }
            }
        }
        out.push(json!({
            "key": key,
            "label": label,
            "note": note,
            "available": !found.is_empty(),
            "path": found,
        }));
    }
    out
}

async fn where_bin(bin: &str) -> String {
    let cmd_name = if cfg!(windows) { "where.exe" } else { "which" };
    let mut cmd = Command::new(cmd_name);
    cmd.arg(bin);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.as_std_mut().creation_flags(0x08000000);
    }
    let Ok(out) = cmd.output().await else {
        return String::new();
    };
    if !out.status.success() {
        return String::new();
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let lines = text
        .lines()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>();
    if cfg!(windows) {
        lines
            .iter()
            .find(|l| {
                let lower = l.to_lowercase();
                lower.ends_with(".exe") || lower.ends_with(".cmd") || lower.ends_with(".bat")
            })
            .cloned()
            .or_else(|| lines.first().cloned())
            .unwrap_or_default()
    } else {
        lines.first().cloned().unwrap_or_default()
    }
}

fn get_worker_path(store: &Store, key: &str) -> String {
    if let Some(p) = known_path(store, key) {
        if path_exists(&p) {
            return p;
        }
    }
    key.to_string()
}

fn cmd_quote(s: &str) -> String {
    let v = s.replace('"', "");
    if v.is_empty() {
        return "\"\"".to_string();
    }
    if !v
        .chars()
        .any(|c| c.is_whitespace() || "&|<>^()%!".contains(c))
    {
        return v;
    }
    format!("\"{}\"", v)
}

fn write_launcher(store: &Store, run_id: &str, exe: &str, args: &[String]) -> Result<PathBuf> {
    let file = store.prompts.join(format!("{}.cmd", run_id));
    let mut parts = vec![cmd_quote(exe)];
    parts.extend(args.iter().map(|a| cmd_quote(a)));
    let line = parts.join(" ");
    std::fs::write(&file, format!("@echo off\r\n{}\r\n", line))?;
    Ok(file)
}

fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for c2 in chars.by_ref() {
                    if c2.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            continue;
        }
        if c != '\r' {
            out.push(c);
        }
    }
    out
}

fn brief(v: &Value, n: usize) -> String {
    let s = match v {
        Value::String(s) => s.clone(),
        Value::Object(map) => {
            let keys = [
                "command",
                "cmd",
                "file_path",
                "path",
                "pattern",
                "url",
                "description",
            ];
            let mut found = None;
            for k in keys {
                if let Some(Value::String(s)) = map.get(k) {
                    found = Some(s.clone());
                    break;
                }
            }
            found.unwrap_or_else(|| v.to_string())
        }
        Value::Null => String::new(),
        other => other.to_string(),
    };
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut out = s.chars().take(n).collect::<String>();
    if s.chars().count() > n {
        out.push('…');
    }
    out
}

#[derive(Default)]
struct Acc {
    text: String,
    final_text: String,
    session: String,
    usage: Option<Value>,
    cost: Option<f64>,
    errors: Vec<String>,
    activity: Vec<String>,
    stderr: String,
    last_activity: String,
}

fn push_err(acc: &mut Acc, v: &Value) {
    let msg = v
        .get("message")
        .and_then(Value::as_str)
        .map(|s| s.to_string())
        .unwrap_or_else(|| v.to_string());
    acc.errors.push(msg.chars().take(800).collect());
}

fn handle_claude_like(obj: &Value, acc: &mut Acc) {
    if let Some(s) = obj.get("session_id").and_then(Value::as_str) {
        acc.session = s.to_string();
    }
    let ty = obj.get("type").and_then(Value::as_str).unwrap_or("");
    if ty == "system" && obj.get("subtype").and_then(Value::as_str) == Some("init") {
        acc.activity.push(format!(
            "session {}",
            obj.get("session_id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .chars()
                .take(8)
                .collect::<String>()
        ));
        acc.last_activity = "会话已建立".to_string();
    }
    if ty == "assistant" {
        if let Some(content) = obj
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(Value::as_array)
        {
            for c in content {
                match c.get("type").and_then(Value::as_str).unwrap_or("") {
                    "text" => {
                        if let Some(t) = c.get("text").and_then(Value::as_str) {
                            acc.text.push_str(t);
                            acc.text.push('\n');
                            acc.last_activity = brief(&Value::String(t.to_string()), 100);
                        }
                    }
                    "tool_use" => {
                        let name = c.get("name").and_then(Value::as_str).unwrap_or("tool");
                        acc.activity.push(format!("tool {}", name));
                        let input = c.get("input").cloned().unwrap_or(Value::Null);
                        acc.last_activity = format!("{} {}", name, brief(&input, 100))
                            .trim()
                            .to_string();
                    }
                    _ => {}
                }
            }
        }
    }
    if ty == "result" {
        if let Some(s) = obj.get("result").and_then(Value::as_str) {
            if !s.trim().is_empty() {
                acc.final_text = s.to_string();
            }
        }
        if let Some(u) = obj.get("usage") {
            acc.usage = Some(u.clone());
        }
        if let Some(c) = obj.get("total_cost_usd").and_then(Value::as_f64) {
            acc.cost = Some(c);
        }
    }
    if ty == "error" {
        push_err(acc, obj);
    }
}

fn handle_codex(obj: &Value, acc: &mut Acc) {
    let ty = obj.get("type").and_then(Value::as_str).unwrap_or("");
    if ty == "thread.started" {
        if let Some(id) = obj.get("thread_id").and_then(Value::as_str) {
            acc.session = id.to_string();
        }
    }
    if ty == "item.completed" {
        if let Some(item) = obj.get("item") {
            match item.get("type").and_then(Value::as_str).unwrap_or("") {
                "agent_message" => {
                    if let Some(t) = item.get("text").and_then(Value::as_str) {
                        acc.text.push_str(t);
                        acc.text.push('\n');
                        acc.last_activity = brief(&Value::String(t.to_string()), 100);
                    }
                }
                "command_execution" => {
                    let cmd = item
                        .get("command")
                        .and_then(Value::as_str)
                        .or_else(|| item.get("command_line").and_then(Value::as_str))
                        .unwrap_or("");
                    acc.activity
                        .push(format!("$ {}", cmd.chars().take(160).collect::<String>()));
                    acc.last_activity =
                        format!("$ {}", brief(&Value::String(cmd.to_string()), 100));
                }
                "file_change" => {
                    let p = item
                        .get("path")
                        .and_then(Value::as_str)
                        .or_else(|| item.get("file").and_then(Value::as_str))
                        .unwrap_or("");
                    acc.activity
                        .push(format!("± {}", p.chars().take(160).collect::<String>()));
                    acc.last_activity =
                        format!("修改 {}", brief(&Value::String(p.to_string()), 100));
                }
                _ => {}
            }
        }
    }
    if ty == "turn.completed" {
        if let Some(u) = obj.get("usage") {
            acc.usage = Some(u.clone());
        }
    }
    if ty == "error" {
        push_err(acc, obj);
    }
}

fn handle_tolerant(obj: &Value, acc: &mut Acc) {
    if !obj.is_object() {
        return;
    }
    for k in [
        "sessionID",
        "session_id",
        "thread_id",
        "threadId",
        "conversationId",
    ] {
        if let Some(s) = obj.get(k).and_then(Value::as_str) {
            if !s.is_empty() {
                acc.session = s.to_string();
            }
        }
    }
    let ty = obj.get("type").and_then(Value::as_str).unwrap_or("");
    if ty == "tool_use" {
        if let Some(part) = obj.get("part") {
            if let Some(tool) = part.get("tool").and_then(Value::as_str) {
                acc.activity.push(format!("tool {}", tool));
                let input = part
                    .get("state")
                    .and_then(|s| s.get("input"))
                    .cloned()
                    .unwrap_or(Value::Null);
                acc.last_activity = format!("{} {}", tool, brief(&input, 100))
                    .trim()
                    .to_string();
                if part
                    .get("state")
                    .and_then(|s| s.get("status"))
                    .and_then(Value::as_str)
                    == Some("error")
                {
                    let e = part
                        .get("state")
                        .and_then(|s| s.get("error"))
                        .cloned()
                        .unwrap_or(Value::Null);
                    acc.errors
                        .push(format!("{} failed: {}", tool, brief(&e, 300)));
                }
                return;
            }
        }
    }
    if ty == "step_start" {
        acc.last_activity = "思考中…".to_string();
        return;
    }
    if ty == "step_finish" {
        if let Some(tokens) = obj.get("part").and_then(|p| p.get("tokens")) {
            acc.usage = Some(tokens.clone());
        }
        if let Some(c) = obj
            .get("part")
            .and_then(|p| p.get("cost"))
            .and_then(Value::as_f64)
        {
            acc.cost = Some(acc.cost.unwrap_or(0.0) + c);
        }
        return;
    }
    let direct = obj
        .get("text")
        .or_else(|| obj.get("delta"))
        .or_else(|| obj.get("output"));
    if let Some(Value::String(s)) = direct {
        if !s.is_empty() {
            acc.text.push_str(s);
            if ty == "tool" {
                acc.activity
                    .push(format!("tool {}", s.chars().take(80).collect::<String>()));
            }
            acc.last_activity = brief(&Value::String(s.clone()), 100);
        }
    } else if let Some(Value::String(s)) = obj.get("part").and_then(|p| p.get("text")) {
        acc.text.push_str(s);
        acc.last_activity = brief(&Value::String(s.clone()), 100);
    } else if let Some(Value::String(s)) = obj.get("message") {
        acc.text.push_str(s);
        acc.text.push('\n');
        acc.last_activity = brief(&Value::String(s.clone()), 100);
    } else if let Some(Value::String(s)) = obj.get("content") {
        acc.text.push_str(s);
        acc.last_activity = brief(&Value::String(s.clone()), 100);
    }
    if let Some(u) = obj.get("usage") {
        acc.usage = Some(u.clone());
    }
    if ty == "error" {
        push_err(acc, obj);
    }
}

fn handle_dsh(obj: &Value, acc: &mut Acc) {
    let ty = obj.get("type").and_then(Value::as_str).unwrap_or("");
    if ty == "session" {
        if let Some(s) = obj.get("sessionId").and_then(Value::as_str) {
            acc.session = s.to_string();
        }
    }
    if ty == "text" {
        if let Some(s) = obj.get("text").and_then(Value::as_str) {
            acc.text.push_str(s);
            acc.text.push('\n');
            acc.last_activity = brief(&Value::String(s.to_string()), 100);
        }
    }
    if ty == "tool_call" {
        if let Some(tool) = obj.get("tool").and_then(Value::as_str) {
            acc.activity.push(format!("tool {}", tool));
            let input = obj.get("input").cloned().unwrap_or(Value::Null);
            acc.last_activity = format!("{} {}", tool, brief(&input, 100))
                .trim()
                .to_string();
        }
    }
    if ty == "final" {
        if let Some(s) = obj.get("text").and_then(Value::as_str) {
            if !s.trim().is_empty() {
                acc.final_text = s.to_string();
            }
        }
    }
    if ty == "status" {
        match obj.get("phase").and_then(Value::as_str).unwrap_or("") {
            "step_start" => acc.last_activity = "思考中…".to_string(),
            "step_end" => {
                if let Some(u) = obj.get("usage") {
                    acc.usage = Some(u.clone());
                }
            }
            "turn_end" => {
                if obj
                    .get("reason")
                    .and_then(|r| r.get("kind"))
                    .and_then(Value::as_str)
                    == Some("error")
                {
                    let e = obj
                        .get("reason")
                        .and_then(|r| r.get("error"))
                        .cloned()
                        .unwrap_or(Value::Null);
                    push_err(acc, &e);
                }
            }
            _ => {}
        }
    }
    if ty == "error" {
        push_err(acc, obj);
    }
}

fn handle(worker: &str, obj: &Value, acc: &mut Acc) {
    match worker {
        "claude" | "agy" => handle_claude_like(obj, acc),
        "codex" => handle_codex(obj, acc),
        "dsh" => handle_dsh(obj, acc),
        _ => handle_tolerant(obj, acc),
    }
}

fn build_command(
    store: &Store,
    worker: &str,
    instruction: &str,
    model: &str,
    auto_approve: bool,
) -> (String, Vec<String>) {
    let exe = get_worker_path(store, worker);
    let mut args: Vec<String> = Vec::new();
    match worker {
        "claude" => {
            args.extend(
                [
                    "-p",
                    instruction,
                    "--output-format",
                    "stream-json",
                    "--verbose",
                ]
                .map(String::from),
            );
            args.push("--permission-mode".into());
            args.push(
                if auto_approve {
                    "bypassPermissions"
                } else {
                    "acceptEdits"
                }
                .into(),
            );
            if !auto_approve {
                args.extend(["--permission-prompts", "none"].map(String::from));
            }
            if !model.is_empty() {
                args.extend(["--model".to_string(), model.to_string()]);
            }
        }
        "codex" => {
            args.extend(["exec", "--json", "--skip-git-repo-check"].map(String::from));
            if auto_approve {
                args.push("--dangerously-bypass-approvals-and-sandbox".into());
            } else {
                args.extend(["-s", "workspace-write"].map(String::from));
            }
            if !model.is_empty() {
                args.extend(["-m".to_string(), model.to_string()]);
            }
            args.push(instruction.to_string());
        }
        "opencode" => {
            args.extend(["run", "--format", "json"].map(String::from));
            if auto_approve {
                args.push("--auto".into());
            }
            if !model.is_empty() {
                args.extend(["--model".to_string(), model.to_string()]);
            }
            args.push(instruction.to_string());
        }
        "agy" => {
            args.extend(["-p", instruction, "--output-format", "stream-json"].map(String::from));
            if auto_approve {
                args.push("--dangerously-skip-permissions".into());
            }
            if !model.is_empty() {
                args.extend(["--model".to_string(), model.to_string()]);
            }
        }
        "dsh" => {
            args.extend(["--profile", "headless", "--json"].map(String::from));
            args.push(instruction.to_string());
        }
        _ => {
            args.push(instruction.to_string());
        }
    }
    (exe, args)
}

pub struct WorkerOpts {
    pub store: Store,
    pub worker: String,
    pub model: String,
    pub auto_approve: bool,
    pub cwd: String,
    pub prompt: String,
    pub run_id: String,
    pub room_id: Option<String>,
    pub task_id: Option<String>,
    pub actor: Option<Value>,
    pub timeout: Duration,
    pub pid_slot: Arc<Mutex<Option<u32>>>,
    pub cancel: Arc<AtomicBool>,
}

#[allow(dead_code)]
pub struct WorkerResult {
    pub code: i32,
    pub error: String,
    pub text: String,
    pub session: String,
    pub usage: Option<Value>,
    pub cost: Option<f64>,
    pub errors: Vec<String>,
    pub log_path: String,
    pub prompt_path: String,
}

fn append_log(path: &Path, prefix: &str, line: &str) {
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{}{}", prefix, line);
    }
}

async fn read_stream<R: AsyncRead + Unpin>(
    reader: R,
    prefix: &'static str,
    store: Store,
    worker: String,
    room_id: Option<String>,
    task_id: Option<String>,
    run_id: String,
    actor: Option<Value>,
    log_path: PathBuf,
    acc: Arc<Mutex<Acc>>,
) {
    let mut lines = BufReader::new(reader).lines();
    loop {
        match lines.next_line().await {
            Ok(Some(line)) => {
                let raw = strip_ansi(&line).trim_end().to_string();
                if raw.is_empty() {
                    continue;
                }
                append_log(&log_path, prefix, &raw);
                let parsed = if raw.starts_with('{') || raw.starts_with('[') {
                    serde_json::from_str::<Value>(&raw).ok()
                } else {
                    None
                };
                {
                    let mut a = acc.lock().unwrap();
                    if let Some(obj) = &parsed {
                        handle(&worker, obj, &mut a);
                    } else if prefix == "err" {
                        a.stderr.push_str(&raw);
                        a.stderr.push('\n');
                        if a.stderr.len() > 4000 {
                            let keep = a.stderr.len() - 4000;
                            a.stderr = a.stderr.split_off(keep);
                        }
                        a.last_activity = brief(&Value::String(raw.clone()), 120);
                    }
                }
                let activity = acc.lock().unwrap().last_activity.clone();
                store.log(
                    room_id.as_deref(),
                    task_id.as_deref(),
                    &run_id,
                    &raw,
                    prefix,
                    &activity,
                    actor.clone(),
                );
            }
            Ok(None) => break,
            Err(_) => break,
        }
    }
}

pub async fn run_worker(opts: WorkerOpts) -> Result<WorkerResult> {
    let prompt_path = opts.store.prompts.join(format!("{}.md", opts.run_id));
    let log_path = opts.store.logs.join(format!("{}.log", opts.run_id));
    std::fs::write(&prompt_path, &opts.prompt)?;
    std::fs::write(&log_path, b"")?;

    if opts.cancel.load(Ordering::SeqCst) {
        return Ok(WorkerResult {
            code: -3,
            error: "已取消".into(),
            text: String::new(),
            session: String::new(),
            usage: None,
            cost: None,
            errors: Vec::new(),
            log_path: log_path.to_string_lossy().to_string(),
            prompt_path: prompt_path.to_string_lossy().to_string(),
        });
    }

    let instruction = format!(
        "Read the task file at {} and carry it out exactly. Do not ask questions.",
        prompt_path.to_string_lossy()
    );
    let (exe, args) = build_command(
        &opts.store,
        &opts.worker,
        &instruction,
        &opts.model,
        opts.auto_approve,
    );
    let launcher = write_launcher(&opts.store, &opts.run_id, &exe, &args)?;

    let mut cmd = Command::new(if cfg!(windows) { "cmd.exe" } else { "sh" });
    if cfg!(windows) {
        cmd.arg("/d").arg("/c").arg(&launcher);
    } else {
        cmd.arg(&launcher);
    }
    cmd.current_dir(&opts.cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .envs(opts.store.worker_env())
        .env("NO_COLOR", "1")
        .env("FORCE_COLOR", "0")
        .env("CI", "1");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.as_std_mut().creation_flags(0x08000000);
    }
    let mut child = cmd.spawn().context("启动 worker 失败")?;
    let pid = child.id();
    *opts.pid_slot.lock().unwrap() = pid;
    if opts.cancel.load(Ordering::SeqCst) {
        if let Some(p) = pid {
            kill_tree(p);
        }
    }

    let stdout = child.stdout.take().context("worker stdout 不可用")?;
    let stderr = child.stderr.take().context("worker stderr 不可用")?;
    let acc = Arc::new(Mutex::new(Acc::default()));
    let t1 = tokio::spawn(read_stream(
        stdout,
        "out",
        opts.store.clone(),
        opts.worker.clone(),
        opts.room_id.clone(),
        opts.task_id.clone(),
        opts.run_id.clone(),
        opts.actor.clone(),
        log_path.clone(),
        acc.clone(),
    ));
    let t2 = tokio::spawn(read_stream(
        stderr,
        "err",
        opts.store.clone(),
        opts.worker.clone(),
        opts.room_id.clone(),
        opts.task_id.clone(),
        opts.run_id.clone(),
        opts.actor.clone(),
        log_path.clone(),
        acc.clone(),
    ));

    let mut code;
    let mut error = String::new();
    match tokio::time::timeout(opts.timeout, child.wait()).await {
        Ok(Ok(status)) => {
            code = status.code().unwrap_or(-1);
        }
        Ok(Err(e)) => {
            code = -1;
            error = e.to_string();
        }
        Err(_) => {
            if let Some(p) = pid {
                kill_tree(p);
            }
            let _ = child.wait().await;
            code = -2;
            error = "超时".to_string();
        }
    }
    let _ = t1.await;
    let _ = t2.await;
    if opts.cancel.load(Ordering::SeqCst) {
        code = -3;
        error = "已取消".to_string();
    }

    let a = acc.lock().unwrap();
    let text = if a.final_text.trim().is_empty() {
        a.text.trim().to_string()
    } else {
        a.final_text.trim().to_string()
    };
    if code != 0 && error.is_empty() {
        error = a
            .errors
            .first()
            .cloned()
            .or_else(|| {
                a.stderr
                    .lines()
                    .filter(|l| !l.trim().is_empty())
                    .last()
                    .map(|s| s.to_string())
            })
            .unwrap_or_default();
        error = error.chars().take(1200).collect();
    }
    Ok(WorkerResult {
        code,
        error,
        text,
        session: a.session.clone(),
        usage: a.usage.clone(),
        cost: a.cost,
        errors: a.errors.clone(),
        log_path: log_path.to_string_lossy().to_string(),
        prompt_path: prompt_path.to_string_lossy().to_string(),
    })
}

pub fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut cmd = std::process::Command::new("taskkill");
        cmd.args(["/pid", &pid.to_string(), "/T", "/F"]);
        cmd.creation_flags(0x08000000);
        let _ = cmd.output();
    }
    #[cfg(not(windows))]
    {
        let _ = std::process::Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .output();
    }
}
