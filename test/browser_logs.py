"""Recent-log browser regression. Uses only intercepted in-memory API fixtures."""
import argparse
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.parse import urlsplit

from browser_cleanup import launch_test_browser
from playwright.sync_api import expect, sync_playwright

WEB = Path(__file__).resolve().parents[1] / 'web'
STAMP = '2026-11-20T00:00:00.000Z'


def main(screenshots=None):
    errors, held, requests = [], [], []
    active = dict(id='t_live', key='T1', title='执行筛选任务', type='code', owner_id='m_one',
                  status='running', updated_at=STAMP, acceptance=[], spec='增加筛选选项')
    failed = dict(id='t_failed', key='T2', title='失败的任务', type='code', owner_id='m_one', status='failed',
                  updated_at=STAMP, summary='任务未完成：协作工具未登录。', acceptance=[], spec='修复筛选')
    rerun = {'id': 'run_one'}
    held_response = {'enabled': False}
    sample = ''.join(f'line {index} 输出\n' for index in range(3000))

    def response(route):
        path = urlsplit(route.request.url).path
        requests.append(path)
        if path in ['/', '/app.js', '/plan-draft.js', '/log-buffer.js', '/edit-drafts.js', '/style.css']:
            name = 'index.html' if path == '/' else path[1:]
            mime = {'html': 'text/html', 'js': 'application/javascript', 'css': 'text/css'}[name.rsplit('.', 1)[1]]
            return route.fulfill(body=(WEB / name).read_bytes(), content_type=mime + '; charset=utf-8')
        if path == '/api/workers':
            return route.fulfill(json={'workers': [{'key': 'codex', 'label': 'Codex', 'available': True}]})
        room = dict(id='r_test', name='日志演示', repo_path='D:/sample', base_branch='main', requirement='检查日志',
                    mode='serial', status='running', auto_approve=False, flow={'nodes': [], 'edges': []})
        if path == '/api/state':
            return route.fulfill(json={'rooms': [dict(room, counts=dict(total=2, running=1, review=0, done=0, failed=1))],
                                       'running': [{'taskId': 't_live', 'phase': 'running'}], 'flowTemplates': [], 'inbox': []})
        if path == '/api/rooms/r_test':
            return route.fulfill(json=dict(room=room, tasks=[active, failed], members=[dict(id='m_one', name='协作助手', enabled=True, worker='codex', concurrency=1)],
                                           events=[], reviews=[], decisions=[]))
        if path == '/api/tasks/t_live/log':
            payload = dict(log=sample if rerun['id'] == 'run_one' else '新一轮输出\n', runId=rerun['id'], status=active['status'],
                           error='' if active['status'] == 'running' else '执行返回错误，请检查任务说明。',
                           readError='', exitCode=None if active['status'] == 'running' else 7, startedAt=STAMP, endedAt=None,
                           totalBytes=1000000, truncated=rerun['id'] == 'run_one')
            if held_response['enabled']:
                held.append((route, payload))
                return
            return route.fulfill(json=payload)
        if path == '/api/tasks/t_failed/log':
            return route.fulfill(json=dict(log='工具返回错误\n', runId='run_failed', status='failed', error='协作工具未登录，请先登录工具。',
                                           exitCode=1, startedAt=STAMP, endedAt=STAMP, truncated=False, totalBytes=24,
                                           readError=''))
        if path.startswith('/api/tasks/') and path.endswith('/diff'):
            return route.fulfill(json={'diff': '', 'resultSha': ''})
        return route.fulfill(status=404)

    with TemporaryDirectory(prefix='devhub-log-ui-') as temporary, sync_playwright() as pw:
        output = screenshots or Path(temporary)
        output.mkdir(parents=True, exist_ok=True)
        browser = launch_test_browser(pw)
        page = browser.new_page(viewport={'width': 1280, 'height': 800})
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.add_init_script("""window.EventSource = class {
          constructor() { window.logEvents=this; queueMicrotask(() => this.onopen?.()); }
          close() {}
        };""")
        page.route('http://devhub.invalid/**', response)
        try:
            page.goto('http://devhub.invalid/', wait_until='domcontentloaded')
            page.locator('.card[data-id="t_failed"]').click()
            dialog = page.get_by_role('dialog', name='失败的任务')
            expect(dialog.get_by_role('heading', name='任务未完成', exact=True)).to_be_visible()
            expect(dialog.get_by_text('任务未完成：协作工具未登录。', exact=True)).to_be_visible()
            assert not any(path.endswith('/log') for path in requests), 'Overview must not read full logs'
            dialog.get_by_role('button', name='查看执行日志').click()
            box = dialog.get_by_label('最近执行日志')
            expect(box).to_have_text('工具返回错误\n')
            expect(dialog.get_by_text('协作工具未登录，请先登录工具。', exact=True)).to_be_visible()
            expect(dialog.get_by_text('本次运行：失败', exact=False)).to_be_visible()
            page.keyboard.press('Escape')

            page.locator('.card[data-id="t_live"]').click()
            dialog = page.get_by_role('dialog', name='执行筛选任务')
            dialog.get_by_role('button', name='日志', exact=True).click()
            box = dialog.get_by_label('最近执行日志')
            expect(box).to_contain_text('line 2999 输出')
            expect(box).not_to_contain_text('line 0 输出')
            expect(dialog.get_by_text('仅显示最近的日志，较早内容仍保存在本机。')).to_be_visible()
            assert box.evaluate('e => e.childElementCount') == 0, 'Log must not allocate one element per event'
            assert box.evaluate('e => e.scrollTop + e.clientHeight >= e.scrollHeight - 2')

            box.evaluate('e => { e.scrollTop = 0; e.dispatchEvent(new Event("scroll")); }')
            follow = dialog.locator('[data-act="follow-log"]')
            expect(follow).to_have_text('回到最新')
            page.evaluate("""() => {
              for(let i=0;i<500;i++) logEvents.onmessage({data:JSON.stringify({
                kind:'log', roomId:'r_test', taskId:'t_live', runId:'run_one', actor:{kind:'task'}, line:'最新事件 '+i
              })});
            }""")
            expect(box).to_contain_text('最新事件 499')
            assert box.evaluate('e => e.scrollTop') == 0
            assert box.evaluate('e => e.textContent.split("\\n").length') <= 2001
            assert box.evaluate('e => e.childElementCount') == 0
            page.evaluate("logEvents.onmessage({data:JSON.stringify({kind:'event',room_id:'r_test',type:'task.phase'})})")
            expect(follow).to_have_text('回到最新')
            follow.click()
            expect(follow).to_have_text('跟随最新')
            assert box.evaluate('e => e.scrollTop + e.clientHeight >= e.scrollHeight - 2')

            # Reviewer and past-run events must not pollute the current task log.
            page.evaluate("""() => {
              for(const event of [
                {actor:{kind:'review'},runId:'review_one',line:'REVIEW_WRONG'},
                {actor:{kind:'task'},runId:'old_run',line:'OLD_WRONG'}
              ]) logEvents.onmessage({data:JSON.stringify({kind:'log',roomId:'r_test',taskId:'t_live',...event})});
            }""")
            expect(box).not_to_contain_text('REVIEW_WRONG')
            expect(box).not_to_contain_text('OLD_WRONG')
            page.screenshot(path=output / 'recent-log-desktop.png')

            rerun['id'] = 'run_two'
            page.evaluate("logEvents.onmessage({data:JSON.stringify({kind:'event',room_id:'r_test',task_id:'t_live',type:'task.started'})})")
            expect(box).to_have_text('新一轮输出\n')
            page.evaluate("logEvents.onmessage({data:JSON.stringify({kind:'log',roomId:'r_test',taskId:'t_live',runId:'run_one',actor:{kind:'task'},line:'LATE_WRONG'})})")
            expect(box).not_to_contain_text('LATE_WRONG')
            active['status'] = 'failed'
            page.evaluate("logEvents.onmessage({data:JSON.stringify({kind:'event',room_id:'r_test',task_id:'t_live',type:'task.status'})})")
            expect(dialog.get_by_text('执行返回错误，请检查任务说明。', exact=True)).to_be_visible()
            expect(dialog.get_by_text('本次运行：失败', exact=False)).to_contain_text('退出码 7')

            # A late log response must not overwrite another task's drawer.
            held_response['enabled'] = True
            dialog.get_by_role('button', name='刷新日志', exact=True).click()
            expect(dialog.get_by_text('正在加载…')).to_be_visible()
            page.keyboard.press('Escape')
            page.locator('.card[data-id="t_failed"]').click()
            failed_dialog = page.get_by_role('dialog', name='失败的任务')
            for route, payload in held:
                route.fulfill(json=payload)
            held.clear()
            expect(failed_dialog.get_by_role('heading', name='任务未完成', exact=True)).to_be_visible()
            page.set_viewport_size({'width': 390, 'height': 844})
            failed_dialog.get_by_role('button', name='查看执行日志').click()
            expect(failed_dialog.get_by_label('最近执行日志')).to_have_text('工具返回错误\n')
            assert page.evaluate('document.documentElement.scrollWidth === innerWidth')
            page.screenshot(path=output / 'recent-log-narrow.png')

            # A rejected log request offers a usable retry; missing output remains
            # distinct from a real log-file read error and from a task failure.
            page.route('**/api/tasks/t_failed/log', lambda route: route.fulfill(status=500, json={'error': '日志暂不可用'}))
            failed_dialog.get_by_role('button', name='刷新日志', exact=True).click()
            expect(failed_dialog.get_by_text('日志暂不可用', exact=True)).to_be_visible()
            page.unroute('**/api/tasks/t_failed/log')
            failed_dialog.get_by_role('button', name='重新加载', exact=True).click()
            expect(failed_dialog.get_by_label('最近执行日志')).to_have_text('工具返回错误\n')
            assert not errors, errors
        finally:
            for route, _ in held:
                route.abort()
            browser.close()
    print('Failure guidance, bounded logs, follow/pause, run isolation and narrow layout passed.')
    if screenshots:
        print(f'Screenshots: {screenshots}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--screenshots', type=Path)
    main(parser.parse_args().screenshots)
