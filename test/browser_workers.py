"""Browser regression test for worker discovery, empty, failed, and recovered states."""

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
    pending_workers = []
    worker_calls = 0
    errors = []

    def respond(route):
        nonlocal worker_calls
        path = urlsplit(route.request.url).path
        if path in ASSETS:
            name, mime = ASSETS[path]
            return route.fulfill(body=(WEB / name).read_bytes(), content_type=f"{mime}; charset=utf-8")
        if path == "/api/events":
            return route.fulfill(status=204)
        if path == "/api/state":
            return route.fulfill(json={"rooms": [], "running": [], "flowTemplates": [], "inbox": []})
        if path == "/api/workers":
            worker_calls += 1
            if worker_calls <= 2:
                pending_workers.append(route)
                return None
            return route.fulfill(json={"workers": [
                {"key": "codex", "label": "Codex CLI", "available": True},
                {"key": "claude", "label": "Claude Code", "available": False},
            ]})
        return route.fulfill(status=404)

    with sync_playwright() as pw:
        browser = launch_test_browser(pw)
        page = browser.new_page(viewport={"width": 390, "height": 844})
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.route("http://devhub.invalid/**", respond)
        try:
            page.goto("http://devhub.invalid/", wait_until="domcontentloaded")
            summary_state = page.locator("#worker-summary-state")
            expect(summary_state).to_have_text("检测中…")
            details = page.locator(".rail-foot")
            details.locator("summary").click()
            expect(details.locator(".worker-status")).to_contain_text("正在检测本机上的协作工具")
            assert len(pending_workers) == 1

            pending_workers.pop().fulfill(json={"workers": [
                {"key": "codex", "label": "Codex CLI", "available": False},
                {"key": "claude", "label": "Claude Code", "available": False},
                {"key": "opencode", "label": "OpenCode", "available": False},
                {"key": "agy", "label": "Antigravity", "available": False},
                {"key": "dsh", "label": "DeepSeek Harness", "available": False},
            ]})
            expect(summary_state).to_have_text("未找到可用工具")
            expect(details.locator(".worker-status")).to_contain_text("确认支持的 CLI 已安装")
            expect(details.locator(".worker-row")).to_have_count(5)
            expect(details.locator(".worker-row").nth(4)).to_be_visible()
            expect(details.get_by_role("button", name="重新检测")).to_be_visible()
            expect(details.locator(".worker-row").nth(0)).to_contain_text("未检测到")

            page.get_by_role("button", name="新建会话", exact=True).click()
            new_room = page.get_by_role("dialog", name="开始一个项目")
            expect(new_room.locator("#nr-tool-status")).to_contain_text("确认支持的 CLI 已安装或可执行路径已配置")
            expect(new_room.get_by_role("button", name="创建并生成计划")).to_be_disabled()
            page.keyboard.press("Escape")
            expect(new_room).to_have_count(0)

            details.get_by_role("button", name="重新检测").click()
            expect(summary_state).to_have_text("检测中…")
            expect(details.get_by_role("button", name="正在检测…")).to_be_disabled()
            expect(details.locator(".worker-status")).to_be_focused()
            assert worker_calls == 2 and len(pending_workers) == 1
            pending_workers.pop().fulfill(status=503, json={"error": "模拟检测失败"})
            expect(summary_state).to_have_text("检测失败")
            expect(details.get_by_role("alert")).to_contain_text("模拟检测失败")
            details.get_by_role("button", name="重新检测").click()

            expect(summary_state).to_have_text("1 个就绪")
            expect(details.locator('.worker-row:has-text("Codex CLI")')).to_contain_text("就绪")
            expect(details.locator('.worker-row:has-text("Claude Code")')).to_contain_text("未检测到")
            expect(details.locator(".worker-status")).to_have_count(0)
            expect(details.get_by_role("button", name="重新检测")).to_be_focused()
            assert worker_calls == 3
            assert page.evaluate("document.documentElement.scrollWidth === innerWidth")
            assert not errors, errors
        finally:
            for route in pending_workers:
                route.abort()
            browser.close()

    print("Worker discovery, no-tool state, detection failure, and retry recovery passed.")


if __name__ == "__main__":
    main()
