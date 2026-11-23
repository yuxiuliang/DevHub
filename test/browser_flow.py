"""Drive the real DevHub UI against isolated Node and/or Rust servers on Windows."""

import argparse
from contextlib import contextmanager
import json
import os
from pathlib import Path
import shutil
import socket
import sqlite3
import subprocess
import tempfile
import time
from urllib.error import URLError
from urllib.parse import urlsplit
from urllib.request import urlopen

from playwright.sync_api import expect, sync_playwright

from browser_cleanup import close_test_browser, launch_test_browser


ROOT = Path(__file__).resolve().parents[1]
FAKE_CODEX = r"""
const fs = require('node:fs');
const text = process.argv.find((arg) => arg.startsWith('Read the task file at '));
const match = /^Read the task file at (.+) and carry it out exactly\./.exec(text || '');
if (!match) throw new Error('Missing prompt file argument');
const prompt = fs.readFileSync(match[1], 'utf8');
let output;
if (prompt.startsWith('# 任务：为一次需求生成执行计划')) {
  const attemptsFile = process.env.DEVHUB_TEST_PLAN_ATTEMPTS;
  const attempts = fs.existsSync(attemptsFile) ? Number(fs.readFileSync(attemptsFile, 'utf8')) : 0;
  fs.writeFileSync(attemptsFile, String(attempts + 1));
  if (attempts === 0) {
    console.error('模拟计划暂时失败，请重试');
    process.exit(1);
  }
  output = JSON.stringify({ tasks: [{ title: '添加说明文件', spec: '写一行说明', type: 'code', dependsOn: [] }] });
} else if (prompt.startsWith('# 任务：评审一个改动')) {
  fs.writeFileSync('local-test-output.tmp', 'Keep this in the worktree.\n');
  output = JSON.stringify({ verdict: 'approve', blocking: [], notes: '检查通过' });
} else {
  fs.writeFileSync('result.txt', 'DevHub workflow verified.\n');
  output = '说明文件已添加';
}
console.log(JSON.stringify({type: 'thread.started', thread_id: 'fixture'}));
console.log(JSON.stringify({type: 'item.completed', item: {type: 'agent_message', text: output}}));
"""


def check_git(repo, env, *args):
    return subprocess.check_output(["git", "-C", str(repo), *args], env=env, stderr=subprocess.STDOUT, text=True)


