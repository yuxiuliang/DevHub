"""Browser regression for the round-9 gate tri-state behavior (fixture mode).

The default run intercepts every API call in memory (``page.route``) and renders the
real web UI against a fixed room/flow/tasks fixture, so it covers:

* the drawer 「完成条件」 text for auto / agent / human gates, including the phase
  name, ``最多打回 N 次`` and ``已打回 M 次``;
* the human gate's primary 「通过」 button (no 「自动检查」) and that one click sends
  exactly one ``POST /api/tasks/<id>/approve``;
* the agent gate's 「自动检查」/「人工通过」 pair without the primary action moving;
* an approved auto-gate task offering no 「自动检查」;
* the escalated drawer with the real ``reject_count``/``maxLoop`` values (3/3, not a
  hardcoded 2), 「按意见重跑」/「取消任务」, and the after-diff buttons;
* the ``gate.waiting`` / ``gate.passed`` / ``gate.escalated`` timeline texts;
* a 390px viewport without horizontal overflow.

``--backend node|rust|all`` switches to the real backends (see browser_gate_real).
"""

import argparse
import json
import os
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright

from browser_cleanup import close_test_browser, launch_test_browser

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / 'web'
STAMP = '2026-11-23T00:00:00.000Z'
ROOM_ID = 'r_gate'

HUMAN_HINT = '人工确认：等你看完改动后点「通过」，再决定是否合并。'
AGENT_HINT = '评审通过：由评审者检查改动后给出结论，不通过会打回给执行者。'
AUTO_HINT = '自动通过：这次有产出就算通过，不用评审，可以直接合并。'

FLOW = {
    'id': 'flow-gate',
    'name': '门禁验收流程',
    'nodes': [
        {'id': 'n_human', 'type': 'phase', 'name': '人工验收', 'owner': '', 'gate': 'human',
         'outputs': ['brief'], 'maxLoop': 3, 'x': 40, 'y': 90},
        {'id': 'n_agent', 'type': 'phase', 'name': '代码评审', 'owner': '', 'gate': 'agent',
         'outputs': ['review_report'], 'maxLoop': 2, 'x': 270, 'y': 90},
        {'id': 'n_auto', 'type': 'phase', 'name': '自动实现', 'owner': '', 'gate': 'auto',
         'outputs': ['code_diff'], 'maxLoop': 0, 'x': 500, 'y': 90},
        {'id': 'n_agent3', 'type': 'phase', 'name': '严格评审', 'owner': '', 'gate': 'agent',
         'outputs': ['review_report'], 'maxLoop': 3, 'x': 730, 'y': 90},
    ],
    'edges': [
        {'from': 'n_human', 'to': 'n_agent', 'condition': 'passed'},
        {'from': 'n_agent', 'to': 'n_auto', 'condition': 'passed'},
        {'from': 'n_auto', 'to': 'n_agent3', 'condition': 'passed'},
    ],
}

TASKS = [
    {'id': 't_human', 'key': 'T1', 'title': '人工门禁任务', 'type': 'code', 'owner_id': 'm_one',
     'phase_id': 'n_human', 'status': 'review', 'reject_count': 1, 'updated_at': STAMP,
     'spec': '验证人工门禁的通过动作。', 'acceptance': ['能通过人工确认'], 'summary': '人工门禁产出已准备好。',
     'feedback': '', 'result_sha': 'sha_human', 'diff_stat': ' gate-result.txt | 1 +\n 1 file changed, 1 insertion(+)',
     'branch': 'devhub/r_gate/T1', 'worktree': 'D:/tmp/wt/t_human'},
    {'id': 't_agent', 'key': 'T2', 'title': '评审门禁任务', 'type': 'code', 'owner_id': 'm_one',
     'phase_id': 'n_agent', 'status': 'review', 'reject_count': 0, 'updated_at': STAMP,
     'spec': '验证评审门禁的动作组合。', 'acceptance': ['能自动检查'], 'summary': '评审门禁产出已准备好。',
     'feedback': '', 'result_sha': 'sha_agent', 'diff_stat': ' gate-result.txt | 1 +\n 1 file changed, 1 insertion(+)',
     'branch': 'devhub/r_gate/T2', 'worktree': 'D:/tmp/wt/t_agent'},
    {'id': 't_auto', 'key': 'T3', 'title': '自动门禁任务', 'type': 'code', 'owner_id': 'm_one',
     'phase_id': 'n_auto', 'status': 'approved', 'reject_count': 0, 'updated_at': STAMP,
     'spec': '验证自动门禁已通过。', 'acceptance': ['有产出即通过'], 'summary': '自动门禁产出已准备好。',
     'feedback': '', 'result_sha': 'sha_auto', 'diff_stat': ' gate-result.txt | 1 +\n 1 file changed, 1 insertion(+)',
     'branch': 'devhub/r_gate/T3', 'worktree': 'D:/tmp/wt/t_auto'},
    {'id': 't_escalated', 'key': 'T4', 'title': '升级门禁任务', 'type': 'code', 'owner_id': 'm_one',
     'phase_id': 'n_agent3', 'status': 'escalated', 'reject_count': 3, 'updated_at': STAMP,
     'spec': '验证打回上限后的升级状态。', 'acceptance': ['升级后能人工决定'],
     'summary': '已经打回 3 次，达到本阶段上限。', 'feedback': '第 3 轮评审：\n- README.md:1 需要补充',
     'result_sha': 'sha_esc', 'diff_stat': ' gate-result.txt | 1 +\n 1 file changed, 1 insertion(+)',
     'branch': 'devhub/r_gate/T4', 'worktree': 'D:/tmp/wt/t_escalated'},
]

