import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { workerEnv } from './store.js';

const pexec = promisify(execFile);

export async function git(repo, args, opts = {}) {
  const { stdout, stderr } = await pexec('git', ['-C', repo, ...args], {
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    ...opts,
  });
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

export async function isRepo(path) {
  try {
    const { stdout } = await git(path, ['rev-parse', '--is-inside-work-tree']);
    return stdout === 'true';
  } catch {
    return false;
  }
}

export async function currentBranch(repo) {
  try {
    const { stdout } = await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
    return stdout && stdout !== 'HEAD' ? stdout : 'main';
  } catch {
    return 'main';
  }
}

export async function isClean(repo) {
  const { stdout } = await git(repo, ['status', '--porcelain']);
  return stdout === '';
}

export async function revParse(repo, ref) {
  const { stdout } = await git(repo, ['rev-parse', ref]);
  return stdout;
}

export async function addWorktree(repo, path, branch, base) {
  try {
    await git(repo, ['worktree', 'remove', '--force', path]);
  } catch {}
  await git(repo, ['worktree', 'prune']);
  await git(repo, ['worktree', 'add', '-B', branch, path, base]);
}

export async function removeWorktree(repo, path) {
  try {
    await git(repo, ['worktree', 'remove', '--force', path]);
  } catch {}
}

export async function statusPorcelain(path) {
  const { stdout } = await git(path, ['status', '--porcelain']);
  return stdout;
}

/**
 * 只看已跟踪文件的改动。
 * 评审者跑测试可能生成未跟踪的临时文件/覆盖率目录，这不该被判成“改了工作区”；
 * 但已跟踪文件被改、被暂存或被提交仍然要拦截。
 */
export async function trackedStatus(path) {
  const { stdout } = await git(path, ['status', '--porcelain', '--untracked-files=no']);
  return stdout;
}

export async function commitAll(path, message) {
  const dirty = await statusPorcelain(path);
  if (!dirty) return false;
  await git(path, ['add', '-A']);
  await git(path, [
    '-c', 'user.name=DevHub',
    '-c', 'user.email=devhub@local',
    'commit', '-m', message, '--no-verify',
  ]);
  return true;
}

export async function diff(path, baseSha) {
  try {
    const { stdout } = await git(path, ['diff', '--no-color', baseSha, 'HEAD']);
    if (stdout) return stdout;
  } catch {}
  try {
    const { stdout } = await git(path, ['diff', '--no-color', baseSha]);
    return stdout;
  } catch {
    return '';
  }
}

export async function diffStat(path, baseSha) {
  try {
    const { stdout } = await git(path, ['diff', '--stat', baseSha, 'HEAD']);
    return stdout;
  } catch {
    return '';
  }
}

export async function log(path, baseSha) {
  try {
    const { stdout } = await git(path, ['log', '--oneline', `${baseSha}..HEAD`]);
    return stdout;
  } catch {
    return '';
  }
}

export async function mergeSquash(repo, baseBranch, branch, message) {
  const dirty = await statusPorcelain(repo);
  if (dirty) {
    const files = dirty.split('\n').slice(0, 5).join('；');
    throw new Error(`仓库有未提交的改动，请先处理后再合并：${files}`);
  }
  await git(repo, ['checkout', baseBranch]);
  try {
    await git(repo, ['merge', '--squash', branch]);
  } catch (e) {
    try {
      await git(repo, ['reset', '--merge']);
    } catch {}
    throw new Error(`合并冲突：${String(e.stderr || e.message).split('\n')[0]}`);
  }
  try {
    await git(repo, [
      '-c', 'user.name=DevHub',
      '-c', 'user.email=devhub@local',
      'commit', '-m', message, '--no-verify',
    ]);
  } catch (e) {
    try { await git(repo, ['reset', '--merge']); } catch {}
    throw new Error(`合并提交失败：${String(e.stderr || e.message).split('\n')[0]}`);
  }
}

/**
 * 不在 PATH 上的 CLI 可以用环境变量或 .data/env.json 指定绝对路径：
 *   DEVHUB_DSH_PATH=C:\path\to\dsh.cmd
 *   DEVHUB_AGY_PATH=C:\path\to\agy.exe
 * 开源仓库不内置任何人的本机路径。
 */
export function knownPaths() {
  const env = { ...workerEnv(), ...process.env };
  return {
    dsh: String(env.DEVHUB_DSH_PATH || '').trim(),
    agy: String(env.DEVHUB_AGY_PATH || '').trim(),
  };
}

export function exists(path) {
  try { return existsSync(path); } catch { return false; }
}
