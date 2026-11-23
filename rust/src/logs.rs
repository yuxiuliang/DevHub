use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::PathBuf;

use rusqlite::OptionalExtension;
use serde::Serialize;

use crate::store::Store;

const MAX_LOG_BYTES: u64 = 128 * 1024;
const MAX_LOG_LINES: usize = 2_000;
const READ_ERROR: &str = "无法读取运行日志，请重试。";

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskLog {
    log: String,
    run_id: Option<String>,
    status: String,
    error: String,
    exit_code: Option<i64>,
    started_at: Option<String>,
    ended_at: Option<String>,
    truncated: bool,
    total_bytes: u64,
    read_error: String,
}

pub(crate) fn latest(store: &Store, task_id: &str) -> rusqlite::Result<TaskLog> {
    let run = {
        let conn = store.db.lock().unwrap();
        conn.query_row(
            "SELECT id, status, COALESCE(error, ''), exit_code, started_at, ended_at, log_path
             FROM runs WHERE task_id=? ORDER BY started_at DESC, rowid DESC LIMIT 1",
            [task_id],
            |row| {
                let response = TaskLog {
                    status: row.get(1)?,
                    error: row.get(2)?,
                    exit_code: row.get(3)?,
                    started_at: row.get(4)?,
                    ended_at: row.get(5)?,
                    ..TaskLog::default()
                };
                Ok((row.get::<_, String>(0)?, response, row.get::<_, Option<String>>(6)?))
            },
        )
        .optional()?
    };

    let Some((run_id, mut response, path)) = run else {
        return Ok(TaskLog::default());
    };
    response.run_id = Some(run_id.clone());
    let path = path
        .filter(|path| !path.is_empty())
        .map_or_else(|| store.logs.join(format!("{run_id}.log")), PathBuf::from);
    if let Err(error) = read_tail(&path, &mut response) {
        if error.kind() != io::ErrorKind::NotFound {
            response.read_error = READ_ERROR.into();
        }
    }
    Ok(response)
}

fn read_tail(path: &std::path::Path, response: &mut TaskLog) -> io::Result<()> {
    // Stat first: directories and open failures still return the file size when available.
    let initial_metadata = std::fs::metadata(path)?;
    response.total_bytes = initial_metadata.len();
    if !initial_metadata.is_file() {
        return Err(io::ErrorKind::InvalidInput.into());
    }

    let mut file = File::open(path)?;
    let snapshot_size = file.metadata()?.len();
    response.total_bytes = snapshot_size;
    let offset = snapshot_size.saturating_sub(MAX_LOG_BYTES);
    // Include one byte preceding the window to detect an exact line boundary.
    let start = offset.saturating_sub(1);
    if start > 0 {
        file.seek(SeekFrom::Start(start))?;
    }
    let length = snapshot_size - start;
    let mut bytes = Vec::with_capacity(length as usize);
    file.take(length).read_to_end(&mut bytes)?;

    let tail = if offset == 0 {
        &bytes[..]
    } else if let Some((&previous, tail)) = bytes.split_first() {
        if previous == b'\n' {
            tail
        } else {
            align_first_line(tail)
        }
    } else {
        &[]
    };
    let (recent, omitted_lines) = recent_lines(tail, MAX_LOG_LINES);
    response.log = String::from_utf8_lossy(recent).into_owned();
    response.truncated = offset > 0 || omitted_lines;
    Ok(())
}

fn align_first_line(tail: &[u8]) -> &[u8] {
    if let Some(lf) = tail.iter().position(|&byte| byte == b'\n') {
        // A terminal LF may be the only line ending in an oversized single record.
        if lf + 1 < tail.len() {
            return &tail[lf + 1..];
        }
    }
    // If one line exceeds the entire byte window, retain a UTF-8-readable suffix.
    let continuation = tail.iter().take_while(|&&byte| byte & 0xc0 == 0x80).count();
    &tail[continuation..]
}

fn recent_lines(tail: &[u8], limit: usize) -> (&[u8], bool) {
    if limit == 0 || tail.is_empty() {
        return (&[], !tail.is_empty());
    }
    // `a\n` is one line, not an extra empty line after the terminator.
    let logical_lines = tail.iter().filter(|&&byte| byte == b'\n').count()
        + usize::from(!tail.ends_with(b"\n"));
    if logical_lines <= limit {
        return (tail, false);
    }
    let skipped = logical_lines - limit;
    let separator = tail
        .iter()
        .enumerate()
        .filter(|&(_, byte)| *byte == b'\n')
        .nth(skipped - 1)
        .map(|(index, _)| index + 1)
        .unwrap_or(0);
    (&tail[separator..], true)
}

#[cfg(test)]
mod tests {
    use super::{align_first_line, recent_lines};

    #[test]
    fn aligns_partial_lines_and_preserves_single_oversized_line_terminators() {
        assert_eq!(align_first_line(b"partial\nfull\r\nlast\n"), b"full\r\nlast\n");
        assert_eq!(align_first_line(b"single-line-with-terminal-lf\n"), b"single-line-with-terminal-lf\n");
        assert_eq!(align_first_line(b"single-line-without-lf"), b"single-line-without-lf");
    }

    #[test]
    fn limits_logical_lines_without_adding_a_terminal_empty_line() {
        assert_eq!(recent_lines(b"first\nsecond\n", 2), (b"first\nsecond\n".as_slice(), false));
        assert_eq!(recent_lines(b"first\nsecond\nthird\n", 2), (b"second\nthird\n".as_slice(), true));
        assert_eq!(recent_lines(b"single-line\n", 1), (b"single-line\n".as_slice(), false));
    }
}
