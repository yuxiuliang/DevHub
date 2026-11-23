import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const adapterPath = fileURLToPath(new URL('../server/adapters.js', import.meta.url));

async function loadAdapter(root, executable, platform = process.platform) {
  const prompts = path.join(root, '数据 目录', 'prompts');
  const logs = path.join(root, '数据 目录', 'logs');
  fs.mkdirSync(prompts, { recursive: true });
  fs.mkdirSync(logs, { recursive: true });
  const env = Object.fromEntries(['SystemRoot', 'ComSpec', 'PATH', 'TEMP', 'TMP'].flatMap((name) => process.env[name] ? [[name, process.env[name]]] : []));
  env.FIXTURE_CAPTURE = path.join(root, 'argv.json');
  const modules = {
    'node:child_process': childProcess,
    'node:fs': fs,
    'node:path': path,
    'node:util': util,
    './store.js': { PROMPTS: prompts, LOGS: logs, uid: () => 'fixture', workerEnv: () => ({}) },
    './git.js': { knownPaths: () => Object.fromEntries(['claude', 'codex', 'opencode', 'agy', 'dsh'].map((key) => [key, executable])) },
  };
  const context = vm.createContext({ console, process: { platform, env } });
  const source = fs.readFileSync(adapterPath, 'utf8');
  const adapter = new vm.SourceTextModule(source + '\nexport { cmdQuote, workerCommand, buildCommand };', { context });
  await adapter.link((specifier) => {
    const exports = modules[specifier];
    assert.ok(exports, `Unexpected import: ${specifier}`);
    const keys = Object.keys(exports);
    return new vm.SyntheticModule(keys, function () {
      for (const key of keys) this.setExport(key, exports[key]);
    }, { context });
  });
  await adapter.evaluate();
  return { api: adapter.namespace, prompts, logs, env, capture: env.FIXTURE_CAPTURE };
}

function fixtureShim(root, folder) {
  const install = path.join(root, folder);
  fs.mkdirSync(install, { recursive: true });
  const shim = path.join(install, 'fixture.cmd');
  fs.writeFileSync(shim, `@echo off\r\n@"${process.execPath}" "%~dp0capture.cjs" %*\r\n`, 'utf8');
  fs.writeFileSync(path.join(install, 'capture.cjs'), `
    const fs = require('node:fs');
    fs.writeFileSync(process.env.FIXTURE_CAPTURE, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));
    console.log(JSON.stringify({type:'item.completed', item:{type:'agent_message', text:'fixture-ok'}}));
  `, 'utf8');
  return shim;
}

function launchFixture(harness, root, overrides = {}) {
  return new Promise((resolve, reject) => {
    try {
      harness.api.runWorker({ worker: 'codex', model: '模型 alpha', autoApprove: false, cwd: root,
        prompt: '测试需求：仅模拟，不执行真实任务。', runId: 'fixture-run', onExit: resolve, ...overrides });
    } catch (error) { reject(error); }
  });
}

async function runCommand(harness, command, cwd) {
  await util.promisify(childProcess.execFile)(command.command, Array.from(command.args), {
    cwd, env: harness.env, windowsVerbatimArguments: command.windowsVerbatimArguments,
    encoding: 'utf8', windowsHide: true, timeout: 10_000,
  });
  return JSON.parse(fs.readFileSync(harness.capture, 'utf8'));
}

// Evaluate the production adapter with synthetic store/git imports. No .data,
// worker discovery, credential lookup, or real CLI is reachable from this fixture.
function regression(name, verify, { windows = false } = {}) {
  test(name, { skip: windows && process.platform !== 'win32' }, () => {
    const script = `
      import assert from 'node:assert/strict';
      import * as childProcess from 'node:child_process';
      import * as fs from 'node:fs';
      import * as path from 'node:path';
      import * as util from 'node:util';
      import * as vm from 'node:vm';
      import { tmpdir } from 'node:os';
      const adapterPath = ${JSON.stringify(adapterPath)};
      const loadAdapter = ${loadAdapter.toString()};
      const fixtureShim = ${fixtureShim.toString()};
      const launchFixture = ${launchFixture.toString()};
      const runCommand = ${runCommand.toString()};
      const root = fs.mkdtempSync(path.join(tmpdir(), 'devhub-launcher-fixture-'));
      try { await (${verify.toString()})(root); }
      finally {
        assert.ok(path.isAbsolute(root) && path.basename(root).startsWith('devhub-launcher-fixture-'));
        fs.rmSync(root, { recursive: true, force: true });
      }
    `;
    const child = spawnSync(process.execPath, ['--experimental-vm-modules', '--input-type=module', '--eval', script], {
      encoding: 'utf8', windowsHide: true, timeout: 20_000,
    });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stdout + child.stderr);
  });
}

