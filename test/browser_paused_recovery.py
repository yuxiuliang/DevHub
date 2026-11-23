"""Browser regression for paused sessions with canceled work and a preserved queue."""

from pathlib import Path
from urllib.parse import urlsplit

from browser_cleanup import launch_test_browser
from playwright.sync_api import expect, sync_playwright


WEB = Path(__file__).resolve().parents[1] / "web"
ASSETS = {
    "/": ("index.html", "text/html"),
    "/app.js": ("app.js", "application/javascript"),
    "/plan-draft.js": ("plan-draft.js", "application/javascript"),
    "/edit-drafts.js": ("edit-drafts.js", "application/javascript"),
    "/log-buffer.js": ("log-buffer.js", "application/javascript"),
    "/style.css": ("style.css", "text/css"),
}
ROOM_ID = "r-paused"
RUNNING_ID = "r-running"
ROOM = {
    "id": ROOM_ID, "name": "Paused work", "repo_path": "D:/project", "base_branch": "main",
    "requirement": "Check paused recovery", "status": "paused", "mode": "serial",
    "auto_approve": False, "flow": {"nodes": [], "edges": []}, "plan": None,
    "counts": {"total": 2, "running": 0, "review": 0, "failed": 0, "done": 0},
    "updated_at": "2026-11-21T00:00:00.000Z",
}
RUNNING_ROOM = {
    **ROOM,
    "id": RUNNING_ID, "name": "Active work", "status": "running",
    "counts": {"total": 1, "running": 1, "review": 0, "failed": 0, "done": 0},
}
TASKS = [
    {"id": "t-cancelled", "key": "T1", "title": "Stopped task", "status": "cancelled", "type": "code",
     "spec": "Work that was stopped", "owner_id": "m1", "deps": [], "acceptance": [], "updated_at": ROOM["updated_at"]},
    {"id": "t-ready", "key": "T2", "title": "Queued task", "status": "ready", "type": "code",
     "spec": "Work waiting in queue", "owner_id": "m1", "deps": [], "acceptance": [], "updated_at": ROOM["updated_at"]},
]


def main():
    errors = []

    def respond(route):
        path = urlsplit(route.request.url).path
        if path in ASSETS:
            name, mime = ASSETS[path]
            return route.fulfill(body=(WEB / name).read_bytes(), content_type=f"{mime}; charset=utf-8")
        if path == "/api/events":
            return route.fulfill(status=204)
        if path == "/api/workers":
            return route.fulfill(json={"workers": []})
        if path == "/api/state":
            return route.fulfill(json={"rooms": [ROOM, RUNNING_ROOM], "running": [], "activeWorkers": 0, "flowTemplates": [], "inbox": []})
        if path == f"/api/rooms/{ROOM_ID}":
            return route.fulfill(json={"room": ROOM, "tasks": TASKS, "members": [
                {"id": "m1", "name": "Worker", "worker": "codex", "enabled": True, "concurrency": 1},
            ], "events": [], "decisions": [], "reviews": []})
        return route.fulfill(status=404)

    with sync_playwright() as pw:
        browser = launch_test_browser(pw)
        page = browser.new_page(viewport={"width": 1280, "height": 800})
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.route("http://devhub.invalid/**", respond)
        try:
            page.goto("http://devhub.invalid/", wait_until="domcontentloaded")
            expect(page.get_by_role("heading", name="Paused work", exact=True)).to_be_visible()
            next_action = page.locator(".next-action")
            expect(next_action.get_by_text("会话已暂停", exact=True)).to_be_visible()
            expect(next_action).to_contain_text("继续执行只会启动等待队列")
            expect(next_action).to_contain_text("已取消的任务不会自动重跑")
            expect(next_action).to_contain_text("从任务详情中单独启动")
            expect(next_action.get_by_role("button", name="继续执行", exact=True)).to_be_visible()

            page.get_by_role("button", name="总览", exact=True).click()
            expect(page.get_by_role("heading", name="协作总览", exact=True)).to_be_visible()
            overview_card = page.locator(f'.ov-card[data-id="{ROOM_ID}"]')
            expect(overview_card.locator(".ov-status")).to_have_text("已暂停")
            expect(page.locator(f'.room-item[data-id="{ROOM_ID}"] .ri-paused')).to_have_text("已暂停")
            running_card = page.locator(f'.ov-card[data-id="{RUNNING_ID}"]')
            expect(running_card.locator(".ov-status")).to_have_count(0)
            expect(page.locator(f'.room-item[data-id="{RUNNING_ID}"] .dot.running')).to_be_visible()
            expect(page.locator(f'.room-item[data-id="{RUNNING_ID}"] .ri-paused')).to_have_count(0)
            assert not errors, errors
        finally:
            browser.close()

    print("Paused sessions now distinguish queued work from canceled tasks.")


if __name__ == "__main__":
    main()
