"""Regression for task-based guidance without implicitly starting queued work."""

import copy
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright

from browser_cleanup import close_test_browser, launch_test_browser


WEB = Path(__file__).resolve().parents[1] / "web"
ASSETS = {
    "/": ("index.html", "text/html"), "/app.js": ("app.js", "application/javascript"),
    "/plan-draft.js": ("plan-draft.js", "application/javascript"),
    "/edit-drafts.js": ("edit-drafts.js", "application/javascript"),
    "/log-buffer.js": ("log-buffer.js", "application/javascript"), "/style.css": ("style.css", "text/css"),
}
STAMP = "2026-11-21T08:00:00.000Z"
ROOM = {
    "id": "r-guidance", "name": "Queue guidance", "repo_path": "D:/project", "base_branch": "main",
    "requirement": "Show the actual next action", "status": "running", "mode": "serial", "auto_approve": False,
    "flow": {"nodes": [], "edges": []}, "plan": None, "updated_at": STAMP,
}
MEMBER = {"id": "m1", "name": "Worker", "worker": "codex", "enabled": True, "concurrency": 1}


def task(task_id="manual", key="T1", status="backlog", deps=None, owner="m1"):
    return {"id": task_id, "room_id": ROOM["id"], "key": key, "title": f"Task {key}", "spec": "Manual work",
            "status": status, "type": "code", "owner_id": owner, "deps": deps or [], "acceptance": [],
            "summary": "", "feedback": "", "worktree": "", "branch": "", "diff_stat": "", "updated_at": STAMP}


def main():
    room, members, tasks = copy.deepcopy(ROOM), [copy.deepcopy(MEMBER)], [task()]
    errors, runs = [], []

    def respond(route):
        path = urlsplit(route.request.url).path
        if path in ASSETS:
            name, mime = ASSETS[path]
            return route.fulfill(body=(WEB / name).read_bytes(), content_type=f"{mime}; charset=utf-8")
        if path == "/api/events":
            return route.fulfill(status=204)
        if path == "/api/workers":
            return route.fulfill(json={"workers": [{"key": "codex", "label": "Codex", "available": True}]})
        if path == "/api/state":
            running = [{"taskId": item["id"], "phase": "running"} for item in tasks if item["status"] == "running"]
            return route.fulfill(json={"rooms": [room], "running": running, "activeWorkers": len(running),
                                       "flowTemplates": [], "inbox": []})
        if path == "/api/rooms/" + room["id"]:
            return route.fulfill(json={"room": room, "members": members, "tasks": tasks, "events": [], "decisions": [], "reviews": []})
        if path.startswith("/api/tasks/") and path.endswith("/run") and route.request.method == "POST":
            task_id = path.split("/")[3]
            runs.append(task_id)
            next(item for item in tasks if item["id"] == task_id)["status"] = "running"
            return route.fulfill(json={"ok": True})
        return route.fulfill(status=404, json={"error": "Unexpected request"})

    with sync_playwright() as pw:
        browser = launch_test_browser(pw)
        page = browser.new_page(viewport={"width": 1280, "height": 800})
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.route("http://devhub.invalid/**", respond)

        def show(items, status="running", disabled=False):
            tasks[:] = copy.deepcopy(items)
            room["status"] = status
            room["counts"] = {"total": len(tasks), "running": sum(item["status"] == "running" for item in tasks),
                              "done": sum(item["status"] in ("done", "merged", "cancelled") for item in tasks),
                              "review": 0, "failed": 0}
            members[:] = [{**MEMBER, "enabled": not disabled}]
            page.goto("http://devhub.invalid/", wait_until="domcontentloaded")
            expect(page.locator(".room-head h1")).to_have_text(room["name"])
            return page.locator(".next-action").first

        try:
            guidance = show([task()])
            expect(guidance).to_contain_text("有任务尚未启动")
            expect(guidance).not_to_contain_text("有空闲名额后会自动开始")
            assert runs == []
            guidance.get_by_role("button", name="查看任务", exact=True).click()
            drawer = page.get_by_role("dialog", name="Task T1")
            expect(drawer).to_be_visible()
            assert runs == [], "Opening task details must not start a worker"
            drawer.get_by_role("button", name="运行任务", exact=True).click()
            expect(drawer.get_by_role("button", name="取消运行", exact=True)).to_be_visible()
            assert runs == ["manual"], runs
            page.keyboard.press("Escape")
            expect(page.locator(".next-action")).to_contain_text("正在执行")

            guidance = show([task(status="ready")])
            expect(guidance).to_contain_text("有空闲名额后会自动开始")
            assert runs == ["manual"]

            guidance = show([task(owner="missing")])
            expect(guidance).to_contain_text("没有可用的负责人")
            expect(guidance.get_by_role("button", name="打开设置", exact=True)).to_be_visible()
            guidance = show([task()], disabled=True)
            expect(guidance).to_contain_text("没有可用的负责人")

            guidance = show([task(status="ready", owner="missing"), task("available", "T2")])
            expect(guidance).to_contain_text("有任务尚未启动")
            assert guidance.locator('[data-act="open-task"]').get_attribute("data-id") == "available"

            guidance = show([task("blocked", "T1", deps=["MISSING"]), task("available", "T2")])
            expect(guidance).to_contain_text("有任务尚未启动")
            assert guidance.locator('[data-act="open-task"]').get_attribute("data-id") == "available"

            guidance = show([task(status="ready", deps=["MISSING"])])
            expect(guidance).to_contain_text("等待前置任务")
            expect(guidance).not_to_contain_text("有空闲名额后会自动开始")

            guidance = show([task(status="cancelled")])
            expect(guidance).to_contain_text("已取消的任务不会自动重跑")
            expect(guidance.get_by_role("button", name="查看任务", exact=True)).to_be_visible()
            guidance = show([task(status="done")])
            expect(guidance).to_contain_text("没有等待执行的任务")
            expect(guidance.get_by_role("button", name="添加任务", exact=True)).to_be_visible()
            guidance.get_by_role("button", name="添加任务", exact=True).click()
            expect(page.get_by_role("dialog", name="添加一项任务")).to_be_visible()
            page.keyboard.press("Escape")
            assert runs == ["manual"]

            guidance = show([task(status="running"), task("new", "T2")], status="draft")
            expect(guidance).to_contain_text("正在执行")
            expect(guidance).to_contain_text("其他任务不会随之自动开始")
            guidance = show([task()], status="draft")
            expect(guidance.get_by_role("button", name="开始执行", exact=True)).to_be_visible()
            guidance = show([task(status="cancelled")], status="paused")
            expect(guidance).to_contain_text("会话已暂停")
            expect(guidance).to_contain_text("已取消的任务不会自动重跑")
            guidance = show([task(status="done")], status="completed")
            expect(guidance).to_contain_text("会话已完成")

            page.set_viewport_size({"width": 390, "height": 844})
            guidance = show([task()])
            expect(guidance.get_by_role("button", name="查看任务", exact=True)).to_be_visible()
            assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "390px overflow"
            assert not errors, errors
        finally:
            close_test_browser(browser)
    print("Queue guidance, explicit task execution, owner recovery, cancelled/idle states, and 390px layout passed.", flush=True)


if __name__ == "__main__":
    main()
