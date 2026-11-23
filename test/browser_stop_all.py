"""Browser regression test for the cross-room stop-all control."""

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


def main():
    state_calls = 0
    active_workers = 2
    pending_stop = []
    stop_calls = []
    dialogs = []
    errors = []

    def respond(route):
        nonlocal state_calls
        path = urlsplit(route.request.url).path
        if path in ASSETS:
            name, mime = ASSETS[path]
            return route.fulfill(body=(WEB / name).read_bytes(), content_type=f"{mime}; charset=utf-8")
        if path == "/api/events":
            return route.fulfill(status=204)
        if path == "/api/workers":
            return route.fulfill(json={"workers": []})
        if path == "/api/state":
            state_calls += 1
            return route.fulfill(json={"rooms": [], "running": [], "flowTemplates": [], "inbox": [], "activeWorkers": active_workers})
        if path == "/api/stop-all":
            assert route.request.method == "POST"
            stop_calls.append(route.request.method)
            pending_stop.append(route)
            return None
        return route.fulfill(status=404)

    with sync_playwright() as pw:
        browser = launch_test_browser(pw)
        page = browser.new_page(viewport={"width": 390, "height": 844})
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("dialog", lambda dialog: (dialogs.append(dialog.message), dialog.dismiss()))
        page.route("http://devhub.invalid/**", respond)
        try:
            page.goto("http://devhub.invalid/", wait_until="domcontentloaded")
            stop_button = page.locator("#btn-stop-all")
            expect(stop_button).to_be_visible()
            expect(stop_button).to_have_text("停止所有运行（2）")
            expect(stop_button).to_have_attribute("title", "停止执行中的任务、计划和检查；受影响的会话会暂停，队列和工作区会保留。")
            assert page.evaluate("document.documentElement.scrollWidth === innerWidth")

            stop_button.click()
            expect(stop_button).to_be_disabled()
            expect(stop_button).to_have_text("正在停止…")
            assert stop_calls == ["POST"] and len(pending_stop) == 1
            active_workers = 0
            pending_stop.pop().fulfill(json={"stopped": 2})
            expect(page.get_by_text("已请求停止 2 项运行。会话已暂停，等待任务和工作区会保留。", exact=True)).to_be_visible()
            expect(stop_button).to_be_hidden()
            assert state_calls >= 2
            assert not dialogs, dialogs
            assert not errors, errors
        finally:
            for route in pending_stop:
                route.abort()
            browser.close()

    print("Cross-room stop, pending feedback, queue-preserving message, and idle hiding passed.")


if __name__ == "__main__":
    main()
