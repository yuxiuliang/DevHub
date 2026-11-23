use std::fs::{File, Metadata, OpenOptions};
use std::io::{self, Read};
use std::path::Path;

use anyhow::Result;
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use serde_json::Value;

use crate::store::Store;

const MAX_PROMPT_BYTES: u64 = 262_144;
const RUN_LIMIT: usize = 50;
const READ_ERROR: &str = "无法读取本次运行的执行输入，请重试。";
const INVALID_RUN_ID: &str = "运行标识无效，无法读取执行输入。";
const CHANGED_INPUT: &str = "执行输入文件在读取时发生变化，请刷新后重试。";

#[derive(Debug)]
pub(crate) struct InputsError;

impl std::fmt::Display for InputsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("任务或指定的运行记录不存在，请刷新后重试")
    }
}

impl std::error::Error for InputsError {}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InputRun {
    run_id: String,
    status: String,
    exit_code: Option<i64>,
    started_at: Option<String>,
    ended_at: Option<String>,
    /// Stored as-is with the run; only the selected run's snapshot is exposed.
    #[serde(skip)]
    flow_json: String,
}

impl InputRun {
    fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            run_id: row.get(0)?,
            status: row.get(1)?,
            exit_code: row.get(2)?,
            started_at: row.get(3)?,
            ended_at: row.get(4)?,
            flow_json: row.get(5)?,
        })
    }
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskInputs {
    prompt: String,
    run_id: Option<String>,
    status: String,
    exit_code: Option<i64>,
    started_at: Option<String>,
    ended_at: Option<String>,
    available: bool,
    truncated: bool,
    total_bytes: u64,
    read_error: String,
    runs: Vec<InputRun>,
    runs_truncated: bool,
    flow: Option<Value>,
}

pub(crate) fn read(store: &Store, task_id: &str, selected_run: Option<&str>) -> Result<TaskInputs> {
    let (mut runs, selected) = {
        let conn = store.db.lock().unwrap();
        let exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM tasks WHERE id=?)", [task_id], |row| row.get(0),
        )?;
        if !exists {
            return Err(InputsError.into());
        }
        let mut stmt = conn.prepare(
            "SELECT id,status,exit_code,started_at,ended_at,flow_json FROM runs
             WHERE task_id=? ORDER BY started_at DESC,rowid DESC LIMIT 51",
        )?;
        let rows = stmt.query_map([task_id], InputRun::from_row)?;
        let runs = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        let selected = if let Some(run_id) = selected_run {
            if run_id.is_empty() {
                return Err(InputsError.into());
            }
            Some(conn.query_row(
                "SELECT id,status,exit_code,started_at,ended_at,flow_json FROM runs WHERE task_id=? AND id=?",
                params![task_id, run_id], InputRun::from_row,
            ).optional()?.ok_or(InputsError)?)
        } else {
            runs.first().cloned()
        };
        (runs, selected)
    };
    let runs_truncated = runs.len() > RUN_LIMIT;
    runs.truncate(RUN_LIMIT);
    let mut response = TaskInputs { runs, runs_truncated, ..TaskInputs::default() };
    let Some(selected) = selected else { return Ok(response) };
    response.run_id = Some(selected.run_id.clone());
    response.status = selected.status;
    response.exit_code = selected.exit_code;
    response.started_at = selected.started_at;
    response.ended_at = selected.ended_at;
    response.flow = flow_snapshot(&selected.flow_json);
    if selected.run_id.is_empty()
        || !selected.run_id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        response.read_error = INVALID_RUN_ID.into();
        return Ok(response);
    }
    let path = store.prompts.join(format!("{}.md", selected.run_id));
    match read_prompt(&path, &mut response) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => {
            response.prompt.clear();
            response.available = false;
            response.read_error = if error.kind() == io::ErrorKind::Interrupted { CHANGED_INPUT } else { READ_ERROR }.into();
        }
    }
    Ok(response)
}

/// A snapshot is only exposed when the stored text is a JSON object.
/// Legacy empty values, broken JSON and non-object JSON are all "no snapshot".
fn flow_snapshot(flow_json: &str) -> Option<Value> {
    match serde_json::from_str::<Value>(flow_json) {
        Ok(flow @ Value::Object(_)) => Some(flow),
        _ => None,
    }
}

fn regular_file(metadata: &Metadata) -> bool {
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return false;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 { return false; }
    }
    true
}

fn unchanged(before: &Metadata, after: &Metadata) -> io::Result<bool> {
    if !regular_file(after) || before.len() != after.len() || before.modified()? != after.modified()? {
        return Ok(false);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if before.dev() != after.dev() || before.ino() != after.ino() { return Ok(false); }
    }
    Ok(true)
}

fn open_prompt(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000); // FILE_FLAG_OPEN_REPARSE_POINT
    }
    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(0x20000 | 0x800); // O_NOFOLLOW | O_NONBLOCK
    }
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(0x100 | 0x4); // O_NOFOLLOW | O_NONBLOCK
    }
    options.open(path)
}

fn read_prompt(path: &Path, response: &mut TaskInputs) -> io::Result<()> {
    let before = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            // Windows also reports a non-directory parent as ERROR_PATH_NOT_FOUND.
            if let Some(parent) = path.parent() {
                match std::fs::symlink_metadata(parent) {
                    Ok(metadata) if !metadata.is_dir() || metadata.file_type().is_symlink() => {
                        return Err(io::ErrorKind::InvalidInput.into());
                    }
                    Err(parent_error) if parent_error.kind() != io::ErrorKind::NotFound => return Err(parent_error),
                    _ => {}
                }
            }
            return Err(error);
        }
        Err(error) => return Err(error),
    };
    if !regular_file(&before) {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    response.total_bytes = before.len();
    response.truncated = before.len() > MAX_PROMPT_BYTES;
    let mut file = open_prompt(path)?;
    let opened = file.metadata()?;
    if !unchanged(&before, &opened)? {
        return Err(io::ErrorKind::Interrupted.into());
    }
    let length = opened.len().min(MAX_PROMPT_BYTES) as usize;
    let mut bytes = vec![0; length];
    file.read_exact(&mut bytes)?;
    if !unchanged(&opened, &file.metadata()?)?
        || !unchanged(&opened, &std::fs::symlink_metadata(path)?)?
    {
        return Err(io::ErrorKind::Interrupted.into());
    }
    let text = match std::str::from_utf8(&bytes) {
        Ok(text) => text,
        Err(error) if response.truncated && error.error_len().is_none() => {
            std::str::from_utf8(&bytes[..error.valid_up_to()])
                .map_err(|_| io::Error::from(io::ErrorKind::InvalidData))?
        }
        Err(_) => return Err(io::ErrorKind::InvalidData.into()),
    };
    response.prompt = text.to_string();
    response.available = true;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_validation_rejects_size_or_modified_time_changes() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("snapshot.md");
        std::fs::write(&path, "input").unwrap();
        let file = OpenOptions::new().read(true).write(true).open(&path).unwrap();
        let first_time = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_000);
        file.set_times(std::fs::FileTimes::new().set_modified(first_time)).unwrap();
        let before = std::fs::metadata(&path).unwrap();
        assert!(unchanged(&before, &file.metadata().unwrap()).unwrap());
        file.set_times(std::fs::FileTimes::new().set_modified(first_time + std::time::Duration::from_secs(1))).unwrap();
        assert!(!unchanged(&before, &file.metadata().unwrap()).unwrap());
        std::fs::write(&path, "longer input").unwrap();
        assert!(!unchanged(&before, &std::fs::metadata(&path).unwrap()).unwrap());
    }
}
