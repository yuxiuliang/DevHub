"""Verify settings and workflow editing against isolated real Node/Rust backends."""

import argparse
from copy import deepcopy
import os
from pathlib import Path
import shutil
import tempfile

from playwright.sync_api import expect, sync_playwright

from browser_cleanup import close_test_browser, launch_test_browser
from browser_flow import ROOT, make_fixture, serve_fixture


def response_json(response, status=200):
    data = response.json()
    assert response.status == status, (response.status, data)
    return data


def verify_editing(browser, url, repo):
    page = browser.new_page(viewport={"width": 1280, "height": 900})
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.on("dialog", lambda dialog: dialog.accept())
    created = response_json(page.request.post(url + "/api/rooms", data={
        "name": "设置验证项目", "repoPath": str(repo), "requirement": "验证编辑保存",
        "members": [{"name": "协作助手", "worker": "codex"}],
        "mode": "serial", "autoApprove": False,
    }))
    room_id = created["room"]["id"]
    settings_url = f"{url}/api/rooms/{room_id}/settings"
    room_url = f"{url}/api/rooms/{room_id}"
    try:
        page.goto(url, wait_until="domcontentloaded")
        page.get_by_role("button", name="设置", exact=True).click()
        dialog = page.get_by_role("dialog", name="会话设置")
        dialog.get_by_label("会话名", exact=True).fill("保存后的项目名")
        dialog.get_by_label("想完成的事", exact=True).fill("保存需求和成员应一起生效")
        dialog.locator("#settings-advanced > summary").click()
        dialog.get_by_role("button", name="添加成员", exact=True).click()
        added = dialog.locator("[data-mrow]").last
        added.get_by_label("名字", exact=True).fill("检查助手")
        key = added.get_attribute("data-key")
        dialog.get_by_label("谁做评审", exact=True).select_option(key)
        dialog.get_by_role("button", name="稍后继续", exact=True).click()
        page.reload(wait_until="domcontentloaded")
        page.get_by_role("button", name="设置", exact=True).click()
        expect(dialog.get_by_label("会话名", exact=True)).to_have_value("保存后的项目名")
        dialog.get_by_role("button", name="保存设置", exact=True).click()
        expect(dialog).to_have_count(0, timeout=10000)
        settings = response_json(page.request.get(settings_url))
        assert settings["settings"]["name"] == "保存后的项目名"
        assert settings["settings"]["requirement"] == "保存需求和成员应一起生效"
        assert len(settings["settings"]["members"]) == 2
        reviewer = next(member for member in settings["settings"]["members"] if member["name"] == "检查助手")
        assert reviewer["id"] == settings["settings"]["reviewerKey"]
        assert reviewer["id"] != key, "Draft keys must resolve to persisted member IDs"

        # A late invalid field cannot leave the name or members partly saved.
        invalid = deepcopy(settings["settings"])
        invalid["name"] = "不应被单独保存的名字"
        invalid["members"][-1]["worker"] = "unknown-worker"
        response_json(page.request.patch(settings_url, data={"version": settings["version"], "settings": invalid}), 400)
        assert response_json(page.request.get(settings_url)) == settings

        page.get_by_role("button", name="设置", exact=True).click()
        dialog.get_by_label("会话名", exact=True).fill("页面里未保存的草稿")
        latest = deepcopy(settings["settings"])
        latest["name"] = "另一个窗口的新名字"
        external = response_json(page.request.patch(settings_url, data={"version": settings["version"], "settings": latest}))
        dialog.get_by_role("button", name="保存设置", exact=True).click()
        expect(dialog.get_by_role("alert")).to_contain_text("其他地方更新")
        expect(dialog.get_by_label("会话名", exact=True)).to_have_value("页面里未保存的草稿")
        expect(dialog.get_by_role("button", name="保存设置", exact=True)).to_be_disabled()
        assert response_json(page.request.get(settings_url)) == external
        dialog.get_by_role("button", name="重新加载已保存设置", exact=True).click()
        expect(dialog.get_by_label("会话名", exact=True)).to_have_value("另一个窗口的新名字")
        page.keyboard.press("Escape")

        # Workflow edits remain drafts until explicitly saved, including on reload.
        original = response_json(page.request.get(room_url))["room"]["flow"]
        page.get_by_role("button", name="流程", exact=True).click()
        page.locator(".fnode").first.press("Enter")
        name = page.get_by_label("阶段名称", exact=True)
        expect(name).to_be_focused()
        name.fill("保留后再保存的阶段")
        page.reload(wait_until="domcontentloaded")
        page.get_by_role("button", name="流程", exact=True).click()
        expect(page.locator(".fnode").first).to_contain_text("保留后再保存的阶段")
        assert response_json(page.request.get(room_url))["room"]["flow"] == original
        page.get_by_role("button", name="保存流程", exact=True).click()
        expect(page.get_by_text("当前显示已保存的流程。", exact=True)).to_be_visible()
        saved = response_json(page.request.get(room_url))["room"]["flow"]
        assert saved["nodes"][0]["name"] == "保留后再保存的阶段"
        assert saved != original
        response_json(page.request.patch(room_url, data={"flow": original, "expectedFlow": original}), 409)
        assert response_json(page.request.get(room_url))["room"]["flow"] == saved
        response_json(page.request.patch(room_url, data={"flow": original}), 400)

        page.set_viewport_size({"width": 390, "height": 844})
        page.locator(".fnode").first.press("Enter")
        expect(name).to_have_value("保留后再保存的阶段")
        expect(name).to_be_focused()
        assert page.evaluate("document.documentElement.scrollWidth === innerWidth")
        page.get_by_role("button", name="设置", exact=True).click()
        expect(dialog.get_by_label("会话名", exact=True)).to_have_value("另一个窗口的新名字")
        page.keyboard.press("Escape")
        assert not errors, errors
    finally:
        page.close()


def run_case(browser, backend, rust_exe):
    with tempfile.TemporaryDirectory(prefix="devhub-settings-") as temporary:
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
            verify_editing(browser, url, repo)
    assert not directory.exists(), "Editing fixture must clean up after the process tree exits"
    print(f"{backend}: real settings save, rollback, conflict, draft recovery and workflow CAS passed")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backend", choices=("all", "node", "rust"), default="all")
    parser.add_argument("--rust-exe", type=Path, default=ROOT / "rust" / "target" / "debug" / "devhub.exe")
    args = parser.parse_args()
    if os.name != "nt":
        parser.error("Uses the Windows worker fixture from browser_flow.py")
    with sync_playwright() as pw:
        browser = launch_test_browser(pw)
        try:
            for backend in (("node", "rust") if args.backend == "all" else (args.backend,)):
                run_case(browser, backend, args.rust_exe.resolve())
        finally:
            close_test_browser(browser)


if __name__ == "__main__":
    main()
