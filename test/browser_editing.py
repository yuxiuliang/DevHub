"""Settings/flow draft regression with an in-memory server, no real workers or project data."""
import argparse
from copy import deepcopy
import json
import traceback
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright

from browser_cleanup import close_test_browser, launch_test_browser

WEB = Path(__file__).resolve().parents[1] / 'web'


def main(screenshots=None):
    def member(key, name):
        return dict(key=key, id=key, name=name, worker='codex', role_name='', role_brief='', model='', concurrency=1, enabled=True)

    initial_flow = dict(name='代码流程', nodes=[
        dict(id='n1', name='实现', type='phase', x=40, y=80, owner='', gate='auto', outputs=[]),
        dict(id='n2', name='检查', type='phase', x=300, y=80, owner='', gate='human', outputs=[]),
    ], edges=[{'from': 'n1', 'to': 'n2', 'condition': 'passed'}])
    settings = dict(name='项目一', requirement='增加筛选', mode='serial', autoApprove=False,
                    plannerKey='m_one', reviewerKey='m_two', members=[member('m_one', '执行助手'), member('m_two', '检查助手')])
    settings['members'][0]['role_brief'] = '实现功能\n执行验收'
    rooms = {
        'r_one': dict(id='r_one', name='项目一', requirement='增加筛选', status='draft', repo_path='D:/demo', base_branch='main',
                      mode='serial', auto_approve=False, flow=deepcopy(initial_flow), plan=None),
        'r_two': dict(id='r_two', name='另一个会话', requirement='其他任务', status='draft', repo_path='D:/other', base_branch='main',
                      mode='serial', auto_approve=False, flow=deepcopy(initial_flow), plan=None),
    }
    writes, errors, held, held_flows, held_rooms = [], [], [], [], []
    counts = dict(settings=0, flow=0)
    flags = dict(hold_settings=False, hold_flow=False, hold_room=None, busy=False, fail_settings_read=False, fail_state=False)

    def version():
        return json.dumps(settings, ensure_ascii=False)

    def settings_response():
        return dict(roomId='r_one', archived=False, version=version(), settings=deepcopy(settings))

    def canonicalize(payload):
        updated = deepcopy(payload['settings'])
        keys = {}
        for index, item in enumerate(updated['members']):
            keys[item['key']] = item.get('id') or f'm_created_{index}'
            item['key'] = item['id'] = keys[item['key']]
        updated['plannerKey'] = keys[updated['plannerKey']]
        updated['reviewerKey'] = keys[updated['reviewerKey']]
        settings.clear()
        settings.update(updated)
        rooms['r_one']['name'] = settings['name']
        rooms['r_one']['requirement'] = settings['requirement']
        return settings_response()

    def respond(route):
        request = route.request
        path = urlsplit(request.url).path
        if path in ['/', '/app.js', '/plan-draft.js', '/log-buffer.js', '/edit-drafts.js', '/style.css']:
            name = 'index.html' if path == '/' else path[1:]
            mime = {'html': 'text/html', 'js': 'application/javascript', 'css': 'text/css'}[name.rsplit('.', 1)[1]]
            return route.fulfill(body=(WEB / name).read_bytes(), content_type=mime + '; charset=utf-8')
        if path == '/api/workers':
            return route.fulfill(json={'workers': [dict(key='codex', label='Codex', available=True)]})
        if path == '/api/state':
            if flags['fail_state']:
                flags['fail_state'] = False
                return route.fulfill(status=503, json={'error': '状态暂时不可用'})
            return route.fulfill(json=dict(rooms=[dict(room, counts=dict(total=0, running=0, review=0, done=0, failed=0)) for room in rooms.values()],
                                          running=[], inbox=[], flowTemplates=[]))
        if path == '/api/rooms/r_one/settings':
            if request.method == 'GET':
                if flags['fail_settings_read']:
                    flags['fail_settings_read'] = False
                    return route.fulfill(status=503, json={'error': '已保存设置暂时读取失败，请重试'})
                return route.fulfill(json=settings_response())
            writes.append((path, request.post_data_json))
            counts['settings'] += 1
            payload = request.post_data_json
            if counts['settings'] == 1:
                return route.fulfill(status=500, json={'error': '保存暂时失败，请重试'})
            if payload['version'] != version():
                return route.fulfill(status=409, json={'error': '设置已在其他地方更新，请重新加载最新设置后再保存'})
            if flags['hold_settings']:
                held.append((route, payload))
                return
            return route.fulfill(json=canonicalize(payload))
        if path.startswith('/api/rooms/'):
            room_id = path.rsplit('/', 1)[1]
            room = rooms[room_id]
            if request.method == 'PATCH':
                payload = request.post_data_json
                writes.append((path, payload))
                counts['flow'] += 1
                if counts['flow'] == 1:
                    return route.fulfill(status=500, json={'error': '流程保存暂时失败'})
                if payload['expectedFlow'] != room['flow']:
                    return route.fulfill(status=409, json={'error': '流程已在其他地方更新，请重新加载最新流程后再保存'})
                if flags['hold_flow']:
                    held_flows.append((route, payload))
                    return
                room['flow'] = deepcopy(payload['flow'])
            tasks = [dict(id='t_busy', key='T1', title='执行中任务', status='running', type='code', owner_id='m_one')] if flags['busy'] else []
            members = [dict(item, role_name='', role_brief='') for item in settings['members']]
            result = dict(room=deepcopy(room), tasks=tasks, members=members, events=[], decisions=[], reviews=[])
            if request.method == 'GET' and flags['hold_room'] == room_id:
                flags['hold_room'] = None
                held_rooms.append((route, result))
                return
            return route.fulfill(json=result)
        writes.append((path, request.method))
        return route.fulfill(status=404)

    with TemporaryDirectory(prefix='devhub-edit-ui-') as temporary, sync_playwright() as pw:
        output = screenshots or Path(temporary)
        output.mkdir(parents=True, exist_ok=True)
        browser = launch_test_browser(pw)
        page = browser.new_page(viewport={'width': 1280, 'height': 900})
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('dialog', lambda dialog: dialog.accept())
        page.add_init_script("""window.EventSource = class {
          constructor() { window.editEvents=this; queueMicrotask(() => this.onopen?.()); }
          close() {}
        };""")
        page.route('http://devhub.invalid/**', respond)
        try:
            page.goto('http://devhub.invalid/', wait_until='domcontentloaded')
            page.get_by_role('button', name='设置', exact=True).click()
            dialog = page.get_by_role('dialog', name='会话设置')
            expect(dialog.get_by_label('会话名', exact=True)).to_have_value('项目一')
            expect(dialog.get_by_role('button', name='保存设置', exact=True)).to_be_disabled()
            dialog.get_by_label('会话名', exact=True).fill('我的草稿')
            dialog.locator('#settings-advanced > summary').click()
            dialog.locator('[data-mrow]').first.locator('[data-m="name"]').fill('执行者改名')
            dialog.get_by_role('button', name='添加成员', exact=True).click()
            expect(dialog.locator('[data-mrow]')).to_have_count(3)
            added = dialog.locator('[data-mrow]').last
            added.locator('[data-m="name"]').fill('新计划助手')
            key = added.get_attribute('data-key')
            dialog.get_by_label('谁做计划').select_option(key)
            expect(dialog.get_by_label('谁做计划')).to_have_value(key)
            dialog.get_by_role('button', name='添加成员', exact=True).click()
            dialog.get_by_role('button', name='添加成员', exact=True).click()
            dialog.locator('[data-mrow]').nth(3).get_by_role('button', name='移除成员').click()
            dialog.get_by_role('button', name='添加成员', exact=True).click()
            expect(dialog.locator('[data-mrow]').last.get_by_label('名字', exact=True)).to_have_value('成员 6')
            ids = dialog.locator('[id]').evaluate_all('(elements) => elements.map(element => element.id)')
            assert len(ids) == len(set(ids)), 'Member labels must keep unique targets after remove/add'
            dialog.locator('[data-mrow]').last.get_by_role('button', name='移除成员').click()
            dialog.locator('[data-mrow]').last.get_by_role('button', name='移除成员').click()
            expect(dialog.locator('[data-mrow]')).to_have_count(3)
            dialog.get_by_label('会话名', exact=True).focus()
            page.evaluate("editEvents.onmessage({data:JSON.stringify({kind:'event',room_id:'r_one',type:'task.status'})})")
            expect(dialog.get_by_label('会话名', exact=True)).to_have_value('我的草稿')
            assert counts['settings'] == 0
            page.keyboard.press('Escape')
            page.reload(wait_until='domcontentloaded')
            page.get_by_role('button', name='设置', exact=True).click()
            expect(dialog.get_by_label('会话名', exact=True)).to_have_value('我的草稿')
            expect(dialog.get_by_text('已恢复未保存的草稿。保存后一起生效。')).to_be_visible()
            dialog.locator('#settings-advanced > summary').click()
            expect(dialog.get_by_label('谁做计划')).to_have_value(key)
            expect(dialog.locator('[data-mrow]').first.locator('[data-m="name"]')).to_have_value('执行者改名')
            expect(dialog.locator('[data-mrow]').first.get_by_label('分工（选填）', exact=True)).to_have_value('实现功能\n执行验收')
            save = dialog.get_by_role('button', name='保存设置', exact=True)
            save.click()
            expect(dialog.get_by_role('alert')).to_have_text('保存暂时失败，请重试')
            expect(dialog.get_by_label('会话名', exact=True)).to_have_value('我的草稿')
            assert settings['name'] == '项目一' and len(settings['members']) == 2
            save.click()
            expect(dialog).to_have_count(0)
            assert counts['settings'] == 2
            assert settings['name'] == '我的草稿' and len(settings['members']) == 3, settings
            assert settings['members'][0]['role_brief'] == '实现功能\n执行验收'
            assert settings['plannerKey'] == settings['members'][-1]['id']

            page.get_by_role('button', name='设置', exact=True).click()
            dialog.get_by_label('会话名', exact=True).fill('冲突草稿')
            settings['name'] = '外部窗口改名'
            rooms['r_one']['name'] = settings['name']
            dialog.get_by_role('button', name='保存设置', exact=True).click()
            expect(dialog.get_by_role('alert')).to_contain_text('其他地方更新')
            expect(dialog.get_by_label('会话名', exact=True)).to_have_value('冲突草稿')
            expect(dialog.get_by_role('button', name='保存设置', exact=True)).to_be_disabled()
            flags['fail_settings_read'] = True
            dialog.get_by_role('button', name='重新加载已保存设置').click()
            expect(dialog.get_by_role('alert')).to_have_text('已保存设置暂时读取失败，请重试')
            expect(dialog.get_by_label('会话名', exact=True)).to_have_value('冲突草稿')
            page.keyboard.press('Escape')
            page.reload(wait_until='domcontentloaded')
            page.get_by_role('button', name='设置', exact=True).click()
            expect(dialog.get_by_label('会话名', exact=True)).to_have_value('冲突草稿')
            expect(dialog.get_by_role('button', name='保存设置', exact=True)).to_be_disabled()
            dialog.get_by_role('button', name='重新加载已保存设置').click()
            expect(dialog.get_by_label('会话名', exact=True)).to_have_value('外部窗口改名')
            expect(dialog.get_by_role('button', name='保存设置', exact=True)).to_be_disabled()
            page.set_viewport_size({'width': 390, 'height': 844})
            assert page.evaluate('document.documentElement.scrollWidth === innerWidth')
            page.screenshot(path=output / 'settings-narrow.png')
            page.keyboard.press('Escape')

            # The save belongs to its original form; a later result cannot close a new form.
            page.set_viewport_size({'width': 1280, 'height': 900})
            page.get_by_role('button', name='设置', exact=True).click()
            dialog.get_by_label('会话名', exact=True).fill('慢速保存')
            flags['hold_settings'] = True
            dialog.get_by_role('button', name='保存设置', exact=True).click()
            expect(dialog.get_by_role('button', name='正在保存…')).to_be_disabled()
            page.keyboard.press('Escape')
            page.locator('[data-act="new-room"]').first.click()
            new = page.get_by_role('dialog', name='开始一个项目')
            new.get_by_label('你想做什么？').fill('保留新窗口需求')
            assert len(held) == 1
            route, payload = held.pop()
            route.fulfill(json=canonicalize(payload))
            expect(page.get_by_text('会话设置已保存', exact=True).last).to_be_visible()
            expect(new.get_by_label('你想做什么？')).to_have_value('保留新窗口需求')
            page.keyboard.press('Escape')
            flags['hold_settings'] = False

            # Flow edits are independent of server snapshots and survive navigation/reload.
            page.get_by_role('button', name='流程', exact=True).click()
            page.locator('.fnode[data-id="n1"]').click()
            name = page.locator('.flow-side [data-field="name"]')
            name.fill('草稿实施阶段')
            assert rooms['r_one']['flow']['nodes'][0]['name'] == '实现'
            expect(page.get_by_text('草稿已保留，尚未保存到会话。', exact=True)).to_be_visible()
            page.evaluate("editEvents.onmessage({data:JSON.stringify({kind:'event',room_id:'r_one',type:'room.updated'})})")
            expect(name).to_have_value('草稿实施阶段')
            page.locator('.room-item[data-id="r_two"]').click()
            page.locator('.room-item[data-id="r_one"]').click()
            page.get_by_role('button', name='流程', exact=True).click()
            expect(page.locator('.fnode[data-id="n1"]')).to_contain_text('草稿实施阶段')
            page.reload(wait_until='domcontentloaded')
            page.get_by_role('button', name='流程', exact=True).click()
            expect(page.locator('.fnode[data-id="n1"]')).to_contain_text('草稿实施阶段')
            page.get_by_role('button', name='保存流程', exact=True).click()
            expect(page.locator('#flow-save-error')).to_have_text('流程保存暂时失败')
            assert rooms['r_one']['flow']['nodes'][0]['name'] == '实现'
            flags['fail_state'] = True
            page.get_by_role('button', name='保存流程', exact=True).click()
            expect(page.get_by_text('当前显示已保存的流程。', exact=True)).to_be_visible()
            expect(page.get_by_role('button', name='保存流程', exact=True)).to_be_disabled()
            expect(page.get_by_text('流程已保存，状态更新失败，可刷新查看。', exact=True)).to_be_visible()
            assert rooms['r_one']['flow']['nodes'][0]['name'] == '草稿实施阶段'
            page.locator('.fnode[data-id="n1"]').press('Enter')
            expect(name).to_be_focused()
            name.fill('仍保留在本机的草稿')
            rooms['r_one']['flow']['nodes'][0]['name'] = '外部新阶段'
            page.get_by_role('button', name='保存流程', exact=True).click()
            expect(page.locator('#flow-save-error')).to_contain_text('其他地方更新')
            expect(page.get_by_role('button', name='保存流程', exact=True)).to_be_disabled()
            page.reload(wait_until='domcontentloaded')
            page.get_by_role('button', name='流程', exact=True).click()
            page.locator('.fnode[data-id="n1"]').click()
            page.evaluate("editEvents.onmessage({data:JSON.stringify({kind:'event',room_id:'r_one',type:'room.updated'})})")
            expect(page.locator('#flow-draft-status')).to_contain_text('其他地方更新')
            expect(page.get_by_role('button', name='保存流程', exact=True)).to_be_disabled()
            expect(name).to_have_value('仍保留在本机的草稿')
            page.get_by_role('button', name='加载已保存流程', exact=True).click()
            expect(page.locator('.fnode[data-id="n1"]')).to_contain_text('外部新阶段')
            page.set_viewport_size({'width': 390, 'height': 844})
            page.locator('.fnode[data-id="n1"]').press('Enter')
            expect(page.get_by_label('阶段名称', exact=True)).to_have_value('外部新阶段')
            expect(page.get_by_label('阶段名称', exact=True)).to_be_focused()
            assert page.evaluate('document.documentElement.scrollWidth === innerWidth')
            page.screenshot(path=output / 'flow-narrow.png', full_page=True)
            flags['busy'] = True
            page.evaluate("editEvents.onmessage({data:JSON.stringify({kind:'event',room_id:'r_one',type:'task.started'})})")
            expect(page.get_by_role('button', name='保存流程', exact=True)).to_be_disabled()
            page.locator('.fnode[data-id="n1"]').click()
            expect(name).to_be_disabled()

            # A save can finish while its room is being reopened. Neither that save nor
            # an older room read may overwrite the latest state or close a new modal.
            flags['busy'] = False
            page.set_viewport_size({'width': 1280, 'height': 900})
            page.locator('.room-item[data-id="r_two"]').click()
            page.locator('.room-item[data-id="r_one"]').click()
            page.get_by_role('button', name='流程', exact=True).click()
            page.locator('.fnode[data-id="n1"]').click()
            name.fill('慢速保存的流程')
            flags['hold_flow'] = True
            page.get_by_role('button', name='保存流程', exact=True).click()
            expect(page.get_by_role('button', name='正在保存…', exact=True)).to_be_disabled()
            assert len(held_flows) == 1
            page.locator('.room-item[data-id="r_two"]').click()
            flags['hold_room'] = 'r_one'
            page.locator('.room-item[data-id="r_one"]').click()
            expect(page.get_by_text('正在打开会话…', exact=True)).to_be_visible()
            assert len(held_rooms) == 1
            page.locator('[data-act="new-room"]').first.click()
            new.get_by_label('你想做什么？').fill('流程保存不应影响这个窗口')
            route, payload = held_flows.pop()
            rooms['r_one']['flow'] = deepcopy(payload['flow'])
            route.fulfill(json={})
            expect(page.get_by_text('流程已保存', exact=True).last).to_be_visible()
            expect(page.locator('.room-head h1')).to_have_text('慢速保存')
            route, old_response = held_rooms.pop()
            route.fulfill(json=old_response)
            expect(new.get_by_label('你想做什么？')).to_have_value('流程保存不应影响这个窗口')
            page.keyboard.press('Escape')
            page.get_by_role('button', name='流程', exact=True).click()
            expect(page.locator('.fnode[data-id="n1"]')).to_contain_text('慢速保存的流程')
            expect(page.get_by_role('button', name='保存流程', exact=True)).to_be_disabled()
            assert all('/settings' in path or ('flow' in payload and 'expectedFlow' in payload) for path, payload in writes)
            assert not errors, errors
            print('Editing assertions passed; closing the isolated browser.', flush=True)
        except BaseException:
            traceback.print_exc()
            raise
        finally:
            for route, _ in held + held_flows + held_rooms:
                route.abort()
            close_test_browser(browser)
    print('Atomic settings, draft recovery, stable role selection, conflict handling and flow drafts passed.')
    if screenshots:
        print(f'Screenshots: {screenshots}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--screenshots', type=Path)
    main(parser.parse_args().screenshots)