regression('Windows 批处理 CLI 在带空格和中文的安装、数据路径中保留 argv 与工作目录', async (root) => {
  const shim = fixtureShim(root, 'Program Files 模拟安装');
  const harness = await loadAdapter(root, shim);
  const cwd = path.join(root, '工作 目录');
  fs.mkdirSync(cwd);
  const result = await launchFixture(harness, cwd);
  assert.equal(result.code, 0, result.error);
  assert.equal(result.text, 'fixture-ok');
  const captured = JSON.parse(fs.readFileSync(harness.capture, 'utf8'));
  assert.equal(captured.cwd, cwd);
  assert.deepEqual(captured.args, [
    'exec', '--json', '--skip-git-repo-check', '-s', 'workspace-write', '-m', '模型 alpha',
    `Read the task file at ${result.promptPath} and carry it out exactly. Do not ask questions.`,
  ]);
  assert.equal(fs.readFileSync(result.promptPath, 'utf8'), '测试需求：仅模拟，不执行真实任务。');
}, { windows: true });

regression('Windows shim 保留空参数、反斜杠和普通带标点标签', async (root) => {
  const shim = fixtureShim(root, '安装 目录');
  const harness = await loadAdapter(root, shim);
  const args = ['', '中文 label', 'C:\\folder with spaces\\', 'R&D (next) !literal!', 'caret^label'];
  const command = harness.api.workerCommand('punctuation', shim, args);
  const captured = await runCommand(harness, command, root);
  assert.deepEqual(captured.args, args);
}, { windows: true });

regression('Windows 原生 EXE 在带空格和中文的安装路径中直接传 argv', async (root) => {
  const shim = fixtureShim(root, 'Program Files 原生安装');
  const executable = path.join(path.dirname(shim), 'fixture-node.exe');
  fs.copyFileSync(process.execPath, executable);
  const harness = await loadAdapter(root, executable);
  const values = ['', '中文 label', 'C:\\folder with spaces\\', 'name "value"', '100% ready'];
  const command = harness.api.workerCommand('native', executable, [path.join(path.dirname(shim), 'capture.cjs'), ...values]);
  assert.equal(command.command, executable);
  assert.equal(command.windowsVerbatimArguments, false);
  const captured = await runCommand(harness, command, root);
  assert.deepEqual(captured.args, values);
  assert.ok(!fs.existsSync(path.join(harness.prompts, 'native.cmd')));
}, { windows: true });

regression('非 Windows 使用原生 argv，不生成 Windows 启动脚本', async (root) => {
  const harness = await loadAdapter(root, process.execPath, 'linux');
  const args = ['空 格', 'name "value"', '100% ready'];
  const command = harness.api.workerCommand('posix', '/temporary fixture/cli', args);
  assert.equal(command.command, '/temporary fixture/cli');
  assert.deepEqual(Array.from(command.args), args);
  assert.equal(command.windowsVerbatimArguments, false);
  assert.ok(!fs.existsSync(path.join(harness.prompts, 'posix.cmd')));
});

regression('批处理不支持的字符只在验证器中拒绝，不做执行复现', async (root) => {
  const harness = await loadAdapter(root, process.execPath);
  for (const character of ['"', '%', '\r', '\n', '\0', '\t', '\x1f', '\x7f', '\x85']) {
    assert.throws(() => harness.api.cmdQuote('label' + character), /不支持/);
  }
  assert.equal(harness.api.cmdQuote(''), '""');
  assert.equal(harness.api.cmdQuote('普通 label'), '"普通 label"');
});

regression('五种 CLI 的模型与权限参数保持原契约', async (root) => {
  const harness = await loadAdapter(root, process.execPath);
  const expected = {
    claude: [
      ['-p', 'instruction', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits', '--permission-prompts', 'none', '--model', 'model'],
      ['-p', 'instruction', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions', '--model', 'model'],
    ],
    codex: [
      ['exec', '--json', '--skip-git-repo-check', '-s', 'workspace-write', '-m', 'model', 'instruction'],
      ['exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '-m', 'model', 'instruction'],
    ],
    opencode: [
      ['run', '--format', 'json', '--model', 'model', 'instruction'],
      ['run', '--format', 'json', '--auto', '--model', 'model', 'instruction'],
    ],
    agy: [
      ['-p', 'instruction', '--output-format', 'stream-json', '--model', 'model'],
      ['-p', 'instruction', '--output-format', 'stream-json', '--dangerously-skip-permissions', '--model', 'model'],
    ],
    dsh: [
      ['--profile', 'headless', '--json', 'instruction'],
      ['--profile', 'headless', '--json', 'instruction'],
    ],
  };
  for (const [worker, variants] of Object.entries(expected)) {
    for (const autoApprove of [false, true]) {
      const command = harness.api.buildCommand(worker, { instruction: 'instruction', model: 'model', autoApprove });
      assert.equal(command.exe, process.execPath);
      assert.deepEqual(Array.from(command.args), variants[Number(autoApprove)], worker);
    }
  }
});
