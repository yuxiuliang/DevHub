"""View-switch selection and keyboard-focus regression using read-only fixtures."""

from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright

from browser_cleanup import close_test_browser, launch_test_browser


WEB = Path(__file__).resolve().parents[1] / "web"
ASSETS = {"/": ("index.html", "text/html"), "/style.css": ("style.css", "text/css")}
ROOM_ID = "r-navigation"


def main():
    room = dict(id=ROOM_ID, name="键盘导航测试", requirement="检查视图切换", status="draft",
                repo_path="D:/fixture", base_branch="main", mode="serial", auto_approve=False, plan=None,
                flow=dict(name="测试流程", nodes=[dict(id="n1", type="phase", name="实现", x=40, y=80,
                                                     owner="", gate="auto", outputs=[])], edges=[]))
    task = dict(id="t-nav", key="T1", title="检查导航", type="code", status="ready", owner_id="m1",
                spec="检查焦点保留\n" * 80, deps=[], acceptance=[], summary="", diff_stat="", updated_at="initial")
    held = []
    flags = dict(hold_log=False)
    errors, writes = [], []
    revision = 0

    def respond(route):
        request = route.request
        path = urlsplit(request.url).path
        if request.method not in ["GET", "HEAD"]:
            writes.append(path)
            return route.fulfill(status=405)
        if path in ASSETS or (path.startswith("/") and path.endswith(".js") and "/" not in path[1:]):
            name, mime = ASSETS.get(path, (path[1:], "application/javascript"))
            return route.fulfill(body=(WEB / name).read_bytes(), content_type=mime + "; charset=utf-8")
        if path == "/api/workers":
            return route.fulfill(json={"workers": []})
        if path == "/api/state":
            return route.fulfill(json=dict(rooms=[dict(room, counts=dict(total=1, running=0, review=0, done=0, failed=0))],
                                           running=[], activeWorkers=0, inbox=[], flowTemplates=[]))
        if path == f"/api/rooms/{ROOM_ID}":
            return route.fulfill(json=dict(room=room, tasks=[task], events=[], reviews=[], decisions=[],
                                           members=[dict(id="m1", name="助手", worker="codex", enabled=True, concurrency=1)]))
        if path == "/api/tasks/t-nav/log":
            if flags["hold_log"]:
                held.append(route)
                return
            return route.fulfill(json=dict(log="读取成功\n", runId="run-nav", status="completed"))
        if path == "/api/tasks/t-nav/diff":
            return route.fulfill(json=dict(diff="@@ -1,80 +1,80 @@\n" + ("+" + "长改动内容" * 80 + "\n") * 80,
                                           resultSha="a" * 40))
        return route.fulfill(status=404)

    with sync_playwright() as pw:
        browser = launch_test_browser(pw)
        page = browser.new_page(viewport=dict(width=1280, height=900))
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.add_init_script("""window.EventSource = class {
            constructor() { window.navigationEvents = this; queueMicrotask(() => this.onopen?.()); }
            close() {}
        };""")
        page.route("http://devhub.invalid/**", respond)

        def refresh():
            nonlocal revision
            revision += 1
            room["requirement"] = f"实时更新 {revision}"
            task["updated_at"] = f"revision-{revision}"
            page.evaluate("""roomId => window.navigationEvents.onmessage({data: JSON.stringify({
                kind: 'event', type: 'task.status', room_id: roomId
            })})""", ROOM_ID)
            expect(page.locator(".room-req")).to_have_text(room["requirement"])

        try:
            page.goto("http://devhub.invalid/", wait_until="domcontentloaded")
            views = page.get_by_role("group", name="会话视图", exact=True)
            board = views.get_by_role("button", name="任务板", exact=True)
            flow = views.get_by_role("button", name="流程", exact=True)
            expect(board).to_have_attribute("aria-pressed", "true")
            expect(flow).to_have_attribute("aria-pressed", "false")
            board.focus()
            board.press("Tab")
            expect(flow).to_be_focused()
            flow.press("Enter")
            expect(page.locator(".flow-canvas")).to_be_visible()
            expect(flow).to_be_focused()
            expect(flow).to_have_attribute("aria-pressed", "true")
            expect(views.locator('[aria-pressed="true"]')).to_have_count(1)
            refresh()
            expect(flow).to_be_focused()
            flow.press("Shift+Tab")
            expect(board).to_be_focused()
            board.press("Space")
            expect(page.locator(".board")).to_be_visible()
            expect(board).to_be_focused()
            expect(board).to_have_attribute("aria-pressed", "true")
            refresh()
            expect(board).to_be_focused()

            task_card = page.locator('.card[data-id="t-nav"]')
            task_card.focus()
            refresh()
            expect(task_card).to_be_focused()
            task_card.press("Enter")
            dialog = page.get_by_role("dialog", name="检查导航", exact=True)
            task_views = dialog.get_by_role("group", name="任务详情视图", exact=True)
            expect(task_views.get_by_role("button", name="概览", exact=True)).to_have_attribute("aria-pressed", "true")
            drawer_body = dialog.locator('.drawer-body')
            drawer_body.evaluate('e => { e.scrollTop = 300; }')
            overview_top = drawer_body.evaluate('e => e.scrollTop')
            assert overview_top > 0
            refresh()
            assert drawer_body.evaluate('e => e.scrollTop') == overview_top
            flags["hold_log"] = True
            log = task_views.get_by_role("button", name="日志", exact=True)
            log.press("Enter")
            expect(dialog.get_by_text("正在加载…", exact=True)).to_be_visible()
            expect(log).to_be_focused()
            expect(log).to_have_attribute("aria-pressed", "true")
            assert len(held) == 1
            held.pop().fulfill(json=dict(log="读取成功\n", runId="run-nav", status="completed"))
            expect(dialog.locator("#log-box")).to_contain_text("读取成功")
            expect(log).to_be_focused()
            flags["hold_log"] = False
            for label in ["改动", "评审", "概览"]:
                button = task_views.get_by_role("button", name=label, exact=True)
                button.press("Enter")
                expect(button).to_have_attribute("aria-pressed", "true")
                expect(task_views.locator('[aria-pressed="true"]')).to_have_count(1)
                expect(button).to_be_focused()
                if label == "改动":
                    diff = dialog.locator('.diff-box')
                    expect(diff).to_be_visible()
                    diff.focus()
                    expect(diff).to_be_focused()
                    diff.evaluate('e => { e.scrollTop = 220; e.scrollLeft = 160; }')
                    diff_position = diff.evaluate('e => [e.scrollTop, e.scrollLeft]')
                    assert all(value > 0 for value in diff_position), diff_position
                    refresh()
                    expect(diff).to_be_focused()
                    assert diff.evaluate('e => [e.scrollTop, e.scrollLeft]') == diff_position
                else:
                    assert drawer_body.evaluate('e => e.scrollTop') == 0, 'A different view starts at the top'
            refresh()
            expect(task_views.get_by_role("button", name="概览", exact=True)).to_be_focused()
            expect(board).not_to_be_focused()
            page.keyboard.press("Escape")
            expect(dialog).to_have_count(0)
            expect(task_card).to_be_focused()

            # Preserve the actual opener, including its replacement after SSE.
            task['status'] = 'failed'
            refresh()
            opener = page.locator('.next-action button[data-act="open-task"]')
            opener.press('Enter')
            expect(dialog).to_be_visible()
            page.keyboard.press('Escape')
            expect(opener).to_be_focused()
            opener.press('Enter')
            refresh()
            page.keyboard.press('Escape')
            expect(opener).to_be_focused()

            task.update(status='review', diff_stat=' result.txt | 1 +', result_sha='a' * 40)
            refresh()
            result_opener = page.locator('.next-action button[data-act="open-result"]')
            result_opener.press('Enter')
            expect(dialog.locator('.diff-box')).to_be_visible()
            refresh()
            page.keyboard.press('Escape')
            expect(result_opener).to_be_focused()

            # If the action disappears while viewing, return to the task card.
            result_opener.press('Enter')
            expect(dialog.locator('.diff-box')).to_be_visible()
            task['status'] = 'done'
            refresh()
            page.keyboard.press('Escape')
            expect(task_card).to_be_focused()
            assert not errors, errors
            assert not writes, writes
        finally:
            for route in held:
                route.abort()
            close_test_browser(browser)

    print("View selection, keyboard focus, delayed drawer reads, and live-refresh isolation passed.", flush=True)


if __name__ == "__main__":
    main()
