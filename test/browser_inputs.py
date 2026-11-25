"""Saved-run input browser regression. Uses only intercepted in-memory API fixtures."""
import argparse
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import expect, sync_playwright

from browser_cleanup import close_test_browser, launch_test_browser

WEB = Path(__file__).resolve().parents[1] / 'web'
STAMP = '2026-11-22T00:00:00.000Z'
ROOM_ID = 'r_input'
BIG = ('B' * 19 + '\n') * 50
PROMPTS = {
    'run_new': ('最新一次输入：检查筛选\n'
                '任务：在任务板增加按负责人筛选\n'
                '验收：\n'
                '- 选中负责人后只显示该成员的任务\n'
                '- 清空筛选恢复全部任务\n'
                '工作区：D:/work/devhub/build/artifacts/screenshots/filter-board\n'),
    'run_big': BIG,
    'run_mid': ('失败那次的输入\n'
                '<script>window.__xss=1</script>\n'
                '<img src=x onerror="window.__xss=2">\n'),
    'run_err': '错误恢复后的输入\n',
    'run_old': '最早一次输入\n',
}
# Newest first, exactly as the API orders runs.
RUNS = [
    dict(runId='run_new', status='completed', exitCode=0, startedAt='2026-11-22T09:00:00.000Z'),
    dict(runId='run_big', status='completed', exitCode=0, startedAt='2026-11-22T08:00:00.000Z'),
    dict(runId='run_mid', status='failed', exitCode=7, startedAt='2026-11-22T07:00:00.000Z'),
    dict(runId='run_gone', status='cancelled', exitCode=None, startedAt='2026-11-22T06:30:00.000Z'),
    dict(runId='run_err', status='failed', exitCode=1, startedAt='2026-11-22T06:15:00.000Z'),
    dict(runId='run_old', status='completed', exitCode=0, startedAt='2026-11-22T06:00:00.000Z'),
]
FAIL_TEXT = {500: '输入暂不可用', 404: '本任务没有这次运行记录，请重新选择'}
NO_SNAPSHOT = '这次运行没有留下流程快照（旧运行）。'
# Each run carries its own snapshot: newest 3 phases (with a rejected back edge),
# an older 2-phase graph, and one run that predates snapshots (flow: null).
FLOWS = {
    'run_new': {
        'name': '交付流程',
        'nodes': [
            dict(id='n1', type='phase', name='需求澄清', owner='', gate='human', outputs=['brief'], maxLoop=0),
            dict(id='n2', type='phase', name='技术方案', owner='设计者', gate='agent', outputs=['design'], maxLoop=0),
            dict(id='n3', type='phase', name='实现', owner='', gate='auto', outputs=['code_diff'], maxLoop=2),
        ],
        'edges': [
            {'from': 'n1', 'to': 'n2', 'condition': 'passed'},
            {'from': 'n2', 'to': 'n3', 'condition': 'passed'},
            {'from': 'n3', 'to': 'n2', 'condition': 'rejected'},
        ],
    },
    'run_old': {
        'name': '旧流程',
        'nodes': [
            dict(id='a1', type='phase', name='调研', owner='研究员', gate='agent', outputs=['findings'], maxLoop=0),
            dict(id='a2', type='phase', name='结论', owner='', gate='human', outputs=[], maxLoop=0),
        ],
        'edges': [{'from': 'a1', 'to': 'a2', 'condition': 'passed'}],
    },
    'run_big': {'name': '空流程', 'nodes': [], 'edges': []},
    # Snapshot names/owners are plain text: markup must never execute.
    'run_mid': {
        'name': '转义流程',
        'nodes': [
            dict(id='x1', type='phase', name='<script>window.__xss=3</script>',
                 owner='<img src=x onerror="window.__xss=4">', gate='human', outputs=['unknown_output'], maxLoop=0),
            dict(id='x2', type='phase', owner='', gate='auto', outputs=[], maxLoop=0),
        ],
        'edges': [{'from': 'x1', 'to': 'x2', 'condition': 'always'}],
    },
}
NEW_PHASES = [
    '1. 需求澄清 · 人工 · 负责人：由 Planner 分配 · 产出：需求说明',
    '2. 技术方案 · 评审 · 负责人：设计者 · 产出：方案设计',
    '3. 实现 · 自动 · 负责人：由 Planner 分配 · 产出：代码改动 · 打回≤2',
]
NEW_EDGES = ['需求澄清 → 技术方案（通过）', '技术方案 → 实现（通过）', '实现 → 技术方案（打回）']
OLD_PHASES = ['1. 调研 · 评审 · 负责人：研究员 · 产出：调研发现', '2. 结论 · 人工 · 负责人：由 Planner 分配']
OLD_EDGES = ['调研 → 结论（通过）']


