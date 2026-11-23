import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { TextDecoder } from 'node:util';
import { all, get, PROMPTS } from './store.js';

const MAX_BYTES = 262144;
const HISTORY_LIMIT = 50;
const READ_ERROR = '无法读取本次运行的执行输入，请重试。';
const INVALID_RUN = '运行标识无效，无法读取执行输入。';

function notFound(message) {
  return Object.assign(new Error(message), { statusCode: 404 });
}

function metadata(row) {
  return {
    runId: row.id, status: row.status || '', exitCode: row.exit_code ?? null,
    startedAt: row.started_at ?? null, endedAt: row.ended_at ?? null,
  };
}

/** 历史运行保存的流程快照：空串、坏 JSON、非对象一律视为没有快照，绝不抛错。 */
function flowSnapshot(row) {
  const text = row.flow_json;
  if (typeof text !== 'string' || !text) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
}

/** Read a saved input, never reconstruct it from mutable task or room fields. */
export async function taskPrompt(taskId, runId) {
  if (!get('SELECT id FROM tasks WHERE id=?', [taskId])) throw notFound('任务不存在，请刷新会话后重试');
  // Keep all metadata reads synchronous, before the first filesystem await.
  const rows = all(`SELECT id,status,exit_code,started_at,ended_at,flow_json FROM runs
    WHERE task_id=? ORDER BY started_at DESC,rowid DESC LIMIT ?`, [taskId, HISTORY_LIMIT + 1]);
  const selected = runId === undefined ? rows[0]
    : get('SELECT id,status,exit_code,started_at,ended_at,flow_json FROM runs WHERE task_id=? AND id=?', [taskId, runId]);
  if (runId !== undefined && !selected) throw notFound('本任务没有这次运行记录，请重新选择');
  const result = {
    prompt: '', runId: null, status: '', exitCode: null, startedAt: null, endedAt: null,
    available: false, truncated: false, totalBytes: 0, readError: '', flow: null,
    runs: rows.slice(0, HISTORY_LIMIT).map(metadata), runsTruncated: rows.length > HISTORY_LIMIT,
  };
  if (!selected) return result;
  result.flow = flowSnapshot(selected);
  Object.assign(result, metadata(selected));
  if (typeof selected.id !== 'string' || !selected.id || /[^A-Za-z0-9_-]/.test(selected.id)) {
    result.readError = INVALID_RUN;
    return result;
  }

  let file;
  try {
    const path = join(PROMPTS, `${selected.id}.md`);
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink()) throw new Error('Input is not a regular file');
    file = await open(path, 'r');
    const info = await file.stat();
    if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino) {
      throw new Error('Input file changed before opening');
    }
    result.totalBytes = info.size;
    const length = Math.min(info.size, MAX_BYTES);
    const bytes = Buffer.alloc(length);
    let used = 0;
    while (used < length) {
      const { bytesRead } = await file.read(bytes, used, length - used, used);
      if (!bytesRead) throw new Error('Input changed during reading');
      used += bytesRead;
    }
    const after = await file.stat();
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs
        || after.dev !== info.dev || after.ino !== info.ino) throw new Error('Input changed during reading');
    const truncated = info.size > length;
    // Streaming drops only an incomplete final character at our byte boundary.
    // A complete invalid UTF-8 file still fails closed. Preserve an initial BOM.
    const prompt = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes, { stream: truncated });
    Object.assign(result, { prompt, available: true, truncated });
  } catch (error) {
    if (error.code !== 'ENOENT') result.readError = READ_ERROR;
  } finally {
    if (file) await file.close().catch(() => {});
  }
  return result;
}
