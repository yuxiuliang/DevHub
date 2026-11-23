"""Browser regression for cost, token, and runtime metrics in task history."""

from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright

from browser_cleanup import close_test_browser, launch_test_browser


WEB = Path(__file__).resolve().parents[1] / "web"
ASSETS = {
    "/": ("index.html", "text/html"),
    "/app.js": ("app.js", "application/javascript"),
    "/plan-draft.js": ("plan-draft.js", "application/javascript"),
    "/edit-drafts.js": ("edit-drafts.js", "application/javascript"),
    "/log-buffer.js": ("log-buffer.js", "application/javascript"),
    "/style.css": ("style.css", "text/css"),
}
ROOM_ID = "r-metrics"
START = "2026-11-21T10:00:00.000Z"
ROOM = {
    "id": ROOM_ID, "name": "Usage visibility", "repo_path": "D:/project", "base_branch": "main",
    "requirement": "Show run metrics", "status": "completed", "mode": "serial", "auto_approve": False,
    "flow": {"nodes": [], "edges": []}, "plan": None,
    "counts": {"total": 3, "running": 0, "review": 0, "failed": 0, "done": 3},
    "updated_at": START,
}
TASKS = [
    {"id": "t-tokens", "key": "T1", "title": "Token run", "status": "done", "type": "code", "spec": "", "owner_id": "m1",
     "deps": [], "acceptance": [], "summary": "done", "diff_stat": "", "updated_at": START},
    {"id": "t-cost", "key": "T2", "title": "Cost run", "status": "done", "type": "code", "spec": "", "owner_id": "m1",
     "deps": [], "acceptance": [], "summary": "done", "diff_stat": "", "updated_at": START},
    {"id": "t-elapsed", "key": "T3", "title": "Elapsed run", "status": "done", "type": "code", "spec": "", "owner_id": "m1",
     "deps": [], "acceptance": [], "summary": "done", "diff_stat": "", "updated_at": START},
]
EVENTS = [
    {"id": 1, "room_id": ROOM_ID, "task_id": "t-tokens", "run_id": "run-tokens", "type": "task.started", "payload": {}, "created_at": START},
    {"id": 2, "room_id": ROOM_ID, "task_id": "t-tokens", "run_id": "run-tokens", "type": "task.finished",
     "payload": {"key": "T1", "cost": 0.012345, "usage": {"input_tokens": 1234, "output_tokens": 66, "total_tokens": 1300}},
     "created_at": "2026-11-21T10:01:05.000Z"},
    {"id": 3, "room_id": ROOM_ID, "task_id": "t-cost", "run_id": "run-cost", "type": "task.started", "payload": {}, "created_at": START},
    {"id": 4, "room_id": ROOM_ID, "task_id": "t-cost", "run_id": "run-cost", "type": "task.finished",
     "payload": {"key": "T2", "cost": 0.004, "usage": {"provider_specific": True}},
     "created_at": "2026-11-21T10:02:03.000Z"},
    {"id": 5, "room_id": ROOM_ID, "task_id": "t-elapsed", "run_id": "run-elapsed", "type": "task.started", "payload": {}, "created_at": START},
    {"id": 6, "room_id": ROOM_ID, "task_id": "t-elapsed", "run_id": "run-elapsed", "type": "task.finished",
     "payload": {"key": "T3", "usage": None}, "created_at": "2026-11-21T10:00:09.000Z"},
]


# Incomplete counts stay visibly incomplete, including a tiny positive cost.
for number, usage, cost in [
    (4, {"input_tokens": 2400}, 0.00000001),
    (5, {"input_tokens": 10, "output_tokens": 20, "cache_read_input_tokens": 70}, None),
]:
    task_id, run_id = f"t-extra-{number}", f"run-extra-{number}"
    TASKS.append({**TASKS[0], "id": task_id, "key": f"T{number}", "title": f"Partial run {number}"})
    EVENTS.extend([
        dict(id=len(EVENTS) + 1, room_id=ROOM_ID, task_id=task_id, run_id=run_id,
             type="task.started", payload={}, created_at=START),
        dict(id=len(EVENTS) + 2, room_id=ROOM_ID, task_id=task_id, run_id=run_id,
             type="task.finished", payload=dict(key=f"T{number}", usage=usage, cost=cost),
             created_at="2026-11-21T10:00:09.000Z"),
    ])
ROOM["counts"].update(total=len(TASKS), done=len(TASKS))


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
            return route.fulfill(json={"rooms": [ROOM], "running": [], "activeWorkers": 0, "flowTemplates": [], "inbox": []})
        if path == f"/api/rooms/{ROOM_ID}":
            return route.fulfill(json={"room": ROOM, "tasks": TASKS, "members": [
                {"id": "m1", "name": "Worker", "worker": "codex", "enabled": True, "concurrency": 1},
            ], "events": EVENTS, "decisions": [], "reviews": []})
        return route.fulfill(status=404)

    with sync_playwright() as pw:
        browser = launch_test_browser(pw)
        page = browser.new_page(viewport={"width": 1280, "height": 800})
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.route("http://devhub.invalid/**", respond)
        try:
            page.goto("http://devhub.invalid/", wait_until="domcontentloaded")
            timeline = page.locator(".timeline")
            token_event = timeline.locator(".tl-item").filter(has_text="T1 执行完成")
            expect(token_event).to_contain_text("费用 $0.012345 USD")
            expect(token_event).to_contain_text("用量 1,300 tokens")
            expect(token_event).not_to_contain_text("耗时")

            cost_event = timeline.locator(".tl-item").filter(has_text="T2 执行完成")
            expect(cost_event).to_contain_text("费用 $0.004 USD")
            expect(cost_event).to_contain_text("耗时 2分 3秒")

            elapsed_event = timeline.locator(".tl-item").filter(has_text="T3 执行完成")
            expect(elapsed_event).to_contain_text("耗时 9秒")

            partial_event = timeline.locator(".tl-item").filter(has_text="T4 执行完成")
            expect(partial_event).to_contain_text("输入 2,400 tokens")
            expect(partial_event).not_to_contain_text("用量")
            expect(partial_event).not_to_contain_text("输出")
            expect(partial_event).to_contain_text("费用 <$0.000001 USD")
            expect(partial_event).not_to_contain_text("费用 $0 USD")

            separate_event = timeline.locator(".tl-item").filter(has_text="T5 执行完成")
            expect(separate_event).to_contain_text("输入 10 tokens")
            expect(separate_event).to_contain_text("输出 20 tokens")
            expect(separate_event).not_to_contain_text("用量 30")
            expect(separate_event).not_to_contain_text("用量 100")
            assert not errors, errors
        finally:
            close_test_browser(browser)

    print("Timeline preserves reported totals, partial token counts, tiny costs, and duration fallback.", flush=True)


if __name__ == "__main__":
    main()