DIFFS = {
    't_human': 'diff --git a/gate-result.txt b/gate-result.txt\n+人工确认改动\n',
    't_agent': 'diff --git a/gate-result.txt b/gate-result.txt\n+评审门禁改动\n',
    't_auto': 'diff --git a/gate-result.txt b/gate-result.txt\n+自动门禁改动\n',
    't_escalated': 'diff --git a/gate-result.txt b/gate-result.txt\n+升级门禁改动\n',
}

EVENTS = [
    {'id': 1, 'room_id': ROOM_ID, 'task_id': 't_human', 'run_id': None, 'type': 'gate.waiting',
     'payload': {'gate': 'human', 'maxLoop': 3, 'rejectCount': 1, 'resultSha': 'sha_human', 'key': 'T1'},
     'created_at': STAMP},
    {'id': 2, 'room_id': ROOM_ID, 'task_id': 't_agent', 'run_id': None, 'type': 'gate.waiting',
     'payload': {'gate': 'agent', 'maxLoop': 2, 'rejectCount': 0, 'resultSha': 'sha_agent', 'key': 'T2'},
     'created_at': STAMP},
    {'id': 3, 'room_id': ROOM_ID, 'task_id': 't_auto', 'run_id': None, 'type': 'gate.passed',
     'payload': {'gate': 'auto', 'resultSha': 'sha_auto', 'checks': ['diff'], 'maxLoop': 2, 'rejectCount': 0,
                 'key': 'T3'},
     'created_at': STAMP},
    {'id': 4, 'room_id': ROOM_ID, 'task_id': 't_escalated', 'run_id': None, 'type': 'gate.escalated',
     'payload': {'gate': 'agent', 'by': 'agent', 'maxLoop': 3, 'rejectCount': 3, 'round': 3, 'key': 'T4'},
     'created_at': STAMP},
]

STATIC = {
    '/': ('index.html', 'text/html'),
    '/app.js': ('app.js', 'application/javascript'),
    '/plan-draft.js': ('plan-draft.js', 'application/javascript'),
    '/log-buffer.js': ('log-buffer.js', 'application/javascript'),
    '/edit-drafts.js': ('edit-drafts.js', 'application/javascript'),
    '/style.css': ('style.css', 'text/css'),
}

EVENT_STUB = """window.EventSource = class {
  constructor() { window.gateEvents = this; queueMicrotask(() => this.onopen?.()); }
  close() {}
};"""


def class_tokens(locator):
    return (locator.get_attribute('class') or '').split()