def make_fixture(directory):
    node = Path(shutil.which("node")).resolve()
    git = Path(shutil.which("git")).resolve()
    windows = Path(os.environ["SystemRoot"])
    bins = directory / "bin"
    bins.mkdir()
    script = directory / "fixture.cjs"
    script.write_text(FAKE_CODEX, encoding="utf-8")
    (bins / "codex.cmd").write_text(
        '@echo off\n"%DEVHUB_TEST_NODE%" "%DEVHUB_TEST_FIXTURE%" %*\nexit /b %errorlevel%\n', encoding="ascii"
    )
    env = {key: value for key, value in os.environ.items()
           if key.upper() in {"SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "PATHEXT", "SYSTEMDRIVE"}}
    env.update(PATH=os.pathsep.join(map(str, [bins, node.parent, git.parent, windows / "System32", windows])),
               DEVHUB_TEST_NODE=str(node), DEVHUB_TEST_FIXTURE=str(script),
               DEVHUB_TEST_PLAN_ATTEMPTS=str(directory / "plan-attempts.txt"), GIT_CONFIG_NOSYSTEM="1",
               GIT_CONFIG_GLOBAL=str(directory / "gitconfig"), HOME=str(directory), USERPROFILE=str(directory))
    repo = directory / "sample project"
    repo.mkdir()
    check_git(repo, env, "init", "-b", "main")
    (repo / "README.md").write_text("Demo project\n", encoding="utf-8")
    check_git(repo, env, "add", "README.md")
    check_git(repo, env, "-c", "user.name=Smoke", "-c", "user.email=smoke@example.invalid", "commit", "-m", "Initial")
    return repo, env, node


def visit_workflow(browser, url, repo, env):
    page = browser.new_page(viewport={"width": 1280, "height": 800})
    errors = []
    posts = []
    trace = []
    trace_started = time.monotonic()
    snapshot_sha = None
    page.on("request", lambda request: trace.append((round(time.monotonic() - trace_started, 3), "request", request.method, urlsplit(request.url).path))
            if urlsplit(request.url).path.startswith("/api/") else None)
    page.on("response", lambda response: trace.append((round(time.monotonic() - trace_started, 3), "response", response.status, urlsplit(response.url).path))
            if urlsplit(response.url).path.startswith("/api/") else None)
    page.on("requestfailed", lambda request: trace.append((round(time.monotonic() - trace_started, 3), "requestfailed", request.method, urlsplit(request.url).path)))
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.on("dialog", lambda dialog: dialog.accept())
    page.on("request", lambda request: posts.append(urlsplit(request.url).path) if request.method == "POST" else None)

    def post_count(suffix):
        return sum(path.endswith(suffix) for path in posts)

    def click_and_load_diff(button):
        nonlocal snapshot_sha
        # Reading a pinned result performs Git IO. Wait for that response within
        # the workflow's normal IO budget, then assert the rendered content.
        with page.expect_response(lambda response: response.request.method == "GET"
                                  and urlsplit(response.url).path.endswith("/diff"), timeout=20000) as loaded:
            button.click()
        response = loaded.value
        assert response.status == 200, response.text()[:3000]
        payload = response.json()
        assert isinstance(payload.get("diff"), str) and payload.get("resultSha"), payload
        if snapshot_sha is None:
            snapshot_sha = payload["resultSha"]
        else:
            assert payload["resultSha"] == snapshot_sha, "All views must show the same pinned result"

    try:
        page.goto(url, wait_until="domcontentloaded")
        page.get_by_role("button", name="开始一个项目", exact=True).click()
        setup = page.get_by_role("dialog", name="开始一个项目")
        project = setup.get_by_label("项目文件夹")
        requirement = setup.get_by_label("你想做什么？")
        expect(requirement).to_be_focused()
        expect(project).to_have_value("")
        project.fill(str(repo))
        requirement.fill("添加一个项目说明")
        expect(setup.get_by_text("执行工具：Codex")).to_be_visible()
        setup.get_by_role("button", name="创建并生成计划", exact=True).press("Enter")
        expect(page.locator(".plan-retry h3", has_text="计划没生成出来")).to_be_visible(timeout=20000)
        assert posts.count("/api/rooms") == 1 and post_count("/plan") == 1
        assert post_count("/start") == 0, "Creating a room must not execute tasks"
        page.get_by_role("button", name="重新生成计划", exact=True).press("Enter")
        plan = page.get_by_role("dialog", name="确认计划")
        expect(plan.get_by_label("任务 1 标题")).to_have_value("添加说明文件", timeout=20000)
        assert posts.count("/api/rooms") == 1 and post_count("/plan") == 2, "Retry must reuse the created room"
        assert post_count("/start") == 0, "Generated plans need explicit confirmation"
        assert not (repo / "result.txt").exists()
        plan.get_by_role("button", name="确认并开始执行", exact=True).click()
        result = page.get_by_role("button", name="查看成果", exact=True)
        result.wait_for(timeout=20000)
        assert post_count("/start") == 1, "Confirmation starts the existing room exactly once"
        click_and_load_diff(result)
        task = page.get_by_role("dialog", name="添加说明文件")
        expect(task.get_by_text("+DevHub workflow verified.")).to_be_visible()
        task.get_by_role('button', name='日志', exact=True).click()
        expect(task.get_by_label('最近执行日志')).to_contain_text('说明文件已添加')
        expect(task.get_by_text('本次运行：已完成', exact=False)).to_be_visible()
        click_and_load_diff(task.get_by_role('button', name='改动', exact=True))
        expect(task.get_by_text("+DevHub workflow verified.")).to_be_visible()
        task.get_by_role("button", name="自动检查", exact=True).click()
        expect(task.get_by_text("检查通过")).to_be_visible(timeout=20000)
        click_and_load_diff(task.get_by_role("button", name="查看改动", exact=True))
        expect(task.get_by_text("+DevHub workflow verified.")).to_be_visible()
        task.get_by_role("button", name="合并到项目", exact=True).click()
        expect(task.get_by_text("改动已合并到项目")).to_be_visible(timeout=20000)
        page.keyboard.press("Escape")
        expect(page.get_by_text("会话已完成", exact=True)).to_be_visible()
        assert check_git(repo, env, "ls-tree", "--name-only", "HEAD").splitlines() == ["README.md", "result.txt"]
        page.locator('[data-act="new-room"]').first.press("Enter")
        expect(project).to_have_value(str(repo))
        expect(requirement).to_be_focused()
        page.keyboard.press("Escape")
        expect(setup).to_have_count(0)
        assert posts.count("/api/rooms") == 1 and post_count("/plan") == 2 and post_count("/start") == 1
        assert not errors, errors
    except Exception:
        diagnostic = {"pageErrors": errors, "recentRequests": trace[-24:], "posts": posts}
        try:
            diagnostic["drawer"] = page.locator("#drawer-root").inner_text(timeout=2000)[:6000]
            diagnostic["selectedView"] = page.locator('.drawer-tabs [aria-pressed="true"]').all_text_contents()
        except Exception as error:
            diagnostic["inspectionError"] = str(error)
        print("Workflow failure diagnostics: " + json.dumps(diagnostic), flush=True)
        raise
    finally:
        page.close()


def seed_interrupted_task(directory):
    # Represent a process that exited while one task was running and another was queued.
    database = sqlite3.connect(directory / ".data" / "devhub.db")
    try:
        with database:
            room_id, created_at = database.execute("SELECT id, created_at FROM rooms").fetchone()
            owner = database.execute("SELECT id FROM members WHERE room_id=?", (room_id,)).fetchone()[0]
            database.execute("UPDATE rooms SET status='running' WHERE id=?", (room_id,))
            for task_id, key, title, status in (
                ("t_interrupted", "T2", "中断的任务", "running"),
                ("t_waiting", "T3", "队列里的任务", "ready"),
            ):
                database.execute(
                    "INSERT INTO tasks (id,room_id,key,title,owner_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
                    (task_id, room_id, key, title, owner, status, created_at, created_at),
                )
            database.execute(
                "INSERT INTO runs (id,task_id,member_id,status,started_at) VALUES ('run_interrupted','t_interrupted',?,'running',?)",
                (owner, created_at),
            )
    finally:
        database.close()
    (directory / '.data' / 'logs' / 'run_interrupted.log').write_text(
        ''.join(f'旧日志 {index}\n' for index in range(3000)) + '中断前最后一条输出\n', encoding='utf-8')


def verify_recovery(browser, url):
    page = browser.new_page(viewport={"width": 390, "height": 844})
    try:
        page.goto(url, wait_until="domcontentloaded")
        expect(page.get_by_role("heading", name="需要你处理", exact=True)).to_be_visible()
        page.locator('.inbox-item').filter(has_text="中断的任务").get_by_role('button', name='查看原因').click()
        expect(page.locator(".room-meta").get_by_text("已暂停", exact=True)).to_be_visible()
        expect(page.locator(".card").filter(has_text="队列里的任务").get_by_text("就绪")).to_be_visible()
        task = page.get_by_role("dialog", name="中断的任务")
        expect(task.get_by_text("DevHub 重启中断了上次运行。", exact=False)).to_be_visible()
        expect(task.get_by_role("button", name="重新运行", exact=True)).to_be_visible()
        task.get_by_role('button', name='查看执行日志', exact=True).click()
        expect(task.get_by_label('最近执行日志')).to_contain_text('中断前最后一条输出')
        expect(task.get_by_label('最近执行日志')).not_to_contain_text('旧日志 0\n')
        expect(task.get_by_text('仅显示最近的日志，较早内容仍保存在本机。')).to_be_visible()
        expect(task.get_by_text('本次运行：已中断', exact=False)).to_be_visible()
    finally:
        page.close()


@contextmanager
def serve_fixture(command, directory, env, backend):
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    url = f"http://127.0.0.1:{port}"
    with (directory / "server-output.txt").open("w+b") as output:
        with subprocess.Popen(command, cwd=directory, env={**env, "PORT": str(port)}, stdout=output, stderr=subprocess.STDOUT) as process:
            try:
                deadline = time.monotonic() + 15
                while process.poll() is None:
                    try:
                        with urlopen(url + "/api/health", timeout=1) as response:
                            if response.status == 200:
                                break
                    except URLError:
                        if time.monotonic() > deadline:
                            raise RuntimeError(f"{backend}: DevHub startup timed out")
                        time.sleep(0.1)
                if process.poll() is not None:
                    raise RuntimeError(f"{backend}: DevHub exited at startup")
                yield url
            except Exception:
                print((directory / "server-output.txt").read_text(encoding="utf-8", errors="replace"))
                raise
            finally:
                subprocess.run(
                    ["taskkill.exe", "/pid", str(process.pid), "/t", "/f"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    check=False,
                    timeout=10,
                )
                if process.poll() is None:
                    process.wait(timeout=10)


def run_case(browser, backend, rust_exe):
    with tempfile.TemporaryDirectory(prefix="devhub-flow-") as temporary:
        directory = Path(temporary)
        repo, env, node = make_fixture(directory)
        if backend == "node":
            shutil.copytree(ROOT / "server", directory / "server")
            shutil.copytree(ROOT / "web", directory / "web")
            shutil.copy(ROOT / "package.json", directory / "package.json")
            command = [str(node), "server/index.js"]
        else:
            command = [str(rust_exe), "--data", str(directory / ".data")]
        with serve_fixture(command, directory, env, backend) as url:
            visit_workflow(browser, url, repo, env)
        seed_interrupted_task(directory)
        with serve_fixture(command, directory, env, backend) as url:
            verify_recovery(browser, url)
    assert not directory.exists(), "Fixture output must be removed after the server process tree exits"
    print(f"{backend}: first-use workflow through merge, repeat-project prefill, recovery, and temporary cleanup passed")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backend", choices=("all", "node", "rust"), default="all")
    parser.add_argument("--rust-exe", type=Path, default=ROOT / "rust" / "target" / "debug" / "devhub.exe")
    args = parser.parse_args()
    if os.name != "nt":
        parser.error("The test uses a Windows .cmd fixture for the current Node adapter.")
    with sync_playwright() as pw:
        browser = launch_test_browser(pw)
        try:
            backends = ("node", "rust") if args.backend == "all" else (args.backend,)
            for backend in backends:
                run_case(browser, backend, args.rust_exe.resolve())
        finally:
            close_test_browser(browser)


if __name__ == "__main__":
    main()
