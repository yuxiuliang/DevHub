"""Read-only cross-project inbox regression: python -B test/browser_inbox.py."""
import argparse
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.parse import urlsplit

from browser_cleanup import launch_test_browser
from playwright.sync_api import expect, sync_playwright

WEB = Path(__file__).resolve().parents[1] / 'web'
STAMP = '2026-11-20T00:00:00.000Z'
SHA = 'a' * 40
MEMBER = dict(id='m_one', name='协作助手', worker='codex', enabled=True, concurrency=1)


def main(screenshots=None):
    rooms = {}
    writes, errors, held, manual = [], [], [], []
    delayed = {'room': None}
    manual_state = {'attempts': 0, 'held': None}

    def room(room_id, name, tasks=None, plan=None):
        rooms[room_id] = dict(
            room=dict(id=room_id, name=name, requirement=name, repo_path='D:/example', base_branch='main',
                      status='planning', mode='serial', auto_approve=False, flow={'nodes': [], 'edges': []}, plan=plan),
            tasks=tasks or [], members=[MEMBER], reviews=[], decisions=[], events=[])

    def task(task_id, title, status):
        return dict(id=task_id, title=title, key='T1', type='code', status=status, owner_id='m_one',
                    spec='完成当前任务', acceptance=['结果正确'], updated_at=STAMP, result_sha=SHA,
                    diff_stat='result.txt | 1 +', feedback='请保留筛选选项', summary='查看执行结果')

    room('r_problem', '订单 <测试>', [task('t_problem', '修复筛选失败', 'failed')])
    room('r_plan', '报表计划', plan={'tasks': [{'title': '增加导出', 'spec': '导出报表', 'owner': '协作助手'}]})
    room('r_result', '导出结果', [task('t_result', '导出 <新版> 报表', 'review')])

    def inbox():
        items = []
        for key, data in rooms.items():
            current = data['room']
            if current['status'] == 'archived':
                continue
            if current['plan']:
                items.append(dict(id=f'plan:{key}', roomId=key, roomName=current['name'], taskId=None,
                                  title=current['name'], kind='plan', status='planning', updatedAt=STAMP))
            for current_task in data['tasks']:
                status = current_task['status']
                if status not in ['failed', 'changes_requested', 'escalated', 'review', 'approved']:
                    continue
                items.append(dict(id=f'task:{current_task["id"]}', roomId=key, roomName=current['name'],
                                  taskId=current_task['id'], title=current_task['title'],
                                  kind='problem' if status in ['failed', 'changes_requested', 'escalated'] else 'result',
                                  status=status, updatedAt=STAMP))
        rank = {'problem': 0, 'plan': 1, 'result': 2}
        return sorted(items, key=lambda item: rank[item['kind']])

    def respond(route):
        path = urlsplit(route.request.url).path
        if path == '/api/tasks' and route.request.method == 'POST':
            manual_state['attempts'] += 1
            manual.append(route.request.post_data_json)
            if manual_state['attempts'] == 1:
                return route.fulfill(status=500, json={'error': '暂时无法添加，请重试'})
            manual_state['held'] = route
            return
        if route.request.method not in ['GET', 'HEAD']:
            writes.append(path)
            return route.fulfill(status=500, json={'error': 'Inbox navigation must be read-only'})
        if path in ['/', '/app.js', '/plan-draft.js', '/log-buffer.js', '/edit-drafts.js', '/style.css']:
            name = 'index.html' if path == '/' else path[1:]
            mime = {'html': 'text/html', 'js': 'application/javascript', 'css': 'text/css'}[name.rsplit('.', 1)[1]]
            return route.fulfill(body=(WEB / name).read_bytes(), content_type=mime + '; charset=utf-8')
        if path == '/api/workers':
            return route.fulfill(json={'workers': [{'key': 'codex', 'label': 'Codex', 'available': True}]})
        if path == '/api/state':
            counts = dict(total=1, running=0, review=0, failed=0, done=0)
            return route.fulfill(json={'rooms': [dict(data['room'], counts=counts) for data in rooms.values()],
                                       'inbox': inbox(), 'running': [], 'flowTemplates': []})
        if path.startswith('/api/rooms/'):
            key = path.rsplit('/', 1)[1]
            if delayed['room'] == key:
                held.append(route)
                return
            return route.fulfill(json=rooms[key])
        if path == '/api/tasks/t_result/diff':
            return route.fulfill(json={'diff': '+++ result.txt\n+新版报表', 'resultSha': SHA})
        return route.fulfill(status=404)

    with TemporaryDirectory(prefix='devhub-inbox-ui-') as temporary, sync_playwright() as pw:
        output = screenshots or Path(temporary)
        output.mkdir(parents=True, exist_ok=True)
        browser = launch_test_browser(pw)
        page = browser.new_page(viewport={'width': 1280, 'height': 800})
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.add_init_script("""window.EventSource = class {
          constructor() { window.inboxEvents = this; queueMicrotask(() => this.onopen?.()); }
          close() {}
        };""")
        page.route('http://devhub.invalid/**', respond)
        try:
            page.goto('http://devhub.invalid/', wait_until='domcontentloaded')
            expect(page.get_by_role('heading', name='需要你处理', exact=True)).to_be_visible()
            expect(page.locator('.inbox-item')).to_have_count(3)
            expect(page.locator('#inbox-count')).to_have_text('3')
            expect(page.locator('.inbox-item').first).to_contain_text('修复筛选失败')
            expect(page.locator('.inbox-item').last).to_contain_text('导出 <新版> 报表')
            expect(page.locator('.inbox b')).to_have_count(0)
            page.screenshot(path=output / 'inbox-desktop.png')

            page.locator('[data-inbox-id="task:t_problem"]').press('Enter')
            problem = page.get_by_role('dialog', name='修复筛选失败')
            expect(problem.get_by_text('查看执行结果', exact=True)).to_be_visible()
            page.keyboard.press('Escape')
            page.get_by_role('button', name='总览', exact=True).click()
            page.locator('[data-inbox-id="plan:r_plan"]').click()
            plan = page.get_by_role('dialog', name='确认计划')
            expect(plan.get_by_label('任务 1 标题')).to_have_value('增加导出')
            page.keyboard.press('Escape')
            page.get_by_role('button', name='总览', exact=True).click()
            page.locator('[data-inbox-id="task:t_result"]').click()
            result = page.get_by_role('dialog', name='导出 <新版> 报表')
            expect(result.get_by_text('+新版报表')).to_be_visible()
            expect(result.get_by_role('button', name='合并到项目')).to_be_visible()
            page.keyboard.press('Escape')

            # A stale row must not open an outdated plan after another project was selected.
            page.get_by_role('button', name='总览', exact=True).click()
            delayed['room'] = 'r_plan'
            page.locator('[data-inbox-id="plan:r_plan"]').click()
            expect(page.get_by_text('正在打开会话…')).to_be_visible()
            page.locator('.room-item[data-id="r_result"]').press('Enter')
            expect(page.get_by_role('heading', name='导出结果', exact=True)).to_be_visible()
            delayed['room'] = None
            for route in held:
                route.fulfill(json=rooms['r_plan'])
            held.clear()
            expect(plan).to_have_count(0)
            expect(page.get_by_role('heading', name='导出结果', exact=True)).to_be_visible()

            # Refreshing the overview preserves focus while events update the queue.
            page.get_by_role('button', name='总览', exact=True).click()
            button = page.locator('[data-inbox-id="task:t_result"]')
            button.focus()
            rooms['r_problem']['tasks'][0]['status'] = 'done'
            page.evaluate("inboxEvents.onmessage({data: JSON.stringify({kind:'event', room_id:'r_problem', type:'task.status'})})")
            expect(page.locator('.inbox-item')).to_have_count(2)
            expect(button).to_be_focused()
            page.set_viewport_size({'width': 390, 'height': 844})
            expect(button).to_be_visible()
            assert page.evaluate('document.documentElement.scrollWidth === innerWidth')
            page.screenshot(path=output / 'inbox-narrow.png')

            # Revalidation handles a result that was cancelled after the row appeared.
            rooms['r_result']['tasks'][0]['status'] = 'cancelled'
            button.press('Enter')
            expect(result).to_be_visible()
            expect(result.get_by_role('button', name='合并到项目')).to_have_count(0)
            expect(result.get_by_text('完成当前任务')).to_be_visible()
            page.keyboard.press('Escape')
            rooms['r_plan']['room']['plan'] = None
            page.get_by_role('button', name='总览', exact=True).click()
            expect(page.locator('.inbox-item')).to_have_count(0)
            expect(page.get_by_text('暂时没有需要确认的事项。', exact=False)).to_be_visible()
            assert not writes, writes

            # Failed manual creation is immediately retryable. A later response owns
            # only its original form and cannot close a newer project dialog.
            page.locator('.room-item[data-id="r_problem"]').click()
            page.locator('.room-more summary').click()
            page.get_by_role('button', name='手动添加任务', exact=True).click()
            form = page.get_by_role('dialog', name='添加一项任务')
            description = form.get_by_label('要完成什么？')
            description.fill('修复订单筛选')
            description.press('Enter')
            assert manual_state['attempts'] == 0, 'Textarea Enter must remain a newline'
            submit = form.locator('button[type="submit"]')
            submit.click()
            expect(form.get_by_role('alert')).to_have_text('暂时无法添加，请重试')
            expect(description).to_have_value('修复订单筛选\n')
            submit.press('Enter')
            expect(submit).to_be_disabled()
            assert manual_state['attempts'] == 2
            page.evaluate("document.querySelector('#task-create-form').requestSubmit()")
            assert manual_state['attempts'] == 2, 'Repeated submit must share the pending request'
            page.keyboard.press('Escape')
            page.locator('[data-act="new-room"]').first.click()
            setup = page.get_by_role('dialog', name='开始一个项目')
            setup.get_by_label('你想做什么？').fill('保留这段新的需求')
            pending = manual_state['held']
            assert pending is not None
            manual_state['held'] = None
            pending.fulfill(json={'id': 't_created'})
            expect(page.get_by_text('任务已添加', exact=True)).to_be_visible()
            expect(setup).to_be_visible()
            expect(setup.get_by_label('你想做什么？')).to_have_value('保留这段新的需求')
            assert manual == [manual[0], manual[0]]
            assert manual[0]['roomId'] == 'r_problem'
            assert not writes, writes
            assert not errors, errors
        finally:
            for route in held:
                route.abort()
            if manual_state['held'] is not None:
                manual_state['held'].abort()
            browser.close()
    print('Inbox navigation, stale-state checks, focus, 390px layout and manual-task retry passed.')
    if screenshots:
        print(f'Screenshots: {screenshots}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--screenshots', type=Path)
    main(parser.parse_args().screenshots)