def run_fixture():
    errors, requests, posts = [], [], []
    tasks = [dict(task) for task in TASKS]
    by_id = {task['id']: task for task in tasks}
    room = {
        'id': ROOM_ID, 'name': '门禁演示', 'repo_path': 'D:/sample', 'base_branch': 'main',
        'requirement': '验证门禁三态驱动执行', 'mode': 'serial', 'status': 'running',
        'auto_approve': False, 'flow': FLOW, 'plan': None, 'updated_at': STAMP,
    }

    def response(route):
        request = route.request
        target = urlsplit(request.url)
        path = target.path
        requests.append(path + (f'?{target.query}' if target.query else ''))
        if request.method == 'POST':
            posts.append(path)
        if path in STATIC:
            name, mime = STATIC[path]
            return route.fulfill(body=(WEB / name).read_bytes(), content_type=mime + '; charset=utf-8')
        if path == '/api/workers':
            return route.fulfill(json={'workers': [{'key': 'codex', 'label': 'Codex', 'available': True}]})
        if path == '/api/state':
            return route.fulfill(json={
                'rooms': [dict(room, counts={'total': len(tasks), 'running': 0, 'review': 3, 'done': 0, 'failed': 1})],
                'running': [], 'activeWorkers': 0, 'flowTemplates': [], 'inbox': [],
            })
        if path == f'/api/rooms/{ROOM_ID}':
            return route.fulfill(json=dict(room=room, tasks=tasks, events=EVENTS, reviews=[], decisions=[],
                                           members=[{'id': 'm_one', 'name': '协作助手', 'enabled': True,
                                                     'worker': 'codex', 'concurrency': 1}]))
        if request.method == 'POST' and path == '/api/tasks/t_human/approve':
            by_id['t_human']['status'] = 'approved'
            return route.fulfill(json={'status': 'approved'})
        if path.startswith('/api/tasks/') and path.endswith('/diff'):
            task_id = path.split('/')[3]
            task = by_id.get(task_id)
            if task is None:
                return route.fulfill(status=404, json={'error': '任务不存在'})
            return route.fulfill(json={'diff': DIFFS[task_id], 'resultSha': task['result_sha']})
        return route.fulfill(status=404, json={'error': 'not found', 'path': path})

    with sync_playwright() as pw:
        browser = launch_test_browser(pw)
        page = browser.new_page(viewport={'width': 1280, 'height': 800})
        page.set_default_timeout(10000)
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.add_init_script(EVENT_STUB)
        page.route('http://devhub.invalid/**', response)
        stage = 'open-room'
        try:
            page.goto('http://devhub.invalid/', wait_until='domcontentloaded')
            expect(page.locator('.card[data-id="t_human"]')).to_be_visible()

            # --- human gate + review: primary 「通过」, one approve POST -----------
            stage = 'human-gate'
            page.locator('.card[data-id="t_human"]').click()
            dialog = page.get_by_role('dialog', name='人工门禁任务', exact=True)
            expect(dialog).to_be_visible()
            expect(dialog.get_by_text(HUMAN_HINT, exact=True)).to_be_visible()
            expect(dialog.get_by_text('阶段：人工验收 · 最多打回 3 次，已打回 1 次', exact=True)).to_be_visible()
            expect(dialog.get_by_role('button', name='查看改动', exact=True)).to_be_visible()
            expect(dialog.get_by_role('button', name='通过', exact=True)).to_have_count(0)
            stage = 'human-diff'
            with page.expect_response(lambda response: response.request.method == 'GET'
                                      and urlsplit(response.url).path == '/api/tasks/t_human/diff') as loaded:
                dialog.get_by_role('button', name='查看改动', exact=True).click()
            assert loaded.value.status == 200
            expect(dialog.locator('.diff-box')).to_contain_text('人工确认改动')
            approve = dialog.get_by_role('button', name='通过', exact=True)
            expect(approve).to_be_visible()
            assert 'primary' in class_tokens(approve), approve.get_attribute('class')
            expect(dialog.get_by_role('button', name='自动检查', exact=True)).to_have_count(0)
            expect(dialog.get_by_role('button', name='人工通过', exact=True)).to_have_count(0)
            merge = dialog.get_by_role('button', name='合并到项目', exact=True)
            expect(merge).to_be_visible()
            assert 'primary' not in class_tokens(merge), merge.get_attribute('class')
            expect(dialog.get_by_role('button', name='退回修改', exact=True)).to_be_visible()
            stage = 'human-approve'
            with page.expect_response(lambda response: response.request.method == 'POST'
                                      and urlsplit(response.url).path == '/api/tasks/t_human/approve') as approved:
                approve.click()
            assert approved.value.status == 200
            expect(dialog.locator('.d-sub')).to_contain_text('已通过')
            expect(dialog.get_by_role('button', name='通过', exact=True)).to_have_count(0)
            expect(dialog.get_by_role('button', name='合并到项目', exact=True)).to_be_visible()
            assert posts.count('/api/tasks/t_human/approve') == 1, posts
            page.keyboard.press('Escape')
            expect(dialog).to_have_count(0)

            # --- agent gate + review: 「自动检查」+「人工通过」, no primary mix-up ----
            stage = 'agent-gate'
            page.locator('.card[data-id="t_agent"]').click()
            dialog = page.get_by_role('dialog', name='评审门禁任务', exact=True)
            expect(dialog.get_by_text(AGENT_HINT, exact=True)).to_be_visible()
            expect(dialog.get_by_text('阶段：代码评审 · 最多打回 2 次', exact=True)).to_be_visible()
            expect(dialog.get_by_text('已打回', exact=False)).to_have_count(0)
            with page.expect_response(lambda response: response.request.method == 'GET'
                                      and urlsplit(response.url).path == '/api/tasks/t_agent/diff'):
                dialog.get_by_role('button', name='查看改动', exact=True).click()
            expect(dialog.locator('.diff-box')).to_contain_text('评审门禁改动')
            expect(dialog.get_by_role('button', name='自动检查', exact=True)).to_be_visible()
            manual = dialog.get_by_role('button', name='人工通过', exact=True)
            expect(manual).to_be_visible()
            assert 'primary' not in class_tokens(manual), manual.get_attribute('class')
            merge = dialog.get_by_role('button', name='合并到项目', exact=True)
            expect(merge).to_be_visible()
            assert 'primary' in class_tokens(merge), merge.get_attribute('class')
            expect(dialog.get_by_role('button', name='通过', exact=True)).to_have_count(0)
            expect(dialog.get_by_role('button', name='退回修改', exact=True)).to_be_visible()
            page.keyboard.press('Escape')
            expect(dialog).to_have_count(0)

            # --- auto gate + approved: no 「自动检查」 ------------------------------
            stage = 'auto-gate'
            page.locator('.card[data-id="t_auto"]').click()
            dialog = page.get_by_role('dialog', name='自动门禁任务', exact=True)
            expect(dialog.get_by_text(AUTO_HINT, exact=True)).to_be_visible()
            expect(dialog.get_by_text('阶段：自动实现 · 最多打回 2 次', exact=True)).to_be_visible()
            with page.expect_response(lambda response: response.request.method == 'GET'
                                      and urlsplit(response.url).path == '/api/tasks/t_auto/diff'):
                dialog.get_by_role('button', name='查看改动', exact=True).click()
            expect(dialog.locator('.diff-box')).to_contain_text('自动门禁改动')
            expect(dialog.get_by_role('button', name='自动检查', exact=True)).to_have_count(0)
            expect(dialog.get_by_role('button', name='人工通过', exact=True)).to_have_count(0)
            expect(dialog.get_by_role('button', name='通过', exact=True)).to_have_count(0)
            expect(dialog.get_by_role('button', name='合并到项目', exact=True)).to_be_visible()
            expect(dialog.get_by_role('button', name='退回修改', exact=True)).to_be_visible()
            page.keyboard.press('Escape')
            expect(dialog).to_have_count(0)

            # --- escalated: real reject_count/maxLoop (3/3), buttons before/after diff
            stage = 'escalated-gate'
            page.locator('.card[data-id="t_escalated"]').click()
            dialog = page.get_by_role('dialog', name='升级门禁任务', exact=True)
            expect(dialog.get_by_text('阶段：严格评审 · 最多打回 3 次，已打回 3 次', exact=True)).to_be_visible()
            expect(dialog.get_by_role('heading', name='已到打回上限', exact=True)).to_be_visible()
            expect(dialog.get_by_text('这个任务已经打回 3 次，达到本阶段上限（3 次），系统不会继续自动检查。'
                                      '请按意见重跑、人工通过，或取消任务。', exact=True)).to_be_visible()
            expect(dialog.get_by_text('已经打回 3 次，达到本阶段上限（3 次）。可以按意见重跑、人工通过，或取消任务。',
                                      exact=True)).to_be_visible()
            assert '打回 2 次' not in dialog.inner_text(), 'escalation text must use the real maxLoop'
            expect(dialog.get_by_role('button', name='按意见重跑', exact=True)).to_be_visible()
            expect(dialog.get_by_role('button', name='取消任务', exact=True)).to_be_visible()
            expect(dialog.get_by_role('button', name='人工通过', exact=True)).to_have_count(0)
            with page.expect_response(lambda response: response.request.method == 'GET'
                                      and urlsplit(response.url).path == '/api/tasks/t_escalated/diff'):
                dialog.get_by_role('button', name='查看改动', exact=True).click()
            expect(dialog.locator('.diff-box')).to_contain_text('升级门禁改动')
            expect(dialog.get_by_role('button', name='人工通过', exact=True)).to_be_visible()
            expect(dialog.get_by_role('button', name='退回修改', exact=True)).to_be_visible()
            expect(dialog.get_by_role('button', name='合并到项目', exact=True)).to_be_visible()
            expect(dialog.get_by_role('button', name='自动检查', exact=True)).to_have_count(0)
            expect(dialog.get_by_role('button', name='按意见重跑', exact=True)).to_be_visible()
            expect(dialog.get_by_role('button', name='取消任务', exact=True)).to_be_visible()
            page.keyboard.press('Escape')
            expect(dialog).to_have_count(0)

            # --- timeline texts for the three gate events --------------------------
            stage = 'timeline'
            timeline = page.locator('.timeline')
            expect(timeline).to_be_visible()
            expect(page.locator('.tl-item')).to_have_count(4)
            expect(timeline).to_contain_text('T1 等待人工确认')
            expect(timeline).to_contain_text('T2 等待评审')
            expect(timeline).to_contain_text('T3 检查通过 · 自动通过')
            expect(timeline).to_contain_text('T4 已打回 3 次，达到上限，转人工决定')

            # --- 390px: drawer and its actions stay inside the viewport ------------
            stage = 'narrow'
            page.set_viewport_size({'width': 390, 'height': 844})
            page.locator('.card[data-id="t_escalated"]').click()
            dialog = page.get_by_role('dialog', name='升级门禁任务', exact=True)
            with page.expect_response(lambda response: response.request.method == 'GET'
                                      and urlsplit(response.url).path == '/api/tasks/t_escalated/diff'):
                dialog.get_by_role('button', name='改动', exact=True).click()
            expect(dialog.get_by_role('button', name='人工通过', exact=True)).to_be_visible()
            assert page.evaluate('document.documentElement.scrollWidth === innerWidth')
            body = page.evaluate("""() => {
              const box = document.querySelector('.drawer-body');
              return [box.scrollWidth, box.clientWidth];
            }""")
            assert body[0] <= body[1] + 1, body
            fits = page.evaluate("""() => {
              const drawer = document.querySelector('.drawer').getBoundingClientRect();
              const nodes = [document.querySelector('.drawer-head'), document.querySelector('.drawer-tabs'),
                             document.querySelector('.drawer-body'), document.querySelector('.drawer-foot'),
                             ...document.querySelectorAll('.drawer-foot button')];
              return nodes.map((node) => {
                const rect = node.getBoundingClientRect();
                return [node.className || node.tagName, rect.left >= drawer.left - 1,
                        rect.right <= drawer.right + 1];
              });
            }""")
            assert all(left and right for _, left, right in fits), fits
            expect(dialog.get_by_role('button', name='合并到项目', exact=True)).to_be_visible()
            assert not any(path.endswith('/review') for path in posts), posts
            assert not errors, errors
        except Exception:
            diagnostic = {'mode': 'fixture', 'stage': stage, 'pageErrors': errors[-6:],
                          'recentRequests': requests[-24:], 'posts': posts[-24:]}
            try:
                diagnostic['drawer'] = page.locator('#drawer-root').inner_text(timeout=2000)[:6000]
            except Exception as error:
                diagnostic['drawerError'] = str(error)
            print('Fixture failure diagnostics: ' + json.dumps(diagnostic, ensure_ascii=False), flush=True)
            raise
        finally:
            close_test_browser(browser)
    print('fixture: gate drawer texts, human/agent/auto buttons, one-shot approve, '
          'escalation details, timeline and 390px layout passed')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--backend', choices=('fixture', 'node', 'rust', 'all'), default='fixture')
    parser.add_argument('--rust-exe', type=Path, default=ROOT / 'rust' / 'target' / 'debug' / 'devhub.exe')
    args = parser.parse_args()
    if os.name != 'nt':
        parser.error('The test uses a Windows .cmd fixture for the current Node adapter.')
    if args.backend == 'fixture':
        run_fixture()
        return
    from browser_gate_real import run_case
    with sync_playwright() as pw:
        browser = launch_test_browser(pw)
        try:
            for backend in (('node', 'rust') if args.backend == 'all' else (args.backend,)):
                run_case(browser, backend, args.rust_exe.resolve())
        finally:
            close_test_browser(browser)


if __name__ == '__main__':
    main()
