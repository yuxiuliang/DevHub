import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';

const MAX_DIRS = 400;

async function isDir(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function isRepo(path) {
  return isDir(join(path, '.git')) || (await stat(join(path, '.git')).catch(() => null))?.isFile() || false;
}

async function listRoots() {
  if (process.platform !== 'win32') return [{ name: '/', path: '/' }];
  const roots = [];
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for (const letter of letters) {
    const path = `${letter}:\\`;
    if (await isDir(path)) roots.push({ name: `${letter}:`, path });
  }
  return roots;
}

/** 本机目录浏览：只返回目录名和是否为 git 仓库，不读取文件内容。 */
export async function browseDir(input) {
  const target = resolve(String(input || '').trim() || homedir());
  if (!(await isDir(target))) throw new Error(`目录不存在或不可访问：${target}`);

  let entries = [];
  try {
    entries = await readdir(target, { withFileTypes: true });
  } catch (e) {
    throw new Error(`无法读取目录：${e.code || e.message}`);
  }

  const dirs = [];
  for (const entry of entries) {
    if (dirs.length >= MAX_DIRS) break;
    if (entry.name === '$RECYCLE.BIN' || entry.name === 'System Volume Information' || entry.name === '.git') continue;
    const path = join(target, entry.name);
    let directory = entry.isDirectory();
    if (!directory && entry.isSymbolicLink()) directory = await isDir(path);
    if (!directory) continue;
    dirs.push({ name: entry.name, path, repo: await isRepo(path) });
  }

  dirs.sort((a, b) => Number(b.repo) - Number(a.repo) || a.name.localeCompare(b.name, 'zh-CN'));
  const parent = dirname(target);
  const root = parse(target).root;

  return {
    path: target,
    parent: parent === target ? null : parent,
    root,
    home: homedir(),
    roots: await listRoots(),
    isRepo: await isRepo(target),
    dirs,
    truncated: dirs.length >= MAX_DIRS,
  };
}
