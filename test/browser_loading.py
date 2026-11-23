"""Regression test for accurate first-load and retry states in DevHub."""

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
    pending_state = []
    state_calls = 0
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
            if state_calls <= 2:
                pending_state.append(route)
                return None
            return route.fulfill(json={"rooms": [], "running": [], "flowTemplates": [], "inbox": []})
        return route.fulfill(status=404)

    with sync_playwright() as pw:
        browser = launch_test_browser(pw)
        page = browser.new_page(viewport={"width": 1280, "height": 800})
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.route("http://devhub.invalid/**", respond)
        try:
            page.goto("http://devhub.invalid/", wait_until="domcontentloaded")
            page.set_viewport_size({"width": 390, "height": 844})
            expect(page.locator(".overview-loading")).to_be_visible()
            expect(page.locator(".overview-loading")).to_have_attribute("aria-busy", "true")
            expect(page.get_by_text("正在读取会话…", exact=True)).to_be_visible()
            expect(page.get_by_text("还没有会话", exact=True)).to_have_count(0)
            assert page.evaluate("document.documentElement.scrollWidth === innerWidth")
            assert len(pending_state) == 1

            pending_state.pop().fulfill(status=503, json={"error": "本机服务暂时不可用"})
            expect(page.get_by_role("heading", name="工作区暂时无法读取")).to_be_visible()
            expect(page.get_by_role("alert")).to_contain_text("本机服务暂时不可用")
            expect(page.get_by_text("会话暂不可用", exact=True)).to_be_visible()
            expect(page.get_by_text("还没有会话", exact=True)).to_have_count(0)

            page.get_by_role("button", name="重新连接", exact=True).click()
            expect(page.locator(".overview-loading")).to_be_visible()
            expect(page.locator(".overview-loading")).to_have_attribute("aria-busy", "true")
            assert state_calls == 2 and len(pending_state) == 1
            pending_state.pop().fulfill(json={"rooms": [], "running": [], "flowTemplates": [], "inbox": []})
            expect(page.get_by_role("heading", name="从一个项目开始")).to_be_visible()
            expect(page.get_by_role("button", name="开始一个项目", exact=True)).to_be_visible()
            assert state_calls == 2
            assert not errors, errors
        finally:
            for route in pending_state:
                route.abort()
            browser.close()

    print("Initial loading, error recovery, and empty-workspace onboarding passed.")


if __name__ == "__main__":
    main()