def main(screenshots=None):
    errors, held, requests = [], [], []
    flags = dict(hold=False, err_recovered=False)
    fail = dict(task='', status=0)
    revision = 0
    room = dict(id=ROOM_ID, name='输入演示', repo_path='D:/sample', base_branch='main', requirement='追溯执行输入',
                mode='serial', status='running', auto_approve=False, flow={'nodes': [], 'edges': []})
    tasks = [
        dict(id='t_input', key='T1', title='筛选任务', type='code', owner_id='m_one', status='failed',
             updated_at=STAMP, summary='任务未完成：筛选条件没有保存。', acceptance=[], spec='增加筛选选项'),
        dict(id='t_many', key='T2', title='历史很长的任务', type='code', owner_id='m_one', status='done',
             updated_at=STAMP, acceptance=[], spec='历史任务'),
        dict(id='t_empty', key='T3', title='从未运行的任务', type='code', owner_id='m_one', status='ready',
             updated_at=STAMP, acceptance=[], spec='尚未运行'),
    ]

    def run_payload(run):
        body = dict(prompt='', runId=run['runId'], status=run['status'], exitCode=run['exitCode'],
                    startedAt=run['startedAt'], endedAt=STAMP, available=False, truncated=False, totalBytes=0,
                    readError='', runsTruncated=False, flow=FLOWS.get(run['runId']),
                    runs=[dict(runId=item['runId'], status=item['status'], exitCode=item['exitCode'],
                               startedAt=item['startedAt'], endedAt=STAMP) for item in RUNS])
        if run['runId'] == 'run_gone':
            return body
        if run['runId'] == 'run_err' and not flags['err_recovered']:
            body['readError'] = '无法读取本次运行的执行输入，请重试。'
            return body
        text = PROMPTS[run['runId']]
        body.update(prompt=text, available=True, totalBytes=len(text.encode()))
        if run['runId'] == 'run_big':
            body.update(truncated=True, totalBytes=262144 + len(text.encode()))
        return body

    def response(route):
        target = urlsplit(route.request.url)
        path = target.path
        requests.append(path + (f'?{target.query}' if target.query else ''))
        if path in ['/', '/app.js', '/plan-draft.js', '/log-buffer.js', '/edit-drafts.js', '/style.css']:
            name = 'index.html' if path == '/' else path[1:]
            mime = {'html': 'text/html', 'js': 'application/javascript', 'css': 'text/css'}[name.rsplit('.', 1)[1]]
            return route.fulfill(body=(WEB / name).read_bytes(), content_type=mime + '; charset=utf-8')
        if path == '/api/workers':
            return route.fulfill(json={'workers': [{'key': 'codex', 'label': 'Codex', 'available': True}]})
        if path == '/api/state':
            return route.fulfill(json={'rooms': [dict(room, counts=dict(total=3, running=0, review=1, done=1, failed=1))],
                                       'running': [], 'activeWorkers': 0, 'flowTemplates': [], 'inbox': []})
        if path == f'/api/rooms/{ROOM_ID}':
            return route.fulfill(json=dict(room=room, tasks=tasks, events=[], reviews=[], decisions=[],
                                           members=[dict(id='m_one', name='协作助手', enabled=True, worker='codex',
                                                         concurrency=1)]))
        if path.startswith('/api/tasks/') and path.endswith('/prompt'):
            task_id = path.split('/')[3]
            if fail['status'] and fail['task'] == task_id:
                return route.fulfill(status=fail['status'], json={'error': FAIL_TEXT[fail['status']]})
            if task_id == 't_empty':
                return route.fulfill(json=dict(prompt='', runId=None, status='', exitCode=None, startedAt=None,
                                               endedAt=None, available=False, truncated=False, totalBytes=0,
                                               readError='', runs=[], runsTruncated=False, flow=None))
            if task_id == 't_many':
                return route.fulfill(json=dict(prompt='很久以前的输入\n', runId='run_many', status='completed',
                                               exitCode=0, startedAt=STAMP, endedAt=STAMP, available=True,
                                               truncated=False, totalBytes=21, readError='', flow=None,
                                               runs=[dict(runId='run_many', status='completed', exitCode=0,
                                                          startedAt=STAMP, endedAt=STAMP),
                                                     dict(runId='run_older', status='completed', exitCode=0,
                                                          startedAt=STAMP, endedAt=STAMP)],
                                               runsTruncated=True))
            run_id = parse_qs(target.query).get('runId', [None])[0]
            if run_id is not None and not any(item['runId'] == run_id for item in RUNS):
                return route.fulfill(status=404, json={'error': FAIL_TEXT[404]})
            run = next((item for item in RUNS if item['runId'] == run_id), RUNS[0])
            payload = run_payload(run)
            if flags['hold']:
                held.append((route, payload))
                return
            return route.fulfill(json=payload)
        if path == '/api/tasks/t_input/log':
            return route.fulfill(json=dict(log='旧日志\n', runId='run_new', status='failed', error='', readError='',
                                           exitCode=7, startedAt=STAMP, endedAt=STAMP, totalBytes=10,
                                           truncated=False))
        if path.startswith('/api/tasks/') and path.endswith('/diff'):
            return route.fulfill(json={'diff': '', 'resultSha': ''})
        return route.fulfill(status=404)

    with TemporaryDirectory(prefix='devhub-input-ui-') as temporary, sync_playwright() as pw:
        output = screenshots or Path(temporary)
        output.mkdir(parents=True, exist_ok=True)
        browser = launch_test_browser(pw)
        page = browser.new_page(viewport={'width': 1280, 'height': 800})
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.add_init_script("""window.EventSource = class {
          constructor() { window.inputEvents=this; queueMicrotask(() => this.onopen?.()); }
          close() {}
        };""")
        page.route('http://devhub.invalid/**', response)

        def prompt_requests(task_id='t_input'):
            return [item for item in requests
                    if item == f'/api/tasks/{task_id}/prompt' or item.startswith(f'/api/tasks/{task_id}/prompt?')]

        def refresh():
            nonlocal revision
            revision += 1
            room['requirement'] = f'实时更新 {revision}'
            tasks[0]['updated_at'] = f'revision-{revision}'
            page.evaluate("""roomId => window.inputEvents.onmessage({data: JSON.stringify({
                kind: 'event', type: 'task.status', room_id: roomId
            })})""", ROOM_ID)
            expect(page.locator('.room-req')).to_have_text(room['requirement'])

        try:
            page.goto('http://devhub.invalid/', wait_until='domcontentloaded')
            page.locator('.card[data-id="t_input"]').click()
            dialog = page.get_by_role('dialog', name='筛选任务')
            assert not any('/prompt' in item for item in requests), '概览不应读取执行输入'
            views = dialog.get_by_role('group', name='任务详情视图', exact=True)
            tab = views.get_by_role('button', name='任务执行依据', exact=True)
            expect(tab).to_have_attribute('aria-pressed', 'false')
            tab.press('Enter')
            expect(tab).to_have_attribute('aria-pressed', 'true')
            expect(views.locator('[aria-pressed="true"]')).to_have_count(1)
            box = dialog.get_by_label('当时保存的执行输入')
            expect(box).to_be_visible()
            assert box.evaluate('e => e.textContent') == PROMPTS['run_new']
            assert box.evaluate('e => e.childElementCount') == 0, '执行输入必须是纯文本'
            assert prompt_requests() == ['/api/tasks/t_input/prompt'], prompt_requests()
            expect(dialog.get_by_role('heading', name='执行依据', exact=True)).to_be_visible()
            expect(dialog.get_by_text('这里显示的是每次执行时保存的输入原文和当时的流程，不会按当前设置重新生成。')).to_be_visible()
            expect(dialog.get_by_text('本次运行：已完成', exact=False)).to_be_visible()
            expect(dialog.get_by_text('退出码 0', exact=False)).to_be_visible()
            # The newest run's own snapshot: phases in node order, then its edges.
            snapshot = dialog.get_by_label('这次运行用的流程快照')
            expect(snapshot).to_be_visible()
            expect(snapshot.get_by_role('heading', name='流程快照', exact=True)).to_be_visible()
            expect(snapshot.get_by_text('这是这次运行启动时保存的流程，之后改流程不会改变它。')).to_be_visible()
            assert snapshot.locator('.flow-snapshot-phases li').all_inner_texts() == NEW_PHASES
            assert snapshot.locator('.flow-snapshot-links li').all_inner_texts() == NEW_EDGES
            picker = dialog.get_by_label('选择运行记录')
            expect(picker).to_have_value('run_new')
            labels = picker.locator('option').all_inner_texts()
            assert len(labels) == 6, labels
            assert labels[0].startswith('第 6 次 · 已完成 · ') and labels[-1].startswith('第 1 次 · 已完成 · '), labels
            page.screenshot(path=output / 'basis-desktop.png')

            # Switching to an older run reads that exact run and its own snapshot.
            picker.focus()
            picker.select_option('run_old')
            box = dialog.get_by_label('当时保存的执行输入')
            expect(box).to_be_visible()
            assert box.evaluate('e => e.textContent') == PROMPTS['run_old']
            assert '/api/tasks/t_input/prompt?runId=run_old' in requests
            snapshot = dialog.get_by_label('这次运行用的流程快照')
            assert snapshot.locator('.flow-snapshot-phases li').all_inner_texts() == OLD_PHASES
            assert snapshot.locator('.flow-snapshot-links li').all_inner_texts() == OLD_EDGES
            assert snapshot.get_by_text('需求澄清', exact=False).count() == 0, '切换运行必须换掉整张快照'
            picker = dialog.get_by_label('选择运行记录')
            expect(picker).to_have_value('run_old')
            expect(picker).to_be_focused()

            # Saved input and snapshot text: markup must never execute.
            picker.select_option('run_mid')
            box = dialog.get_by_label('当时保存的执行输入')
            expect(box).to_be_visible()
            assert box.evaluate('e => e.textContent') == PROMPTS['run_mid']
            assert box.evaluate('e => e.querySelectorAll("*").length') == 0
            snapshot = dialog.get_by_label('这次运行用的流程快照')
            expect(snapshot).to_contain_text('<script>window.__xss=3</script>')
            expect(snapshot).to_contain_text('<img src=x onerror="window.__xss=4">')
            expect(snapshot).to_contain_text('2. x2 · 自动')  # 没有 name 时退回 id
            assert snapshot.locator('script, img').count() == 0, '快照文字必须转义'
            assert page.evaluate('window.__xss === undefined')
            expect(dialog.get_by_text('本次运行：失败', exact=False)).to_contain_text('退出码 7')

            # A read error offers a retry that recovers in place; the snapshot is independent.
            picker.select_option('run_err')
            expect(dialog.get_by_role('alert')).to_have_text('无法读取本次运行的执行输入，请重试。')
            assert dialog.get_by_label('当时保存的执行输入').count() == 0
            expect(dialog.get_by_text(NO_SNAPSHOT)).to_be_visible()
            flags['err_recovered'] = True
            dialog.get_by_role('button', name='重新读取', exact=True).click()
            box = dialog.get_by_label('当时保存的执行输入')
            expect(box).to_be_visible()
            assert box.evaluate('e => e.textContent') == PROMPTS['run_err']

            # A run without a saved file stays distinct from a read error.
            picker.select_option('run_gone')
            expect(dialog.get_by_text('这次运行没有留下可读取的输入记录。')).to_be_visible()
            assert dialog.get_by_label('当时保存的执行输入').count() == 0
            expect(dialog.get_by_text(NO_SNAPSHOT)).to_be_visible()
            expect(dialog.get_by_text('本次运行：已取消', exact=False)).to_be_visible()

            # Truncation reports the real file size and the shown byte count.
            picker.select_option('run_big')
            box = dialog.get_by_label('当时保存的执行输入')
            expect(box).to_be_visible()
            assert box.evaluate('e => e.textContent') == BIG
            expect(dialog.get_by_text('输入文件共 263,144 字节，这里只显示开头的 1,000 字节。', exact=True)).to_be_visible()
            expect(dialog.get_by_text('这张流程没有阶段。')).to_be_visible()

            # A live refresh re-renders the drawer without losing the chosen run.
            sent = len(prompt_requests())
            refresh()
            picker = dialog.get_by_label('选择运行记录')
            expect(picker).to_have_value('run_big')
            expect(picker).to_be_focused()
            assert dialog.get_by_label('当时保存的执行输入').evaluate('e => e.textContent') == BIG
            assert len(prompt_requests()) == sent, prompt_requests()

            # Reading long saved input must survive live status updates.
            box.focus()
            box.evaluate('e => { e.scrollTop = 250; }')
            input_top = box.evaluate('e => e.scrollTop')
            body = dialog.locator('.drawer-body')
            body.evaluate('e => { e.scrollTop = e.scrollHeight; }')
            body_top = body.evaluate('e => e.scrollTop')
            assert input_top > 0 and body_top > 0, (input_top, body_top)
            refresh()
            expect(box).to_be_focused()
            assert box.evaluate('e => e.scrollTop') == input_top
            assert body.evaluate('e => e.scrollTop') == body_top
            assert len(prompt_requests()) == sent, prompt_requests()

            # Leaving the tab aborts the in-flight read; a late answer cannot win.
            flags['hold'] = True
            picker.select_option('run_mid')
            expect(dialog.get_by_text('正在加载…', exact=True)).to_be_visible()
            views.get_by_role('button', name='日志', exact=True).click()
            expect(dialog.get_by_label('最近执行日志')).to_have_text('旧日志\n')
            flags['hold'] = False
            for route, payload in held:
                route.fulfill(json=payload)
            held.clear()
            expect(dialog.get_by_label('最近执行日志')).to_have_text('旧日志\n')
            assert dialog.get_by_label('当时保存的执行输入').count() == 0
            views.get_by_role('button', name='任务执行依据', exact=True).click()
            box = dialog.get_by_label('当时保存的执行输入')
            expect(box).to_be_visible()
            assert box.evaluate('e => e.textContent') == PROMPTS['run_mid']

            # A rejected read shows the error and recovers through 重新加载.
            fail.update(task='t_input', status=500)
            dialog.get_by_role('button', name='刷新', exact=True).click()
            expect(dialog.get_by_text('输入暂不可用', exact=True)).to_be_visible()
            fail.update(task='', status=0)
            dialog.get_by_role('button', name='重新加载', exact=True).click()
            box = dialog.get_by_label('当时保存的执行输入')
            expect(box).to_be_visible()
            assert box.evaluate('e => e.textContent') == PROMPTS['run_mid']

            # Truncated run history is announced.
            page.keyboard.press('Escape')
            page.locator('.card[data-id="t_many"]').click()
            dialog = page.get_by_role('dialog', name='历史很长的任务')
            dialog.get_by_role('button', name='任务执行依据', exact=True).click()
            expect(dialog.get_by_text('只列出最近 50 次运行，更早的运行不在这里。')).to_be_visible()
            assert dialog.get_by_label('当时保存的执行输入').evaluate('e => e.textContent') == '很久以前的输入\n'
            expect(dialog.get_by_text(NO_SNAPSHOT)).to_be_visible()

            # A 404 keeps a usable retry instead of a dead end.
            fail.update(task='t_many', status=404)
            dialog.get_by_role('button', name='刷新', exact=True).click()
            expect(dialog.get_by_text(FAIL_TEXT[404], exact=True)).to_be_visible()
            fail.update(task='', status=0)
            dialog.get_by_role('button', name='重新加载', exact=True).click()
            expect(dialog.get_by_label('当时保存的执行输入')).to_be_visible()

            # A task that never ran explains the empty view.
            page.keyboard.press('Escape')
            page.locator('.card[data-id="t_empty"]').click()
            dialog = page.get_by_role('dialog', name='从未运行的任务')
            dialog.get_by_role('button', name='任务执行依据', exact=True).click()
            expect(dialog.get_by_text('任务还没有运行过，执行后会在这里留下当时使用的输入。')).to_be_visible()
            assert dialog.get_by_label('选择运行记录').count() == 0
            assert dialog.get_by_label('这次运行用的流程快照').count() == 0, '未运行的任务不应渲染快照区块'
            assert prompt_requests('t_empty') == ['/api/tasks/t_empty/prompt'], prompt_requests('t_empty')

            # 390px: toolbar, select and snapshot wrap, nothing scrolls sideways.
            page.keyboard.press('Escape')
            page.locator('.card[data-id="t_input"]').click()
            dialog = page.get_by_role('dialog', name='筛选任务')
            dialog.get_by_role('button', name='任务执行依据', exact=True).click()
            page.set_viewport_size({'width': 390, 'height': 844})
            box = dialog.get_by_label('当时保存的执行输入')
            expect(box).to_be_visible()
            assert box.evaluate('e => e.textContent') == PROMPTS['run_new']
            snapshot = dialog.get_by_label('这次运行用的流程快照')
            expect(snapshot).to_be_visible()
            assert snapshot.locator('.flow-snapshot-phases li').all_inner_texts() == NEW_PHASES
            assert page.evaluate('document.documentElement.scrollWidth === innerWidth')
            assert page.evaluate("""() => {
              const body = document.querySelector('.drawer-body');
              return body.scrollWidth <= body.clientWidth + 1;
            }""")
            fits = page.evaluate("""() => {
              const drawer = document.querySelector('.drawer').getBoundingClientRect();
              return ['.input-toolbar', '#input-run-select', '.input-box', '.input-note', '.flow-snapshot',
                      '.flow-snapshot-phases li', '.flow-snapshot-links li'].map(selector => {
                const rect = document.querySelector(selector).getBoundingClientRect();
                return [selector, rect.left >= drawer.left - 1, rect.right <= drawer.right + 1];
              });
            }""")
            assert all(ok_left and ok_right for _, ok_left, ok_right in fits), fits
            assert snapshot.locator('.flow-snapshot-phases li').first.evaluate('e => e.scrollWidth <= e.clientWidth + 1')
            page.screenshot(path=output / 'basis-mobile.png')

            assert not errors, errors
        finally:
            for route, _ in held:
                route.abort()
            close_test_browser(browser)
    print('Saved-run input view, run switching, boundary states, retries and narrow layout passed.')
    if screenshots:
        print(f'Screenshots: {screenshots}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--screenshots', type=Path)
    main(parser.parse_args().screenshots)
