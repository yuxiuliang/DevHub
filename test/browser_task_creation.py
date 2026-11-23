"""Verify simple manual creation, stale archived forms, and reopening completed work."""

import argparse
from contextlib import closing
import json
from pathlib import Path
import shutil
import sqlite3
import tempfile
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from playwright.sync_api import expect, sync_playwright

from browser_cleanup import close_test_browser, launch_test_browser
from browser_flow import ROOT, make_fixture, serve_fixture


def api(url, path, method="GET", body=None):
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
    request = Request(url + path, data=data, method=method, headers={"Content-Type": "application/json"})
    with urlopen(request, timeout=15) as response:
        return json.load(response)


def visit_case(browser, url, directory, repo):
    created = api(url, "/api/rooms", "POST", {
        "name": "手动任务验收", "repoPath": str(repo), "requirement": "只写一句话即可补充任务",
        "mode": "serial", "autoApprove": False,
        "members": [{"name": "执行者", "worker": "codex"}],
        "plannerName": "执行者", "reviewerName": "执行者",
    })
    room_id = created["room"]["id"]
    owner_id = created["members"][0]["id"]
    page = browser.new_page(viewport={"width": 1280, "height": 800})
    errors, responses, run_requests = [], [], []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.on("request", lambda request: run_requests.append(urlsplit(request.url).path)
            if request.method == "POST" and urlsplit(request.url).path.startswith("/api/tasks/")
            and urlsplit(request.url).path.endswith("/run") else None)
    page.on("response", lambda response: responses.append(response.status)
            if urlsplit(response.url).path == "/api/tasks" and response.request.method == "POST" else None)
    try:
        page.goto(url, wait_until="domcontentloaded")
        page.locator(f'[data-act="open-room"][data-id="{room_id}"]').first.click()
        page.locator(".room-more > summary").click()
        page.locator('[data-act="add-task"]').click()
        form = page.get_by_role("dialog", name="添加一项任务")
        description = form.get_by_label("要完成什么？")
        spec = "为项目补充一段使用说明"
        description.fill(spec)
        assert not form.locator("details").evaluate("element => element.open")

        # Another window archives the room while this form remains open.
        api(url, f"/api/rooms/{room_id}", "DELETE")
        form.get_by_role("button", name="添加任务", exact=True).click()
        expect(form.locator("#nt-error")).to_contain_text("归档")
        expect(description).to_have_value(spec)
        assert responses == [409], responses
        assert api(url, f"/api/rooms/{room_id}")["tasks"] == []

        api(url, f"/api/rooms/{room_id}/restore", "POST", {})
        expect(description).to_have_value(spec)
        form.get_by_role("button", name="添加任务", exact=True).click()
        expect(form).to_have_count(0)
        state = api(url, f"/api/rooms/{room_id}")
        assert len(state["tasks"]) == 1
        task = state["tasks"][0]
        assert task["spec"] == spec and task["title"].strip() and task["title"] != "新任务"
        assert task["owner_id"] == owner_id and task["status"] == "backlog"
        assert task["deps"] == [] and task["acceptance"] == []
        assert not task["worktree"] and not task["branch"]
        assert responses == [409, 200], responses

        # Seed a finished local fixture to exercise adding work to a completed room.
        # No worker runs and no project files are changed by this preparation.
        with closing(sqlite3.connect(directory / ".data" / "devhub.db")) as database, database:
            database.execute("UPDATE tasks SET status='done' WHERE room_id=?", (room_id,))
            database.execute("UPDATE rooms SET status='completed' WHERE id=?", (room_id,))
        page.reload(wait_until="domcontentloaded")
        expect(page.get_by_text("会话已完成", exact=True)).to_be_visible()
        page.set_viewport_size({"width": 390, "height": 844})
        page.locator(".room-more > summary").click()
        page.locator('[data-act="add-task"]').click()
        form = page.get_by_role("dialog", name="添加一项任务")
        form.get_by_label("要完成什么？").fill("再补一项独立工作")
        assert not form.locator("details").evaluate("element => element.open")
        form.get_by_role("button", name="添加任务", exact=True).click()
        expect(form).to_have_count(0)
        expect(page.get_by_text("会话已完成", exact=True)).to_have_count(0)
        state = api(url, f"/api/rooms/{room_id}")
        assert state["room"]["status"] == "paused"
        assert len(state["tasks"]) == 2 and len({task["key"] for task in state["tasks"]}) == 2
        assert sorted(task["status"] for task in state["tasks"]) == ["backlog", "done"]
        assert all(not task["worktree"] for task in state["tasks"])
        global_state = api(url, "/api/state")
        assert global_state["activeWorkers"] == 0 and global_state["running"] == []
        assert responses == [409, 200, 200], responses
        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "390px overflow"

        # Represent a running room whose prior work has drained without promoting
        # a manually added backlog task. Viewing the new entry must stay read-only.
        pending = next(task for task in state["tasks"] if task["status"] == "backlog")
        with closing(sqlite3.connect(directory / ".data" / "devhub.db")) as database, database:
            database.execute("UPDATE rooms SET status='running' WHERE id=?", (room_id,))
        page.reload(wait_until="domcontentloaded")
        guidance = page.locator(".next-action").first
        expect(guidance).to_contain_text("有任务尚未启动")
        expect(guidance).not_to_contain_text("有空闲名额后会自动开始")
        assert run_requests == []
        assert api(url, "/api/state")["activeWorkers"] == 0
        guidance.get_by_role("button", name="查看任务", exact=True).click()
        drawer = page.get_by_role("dialog", name=pending["title"], exact=True)
        expect(drawer).to_be_visible()
        assert run_requests == []
        assert api(url, "/api/state")["activeWorkers"] == 0
        run_path = f"/api/tasks/{pending['id']}/run"
        with page.expect_response(lambda response: urlsplit(response.url).path == run_path
                                  and response.request.method == "POST", timeout=20000) as started:
            drawer.get_by_role("button", name="运行任务", exact=True).click()
        assert started.value.status == 200 and started.value.json()["ok"] is True
        expect(drawer.get_by_role("button", name="查看改动", exact=True)).to_be_visible()
        assert run_requests == [run_path], run_requests
        finished = next(task for task in api(url, f"/api/rooms/{room_id}")["tasks"] if task["id"] == pending["id"])
        assert finished["status"] == "review" and finished["worktree"] and finished["branch"]
        page.keyboard.press("Escape")
        expect(page.locator(".next-action")).to_contain_text("有成果可以检查")
        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "390px result overflow"
        assert not errors, errors
    finally:
        page.close()


def run_case(browser, backend, rust_exe):
    with tempfile.TemporaryDirectory(prefix="devhub-manual-task-") as temporary:
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
            visit_case(browser, url, directory, repo)
    assert not directory.exists()
    print(f"{backend}: manual creation, archived recovery, paused reopening, explicit-only execution, and 390px layout passed", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backend", choices=("all", "node", "rust"), default="all")
    parser.add_argument("--rust-exe", type=Path, default=ROOT / "rust" / "target" / "debug" / "devhub.exe")
    args = parser.parse_args()
    with sync_playwright() as pw:
        browser = launch_test_browser(pw)
        try:
            for backend in (("node", "rust") if args.backend == "all" else (args.backend,)):
                run_case(browser, backend, args.rust_exe.resolve())
        finally:
            close_test_browser(browser)


if __name__ == "__main__":
    main()
