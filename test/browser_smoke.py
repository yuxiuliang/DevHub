"""Opt-in onboarding regression smoke test: python test/browser_smoke.py (Playwright + Edge)."""

from collections import Counter
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
MEMBER = {"id": "m_test", "name": "协作助手", "worker": "codex", "enabled": True, "concurrency": 1}
PLAN = {"tasks": [
    {"title": "检查现状"}, {"title": "移除我"},
    {"title": "实现筛选", "dependsOn": [1, 2]}, {"title": "验收", "dependsOn": [3]},
]}


def main():
    rooms = {}
    created = []
    applied = []
    plan_attempts = Counter()
    starts = []
    manual_created = []
    delayed_plans = {}
    errors = []

    def new_room(room_id, name, repo_path="D:/project"):
        room = dict(id=room_id, name=name, repo_path=repo_path, base_branch="main", requirement=name,
                    status="draft", mode="serial", auto_approve=False, flow={"nodes": [], "edges": []}, plan=None)
        rooms[room_id] = dict(room=room, tasks=[], members=[MEMBER], decisions=[], reviews=[], events=[])
        return room

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
            counts = dict(total=0, running=0, review=0, failed=0, done=0)
            # Put the most-recent archived room first: onboarding must skip it.
            ordered = sorted(rooms.values(), key=lambda data: data["room"]["status"] != "archived")
            return route.fulfill(json={"rooms": [dict(r["room"], counts=counts) for r in ordered],
                                       "running": [], "flowTemplates": []})
        if path == "/api/rooms":
            assert route.request.method == "POST"
            body = route.request.post_data_json
            if body["repoPath"] == "错误路径":
                return route.fulfill(status=400, json={"error": "请选择已有 Git 记录的项目"})
            created.append(body)
            room_id = "r_one" if len(created) == 1 else "r_recent"
            room = new_room(room_id, body["name"], body["repoPath"])
            if len(created) == 1:
                new_room("r_existing", "已有草稿项目")
                archived = new_room("r_archived", "已归档项目", "D:/archived-project")
                archived["status"] = "archived"
            return route.fulfill(json={"room": room})
        if path.startswith("/api/rooms/"):
            _, _, _, room_id, *action = path.split("/")
            data = rooms[room_id]
            if action == ["plan"]:
                assert route.request.method == "POST"
                plan_attempts[room_id] += 1
                if room_id == "r_one" and plan_attempts[room_id] == 1:
                    return route.fulfill(status=500, json={"error": "计划暂时不可用，请重试"})
                data["room"]["plan"] = PLAN
                if room_id in {"r_existing", "r_recent"}:
                    delayed_plans[room_id] = route
                    return None
                return route.fulfill(json={"plan": PLAN})
            if action == ["plan", "apply"]:
                applied.append(route.request.post_data_json["plan"])
                data["room"]["plan"] = None
                data["tasks"] = [dict(id="t_one", key="T1", status="ready", title="检查现状", owner_id="m_test", type="code")]
            if action == ["start"]:
                assert route.request.method == "POST"
                starts.append(room_id)
                if len(starts) == 1:
                    return route.fulfill(status=500, json={"error": "模拟启动暂时失败，请手动重试"})
                data["room"]["status"] = "running"
            return route.fulfill(json=data)
        if path == "/api/tasks":
            payload = route.request.post_data_json
            manual_created.append(payload)
            data = rooms[payload["roomId"]]
            data["tasks"].append(dict(id="t_manual", key="T2", status="backlog", title=payload["title"], spec=payload["spec"], owner_id=payload["ownerId"], type=payload["type"]))
            return route.fulfill(json={"id": "t_manual"})
        if path == "/api/tasks/t_one/diff":
            return route.fulfill(json={"diff": "", "resultSha": ""})
        return route.fulfill(status=404)

    with sync_playwright() as pw:
        browser = launch_test_browser(pw)
        page = browser.new_page(viewport={"width": 1280, "height": 800})
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.route("http://devhub.invalid/**", respond)
        try:
            page.goto("http://devhub.invalid/", wait_until="domcontentloaded")
            page.get_by_role("button", name="开始一个项目", exact=True).press("Enter")
            form = page.get_by_role("dialog", name="开始一个项目")
            repo = form.get_by_label("项目文件夹")
            requirement = form.get_by_label("你想做什么？")
            expect(requirement).to_be_focused()
            expect(repo).to_have_value("")
            expect(form.get_by_label("会话名（选填）")).to_be_hidden()
            repo.fill("错误路径")
            requirement.fill("添加订单筛选")
            form.get_by_role("button", name="创建并生成计划", exact=True).press("Enter")
            expect(form.get_by_role("alert")).to_contain_text("请选择已有 Git 记录的项目")
            expect(requirement).to_have_value("添加订单筛选")
            assert not plan_attempts and not starts

            repo.fill("D:/project")
            form.get_by_role("button", name="创建并生成计划", exact=True).press("Enter")
            expect(page.get_by_role("heading", name="添加订单筛选", exact=True)).to_be_visible()
            expect(page.locator(".plan-retry h3", has_text="计划没生成出来")).to_be_visible(timeout=20000)
            retry = page.get_by_role("button", name="重新生成计划", exact=True)
            expect(retry).to_be_visible()
            assert len(created) == 1 and plan_attempts["r_one"] == 1 and not starts
            assert created[0]["mode"] == "serial" and not created[0]["autoApprove"]
            assert len(created[0]["members"]) == 1

            # Failure remains actionable after leaving and reopening the same room.
            page.get_by_role("button", name="总览", exact=True).click()
            page.locator('.room-item[data-id="r_one"]').press("Enter")
            expect(page.locator('.plan-retry h3', has_text="计划没生成出来")).to_be_visible()
            retry.press("Enter")
            plan = page.get_by_role("dialog", name="确认计划")
            expect(plan).to_be_visible()
            assert len(created) == 1 and plan_attempts["r_one"] == 2 and not starts
            plan.get_by_label("任务 3 标题").fill("实现新版筛选")
            plan.get_by_role("button", name="移除任务 2").click()
            expect(plan.get_by_label("任务 2 标题")).to_have_value("实现新版筛选")
            assert not starts, "Plan editing must not execute tasks before confirmation"
            plan.get_by_role("button", name="确认并开始执行", exact=True).click()
            start = page.locator(".next-action").get_by_role("button", name="开始执行", exact=True)
            expect(start).to_be_visible()
            expect(page.locator('.card[data-id="t_one"]')).to_contain_text("检查现状")
            assert [task["dependsOn"] for task in applied[0]["tasks"]] == [[], [1], [2]]
            assert starts == ["r_one"], "Confirmation starts the existing room exactly once"
            assert len(created) == 1 and len(applied) == 1, "Failed start must retain the applied tasks"
            expect(page.get_by_role("heading", name="任务已准备好，但没有开始", exact=True)).to_be_visible()
            page.locator('.next-action[aria-label="执行未开始"] summary').click()
            expect(page.get_by_text("模拟启动暂时失败，请手动重试", exact=True)).to_be_visible()
            start.click()
            expect(page.get_by_role("button", name="暂停", exact=True)).to_be_visible()
            assert starts == ["r_one", "r_one"]

            # Existing draft rooms keep the separate generate-plan action.
            page.locator('.room-item[data-id="r_existing"]').press("Enter")
            assert plan_attempts["r_existing"] == 0
            page.get_by_role("button", name="生成计划", exact=True).click()
            expect(page.get_by_text("正在生成计划", exact=True)).to_be_visible()
            page.locator('.room-item[data-id="r_one"]').press("Enter")
            expect(page.get_by_role("heading", name="添加订单筛选", exact=True)).to_be_visible()
            delayed_plans.pop("r_existing").fulfill(json={"plan": PLAN})
            expect(plan).to_have_count(0)

            # Recent projects work on a narrow screen with native keyboard actions.
            page.set_viewport_size({"width": 390, "height": 844})
            new_button = page.locator('[data-act="new-room"]').first
            new_button.press("Enter")
            expect(repo).to_have_value("D:/project")
            expect(requirement).to_be_focused()
            recent = form.locator('[data-act="recent-project"][data-path="D:/project"]').first
            expect(recent).to_be_visible()
            repo.fill("D:/another-project")
            recent.press("Enter")
            expect(repo).to_have_value("D:/project")
            expect(requirement).to_be_focused()
            page.keyboard.press("Escape")
            expect(form).to_have_count(0)
            expect(new_button).to_be_focused()
            assert len(created) == 1 and starts == ["r_one", "r_one"]
            new_button.press("Enter")
            expect(repo).to_have_value("D:/project")
            expect(requirement).to_be_focused()
            requirement.fill("快速新需求")
            assert page.evaluate("document.documentElement.scrollWidth === innerWidth")
            form.get_by_role("button", name="创建并生成计划", exact=True).press("Enter")
            expect(page.get_by_role("heading", name="快速新需求", exact=True)).to_be_visible()
            expect(page.get_by_text("正在生成计划", exact=True)).to_be_visible()
            assert len(created) == 2 and plan_attempts["r_recent"] == 1
            assert starts == ["r_one", "r_one"]
            page.locator('.room-item[data-id="r_one"]').press("Enter")
            expect(page.get_by_role("heading", name="添加订单筛选", exact=True)).to_be_visible()
            delayed_plans.pop("r_recent").fulfill(json={"plan": PLAN})
            expect(plan).to_have_count(0)
            assert starts == ["r_one", "r_one"], "A late automatic plan must not execute or show in another room"

            page.locator('.card[data-id="t_one"]').press("Enter")
            page.get_by_role("button", name="改动", exact=True).click()
            expect(page.get_by_text("这个任务还没有可查看的改动。")).to_be_visible()
            page.keyboard.press("Escape")

            rooms["r_one"]["room"]["status"] = "paused"
            task = rooms["r_one"]["tasks"][0]
            task.update(status="failed", summary="服务重启中断了任务。确认工具已停止后，可以重新运行。")
            page.locator('.room-item[data-id="r_one"]').press("Enter")
            page.locator('.card[data-id="t_one"]').press("Enter")
            assert page.evaluate("document.documentElement.scrollWidth === innerWidth")
            expect(page.get_by_text("确认工具已停止后，可以重新运行。", exact=False)).to_be_visible()
            expect(page.get_by_role("button", name="重新运行", exact=True)).to_be_visible()
            page.keyboard.press("Escape")
            page.locator(".room-more summary").click()
            page.get_by_role("button", name="手动添加任务", exact=True).click()
            task_form = page.get_by_role("dialog", name="添加一项任务")
            description = task_form.get_by_label("要完成什么？")
            expect(description).to_be_focused()
            expect(task_form.get_by_label("标题")).to_be_hidden()
            expect(task_form.get_by_label("负责人")).to_be_hidden()
            description.fill("编写快速上手说明文档")
            expect(task_form.get_by_label("标题")).to_have_value("编写快速上手说明文档")
            assert task_form.get_by_label("任务类型").input_value() == "document"
            task_form.get_by_role("button", name="添加任务", exact=True).click()
            expect(task_form).to_have_count(0)
            assert len(manual_created) == 1
            assert manual_created[0]["title"] == "编写快速上手说明文档"
            assert manual_created[0]["type"] == "document"
            assert manual_created[0]["ownerId"] == "m_test"
            assert manual_created[0]["acceptance"] == []
            assert not errors, errors
        finally:
            for route in delayed_plans.values():
                route.abort()
            browser.close()

    print("Automatic planning, same-room retry, explicit execution, recent projects, room isolation, and recovery passed.")


if __name__ == "__main__":
    main()
