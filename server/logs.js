import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { get, LOGS } from './store.js';

const MAX_BYTES = 131072;
const MAX_LINES = 2000;
const READ_ERROR = '无法读取运行日志，请重试。';

function emptyLog() {
  return {
    log: '', runId: null, status: '', error: '', exitCode: null,
    startedAt: null, endedAt: null, truncated: false, totalBytes: 0, readError: '',
  };
}

/** Return a recent, bounded view without normalizing the log's line endings. */
function recentBytes(bytes, offset, preceding) {
  let tail = bytes;
  let truncated = offset > 0;
  let partialLine = offset > 0 && preceding !== 10;
  if (partialLine) {
    const firstLf = tail.indexOf(10);
    // A huge single line may have only its terminal LF in the buffer. Keep its
    // readable tail rather than discarding the entire available log.
    if (firstLf >= 0 && firstLf < tail.length - 1) {
      tail = tail.subarray(firstLf + 1);
      partialLine = false;
    }
  }

  let lines = 0;
  for (let i = tail.length - 1; i >= 0; i--) {
    if (tail[i] !== 10 || i === tail.length - 1) continue;
    if (++lines === MAX_LINES) {
      tail = tail.subarray(i + 1);
      truncated = true;
      break;
    }
  }

  if (partialLine) {
    let start = 0;
    // A byte seek can land in a valid multi-byte UTF-8 character. Drop only its
    // leading continuation bytes so decoding does not invent a replacement.
    while (start < tail.length && (tail[start] & 0xc0) === 0x80) start++;
    tail = tail.subarray(start);
  }
  return { log: tail.toString('utf8'), truncated };
}

export async function taskLog(taskId) {
  const row = get(`SELECT id, status, error, exit_code, started_at, ended_at, log_path
    FROM runs WHERE task_id=? ORDER BY started_at DESC, rowid DESC LIMIT 1`, [taskId]);
  const result = emptyLog();
  if (!row) return result;
  Object.assign(result, {
    runId: row.id,
    status: row.status || '',
    error: row.error || '',
    exitCode: row.exit_code ?? null,
    startedAt: row.started_at ?? null,
    endedAt: row.ended_at ?? null,
  });

  const path = row.log_path || join(LOGS, `${row.id}.log`);
  let file;
  try {
    const pathInfo = await stat(path);
    result.totalBytes = pathInfo.size;
    if (!pathInfo.isFile()) throw new Error('Log is not a regular file');
    file = await open(path, 'r');
    const info = await file.stat();
    result.totalBytes = info.size;
    if (!info.isFile()) throw new Error('Log is not a regular file');
    if (info.size === 0) return result;

    const offset = Math.max(0, info.size - MAX_BYTES);
    const peek = offset > 0 ? 1 : 0;
    const length = Math.min(info.size, MAX_BYTES) + peek;
    const buffer = Buffer.allocUnsafe(length);
    let used = 0;
    while (used < length) {
      const { bytesRead } = await file.read(buffer, used, length - used, offset - peek + used);
      if (!bytesRead) break;
      used += bytesRead;
    }
    const preceding = peek && used ? buffer[0] : null;
    const bytes = buffer.subarray(Math.min(peek, used), used);
    Object.assign(result, recentBytes(bytes, offset, preceding));
  } catch (error) {
    if (error.code !== 'ENOENT') result.readError = READ_ERROR;
  } finally {
    if (file) await file.close().catch(() => {});
  }
  return result;
}
