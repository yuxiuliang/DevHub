"""Flow save-validation browser acceptance: in-memory UI fixture plus real Node/Rust backends.

Part A intercepts every request at http://devhub.invalid/ so the flow editor can be
driven without a server. Part B starts an isolated real backend in a temporary
directory and exercises the same UI plus direct PATCH calls.
"""

import argparse
from copy import deepcopy
import json
from pathlib import Path
import shutil
import tempfile
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from playwright.sync_api import expect, sync_playwright

from browser_cleanup import close_test_browser, launch_test_browser
from browser_flow import ROOT, make_fixture, serve_fixture

WEB = ROOT / 'web'
STATIC = ('/', '/app.js', '/plan-draft.js', '/log-buffer.js', '/edit-drafts.js', '/style.css')
REJECT_MESSAGE = '回边必须设置打回上限（maxLoop ≥ 1）：评审 → 实现'
EVENT_SOURCE_STUB = """window.EventSource = class {
  constructor() { window.flowEvents = this; queueMicrotask(() => this.onopen?.()); }
  close() {}
};"""


def member(key, name):
    return dict(key=key, id=key, name=name, worker='codex', role_name='', role_brief='',
                model='', concurrency=1, enabled=True)


def open_room(page, room_id, name):
    """Wait for boot's auto-open, or open the room from the rail if it stayed on overview."""
    page.wait_for_selector(f'.room-head h1, [data-act="open-room"][data-id="{room_id}"]', timeout=15000)
    if page.locator('.room-head h1').count() == 0:
        page.locator(f'[data-act="open-room"][data-id="{room_id}"]').first.click()
    expect(page.locator('.room-head h1')).to_have_text(name)


# ---------------------------------------------------------------- part A: fixture UI


def verify_fixture_ui():
    flow = {
        'id': 'flow-code', 'name': '代码流程', 'template': 'code',
        'nodes': [
            dict(id='n1', type='phase', name='需求澄清', owner='', gate='human', outputs=['prd'], x=40, y=90, maxLoop=0),
            dict(id='n2', type='phase', name='方案设计', owner='', gate='agent', outputs=['design'], x=270, y=130, maxLoop=0),
            dict(id='n3', type='phase', name='实现', owner='', gate='auto', outputs=['code_diff'], x=500, y=90, maxLoop=0),
            dict(id='n4', type='phase', name='评审', owner='', gate='agent', outputs=['review_report'], x=730, y=130, maxLoop=0),
        ],
        'edges': [
            {'from': 'n1', 'to': 'n2', 'condition': 'passed'},
            {'from': 'n2', 'to': 'n3', 'condition': 'passed'},
            {'from': 'n3', 'to': 'n4', 'condition': 'passed'},
        ],
    }
    room = dict(id='r_flow', name='流程保存校验', requirement='验证流程保存校验', status='draft',
                repo_path='D:/demo', base_branch='main', mode='serial', auto_approve=False,
                flow=deepcopy(flow), plan=None)
    errors, patches = [], []
    flags = dict(fail_patch=True)

    def room_state():
        return dict(room=deepcopy(room), tasks=[], events=[], decisions=[], reviews=[],
                    members=[member('m_one', '执行助手'), member('m_two', '检查助手')])

    def respond(route):
        request = route.request
        path = urlsplit(request.url).path
        if path in STATIC:
            name = 'index.html' if path == '/' else path[1:]
            mime = {'html': 'text/html', 'js': 'application/javascript', 'css': 'text/css'}[name.rsplit('.', 1)[1]]
            return route.fulfill(body=(WEB / name).read_bytes(), content_type=mime + '; charset=utf-8')
        if path == '/api/workers':
            return route.fulfill(json={'workers': [dict(key='codex', label='Codex', available=True)]})
        if path == '/api/state':
            return route.fulfill(json=dict(
                rooms=[dict(room, counts=dict(total=0, running=0, review=0, done=0, failed=0))],
                running=[], inbox=[], flowTemplates=[]))
        if path == '/api/rooms/r_flow':
            if request.method == 'PATCH':
                payload = request.post_data_json
                patches.append(payload)
                if flags['fail_patch']:
                    return route.fulfill(status=400, json={'error': REJECT_MESSAGE})
                if payload['expectedFlow'] != room['flow']:
                    return route.fulfill(status=409, json={'error': '流程已在其他地方更新，请重新加载最新流程后再保存'})
                room['flow'] = deepcopy(payload['flow'])
                room['updated_at'] = '2026-11-22T00:00:01.000Z'
                return route.fulfill(json=room_state())
            return route.fulfill(json=room_state())
        return route.fulfill(status=404)

    with sync_playwright() as pw:
        browser = launch_test_browser(pw)
        page = browser.new_page(viewport={'width': 1280, 'height': 900})
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('dialog', lambda dialog: dialog.accept())
        page.add_init_script(EVENT_SOURCE_STUB)
        page.route('http://devhub.invalid/**', respond)
        try:
            page.goto('http://devhub.invalid/', wait_until='domcontentloaded')
            open_room(page, 'r_flow', '流程保存校验')
            page.locator('button[data-act="tab"][data-tab="flow"]').click()

            # maxLoop only exists in advanced mode; the auto-fill itself is independent of it.
            page.locator('[data-act="flow-mode"]').click()
            expect(page.locator('[data-act="flow-mode"]')).to_have_text('简单模式')
            page.locator('.fnode[data-node="n4"]').click()
            reject = page.locator('#flow-reject')
            expect(reject).to_have_value('')
            expect(page.locator('#flow-max-loop')).to_have_value('0')
            reject.select_option('n3')
            expect(page.locator('#flow-max-loop')).to_have_value('2')
            expect(page.locator('.fnode[data-node="n4"] .badge.err')).to_have_text('打回≤2')
            save = page.locator('[data-act="flow-save"]')
            expect(save).to_be_enabled()

            # 1. A 400 from the server is shown verbatim and the local draft survives.
            save.click()
            error = page.locator('#flow-save-error')
            expect(error).to_be_visible()
            expect(error).to_have_attribute('role', 'alert')
            expect(error).to_have_text(REJECT_MESSAGE)
            expect(reject).to_have_value('n3')
            expect(page.locator('#flow-max-loop')).to_have_value('2')
            expect(page.locator('.fnode[data-node="n4"] .badge.err')).to_have_text('打回≤2')
            expect(page.locator('#flow-draft-status')).to_have_text('草稿已保留，尚未保存到会话。')
            expect(page.locator('#flow-name')).to_be_enabled()
            expect(page.locator('#flow-owner')).to_be_enabled()
            expect(page.locator('[data-act="flow-del"]')).to_be_enabled()
            expect(page.get_by_text('流程只读', exact=False)).to_have_count(0)
            expect(save).to_be_enabled()
            assert len(patches) == 1, patches
            sent = patches[0]['flow']
            assert next(node for node in sent['nodes'] if node['id'] == 'n4')['maxLoop'] == 2, sent
            assert {'from': 'n4', 'to': 'n3', 'condition': 'rejected'} in sent['edges'], sent

            # 2. The retry succeeds: the error hides, the toast appears, and the saved
            #    flow replaces the draft baseline.
            flags['fail_patch'] = False
            with page.expect_response(lambda response: urlsplit(response.url).path == '/api/rooms/r_flow'
                                      and response.request.method == 'PATCH') as saved:
                save.click()
            assert saved.value.status == 200
            expect(error).to_be_hidden()
            expect(page.get_by_text('流程已保存', exact=True)).to_be_visible()
            expect(page.locator('#flow-draft-status')).to_have_text('当前显示已保存的流程。')
            expect(save).to_be_disabled()
            expect(page.locator('.fnode[data-node="n4"] .badge.err')).to_have_text('打回≤2')
            saved_flow = room['flow']
            assert next(node for node in saved_flow['nodes'] if node['id'] == 'n4')['maxLoop'] == 2
            assert {'from': 'n4', 'to': 'n3', 'condition': 'rejected'} in saved_flow['edges']
            assert len(patches) == 2 and patches[1]['expectedFlow'] == flow, patches

            # 3. The flow page stays operable at 390px with no page-level overflow.
            page.set_viewport_size({'width': 390, 'height': 844})
            page.locator('.fnode[data-node="n1"]').click()
            name = page.locator('#flow-name')
            expect(name).to_be_visible()
            expect(name).to_be_enabled()
            name.fill('窄屏可编辑')
            expect(page.locator('.fnode[data-node="n1"] .fn-name')).to_have_text('窄屏可编辑')
            expect(save).to_be_enabled()
            assert page.evaluate('document.documentElement.scrollWidth === innerWidth'), '390px overflow'
            assert not errors, errors
            print('fixture: flow auto-fill, 400 message/draft retention, retry save and 390px layout passed', flush=True)
        except BaseException:
            print('Fixture UI failure diagnostics: ' + json.dumps(
                {'pageErrors': errors, 'patches': patches}, ensure_ascii=False), flush=True)
            raise
        finally:
            close_test_browser(browser)


# ---------------------------------------------------------------- part B: real backends


def api_call(url, path, method='GET', body=None):
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode('utf-8')
    request = Request(url + path, data=data, method=method, headers={'Content-Type': 'application/json'})
    try:
        with urlopen(request, timeout=15) as response:
            return response.status, json.load(response)
    except HTTPError as error:
        raw = error.read()
        try:
            return error.code, json.loads(raw)
        except ValueError:
            return error.code, {'raw': raw.decode('utf-8', 'replace')}


def api(url, path, method='GET', body=None):
    status, payload = api_call(url, path, method, body)
    assert status == 200, (method, path, status, payload)
    return payload


def flow_node(flow, name):
    return next(node for node in flow['nodes'] if node['name'] == name)


def has_edge(flow, source, target, condition):
    return any(edge['from'] == source and edge['to'] == target and edge.get('condition') == condition
               for edge in flow['edges'])


def assert_single_start_and_connected(flow):
    incoming = {node['id']: 0 for node in flow['nodes']}
    outgoing = {node['id']: [] for node in flow['nodes']}
    for edge in flow['edges']:
        incoming[edge['to']] += 1
        outgoing[edge['from']].append(edge['to'])
    starts = [node_id for node_id, count in incoming.items() if count == 0]
    assert len(starts) == 1, starts
    reached = {starts[0]}
    stack = [starts[0]]
    while stack:
        for target in outgoing[stack.pop()]:
            if target not in reached:
                reached.add(target)
                stack.append(target)
    assert reached == set(incoming), '存在孤立节点'


def rejected_patch(url, room_id, mutate, expected_message, label):
    """Apply a mutation to the current flow, expect a 400, and prove nothing was written."""
    before = api(url, f'/api/rooms/{room_id}')
    current = deepcopy(before['room']['flow'])
    candidate = deepcopy(current)
    mutate(candidate)
    status, payload = api_call(url, f'/api/rooms/{room_id}', 'PATCH',
                               {'flow': candidate, 'expectedFlow': current})
    assert status == 400, (label, status, payload)
    assert payload.get('error') == expected_message, (label, payload.get('error'))
    after = api(url, f'/api/rooms/{room_id}')
    assert after['room']['flow'] == current, f'{label}: 失败的 PATCH 不应写入 flow_json'
    assert after['room']['updated_at'] == before['room']['updated_at'], f'{label}: 失败的 PATCH 不应更新会话'
    return payload['error']


def verify_invalid_graphs(url, room_id):
    """Run before the UI edits: these cases rely on the intact 5-phase code template."""
    flow = api(url, f'/api/rooms/{room_id}')['room']['flow']
    assert [node['name'] for node in flow['nodes']] == ['需求澄清', '方案设计', '实现', '评审', '合并'], flow['nodes']
    assert has_edge(flow, 'n1', 'n2', 'passed')

    def drop_first_edge(candidate):
        candidate['edges'] = [edge for edge in candidate['edges']
                              if not (edge['from'] == 'n1' and edge['to'] == 'n2')]

    actual = rejected_patch(url, room_id, drop_first_edge, '流程必须有且只有一个起始阶段', '去掉 n1→n2')
    print(f'  invalid graph (drop n1→n2): {actual}', flush=True)

    # The task's literal "n3 → n1 passed edge" makes the unique start lose its
    # incoming-degree-0 status, so the start check fires before the cycle check.
    # Assert that exact precedence instead of relaxing anything.
    def add_three_to_one(candidate):
        candidate['edges'].append({'from': 'n3', 'to': 'n1', 'condition': 'passed'})

    actual = rejected_patch(url, room_id, add_three_to_one, '流程必须有且只有一个起始阶段', 'n3→n1')
    print(f'  invalid graph (literal n3→n1 first hits the start check): {actual}', flush=True)

    # A passed cycle that keeps exactly one start: 方案设计 ⇄ 实现 via passed edges.
    def add_three_to_two(candidate):
        candidate['edges'].append({'from': 'n3', 'to': 'n2', 'condition': 'passed'})

    actual = rejected_patch(url, room_id, add_three_to_two,
                            '流程不能有由通过边构成的循环：方案设计 → 实现', 'n3→n2')
    print(f'  invalid graph (passed cycle): {actual}', flush=True)

    def rename_owner(candidate):
        flow_node(candidate, '方案设计')['owner'] = '不在成员列表的人'

    actual = rejected_patch(url, room_id, rename_owner,
                            '阶段「方案设计」的负责人「不在成员列表的人」不在成员列表中', '未知负责人')
    print(f'  invalid graph (unknown owner): {actual}', flush=True)

    def clear_review_max_loop(candidate):
        flow_node(candidate, '评审')['maxLoop'] = 0

    actual = rejected_patch(url, room_id, clear_review_max_loop, REJECT_MESSAGE, '评审 maxLoop=0')
    print(f'  invalid graph (rejected back edge without limit): {actual}', flush=True)


def prepare_autofill_baseline(url, room_id):
    """Make the auto-fill observable on a flow that starts without a back edge.

    The code template already ships 评审 maxLoop=2 plus rejected→实现, so the exact
    "不回退 / maxLoop=0 → 实现" sequence would end value-identical to the saved flow
    and the save button would (correctly) stay disabled. Clearing those two values
    through a valid API save is the precondition for this UI scenario.
    """
    current = api(url, f'/api/rooms/{room_id}')['room']['flow']
    baseline = deepcopy(current)
    review = flow_node(baseline, '评审')
    review['maxLoop'] = 0
    baseline['edges'] = [edge for edge in baseline['edges']
                         if not (edge['from'] == review['id'] and edge.get('condition') == 'rejected')]
    api(url, f'/api/rooms/{room_id}', 'PATCH', {'flow': baseline, 'expectedFlow': current})
    saved = api(url, f'/api/rooms/{room_id}')['room']['flow']
    assert flow_node(saved, '评审')['maxLoop'] == 0, saved
    assert not has_edge(saved, review['id'], flow_node(saved, '实现')['id'], 'rejected'), saved['edges']
    print('  auto-fill baseline: cleared 评审 maxLoop/rejected edge via a valid API save', flush=True)


def verify_ui(browser, url, room_id):
    page = browser.new_page(viewport={'width': 1280, 'height': 900})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('dialog', lambda dialog: dialog.accept())
    try:
        page.goto(url, wait_until='domcontentloaded')
        open_room(page, room_id, '流程校验会话')
        page.locator('button[data-act="tab"][data-tab="flow"]').click()
        page.locator('[data-act="flow-mode"]').click()
        expect(page.locator('[data-act="flow-mode"]')).to_have_text('简单模式')

        flow = api(url, f'/api/rooms/{room_id}')['room']['flow']
        review_id = flow_node(flow, '评审')['id']
        impl_id = flow_node(flow, '实现')['id']
        design_id = flow_node(flow, '方案设计')['id']
        first_id = flow_node(flow, '需求澄清')['id']

        # 1. Choosing a rejected target auto-fills maxLoop=2 when it was 0.
        page.locator(f'.fnode[data-node="{review_id}"]').click()
        reject = page.locator('#flow-reject')
        expect(reject).to_have_value('')
        expect(page.locator('#flow-max-loop')).to_have_value('0')
        reject.select_option('')
        page.locator('#flow-max-loop').fill('0')
        expect(page.locator('#flow-max-loop')).to_have_value('0')
        reject.select_option(impl_id)
        expect(page.locator('#flow-max-loop')).to_have_value('2')
        expect(page.locator(f'.fnode[data-node="{review_id}"] .badge.err')).to_have_text('打回≤2')
        save = page.locator('[data-act="flow-save"]')
        expect(save).to_be_enabled()
        with page.expect_response(lambda response: urlsplit(response.url).path == f'/api/rooms/{room_id}'
                                  and response.request.method == 'PATCH') as saved:
            save.click()
        assert saved.value.status == 200, saved.value.text()
        expect(page.locator('#flow-draft-status')).to_have_text('当前显示已保存的流程。')
        expect(save).to_be_disabled()

        saved_flow = api(url, f'/api/rooms/{room_id}')['room']['flow']
        assert flow_node(saved_flow, '评审')['maxLoop'] == 2, saved_flow
        assert has_edge(saved_flow, review_id, impl_id, 'rejected'), saved_flow['edges']

        # 2. Deleting a middle phase reconnects its upstream and downstream.
        page.locator(f'.fnode[data-node="{design_id}"]').click()
        page.locator('[data-act="flow-del"]').click()
        expect(page.locator('.fnode')).to_have_count(4)
        with page.expect_response(lambda response: urlsplit(response.url).path == f'/api/rooms/{room_id}'
                                  and response.request.method == 'PATCH') as saved:
            page.locator('[data-act="flow-save"]').click()
        assert saved.value.status == 200, saved.value.text()
        expect(page.locator('#flow-draft-status')).to_have_text('当前显示已保存的流程。')

        after = api(url, f'/api/rooms/{room_id}')['room']['flow']
        names = [node['name'] for node in after['nodes']]
        assert '方案设计' not in names and len(after['nodes']) == 4, names
        assert has_edge(after, first_id, impl_id, 'passed'), after['edges']
        assert_single_start_and_connected(after)
        assert not errors, errors
    except BaseException:
        print('Real backend UI failure diagnostics: '
              + json.dumps({'pageErrors': errors}, ensure_ascii=False), flush=True)
        raise
    finally:
        page.close()


def run_case(browser, backend, rust_exe):
    with tempfile.TemporaryDirectory(prefix='devhub-flow-validation-') as temporary:
        directory = Path(temporary)
        repo, env, node = make_fixture(directory)
        if backend == 'node':
            shutil.copytree(ROOT / 'server', directory / 'server')
            shutil.copytree(ROOT / 'web', directory / 'web')
            shutil.copy(ROOT / 'package.json', directory / 'package.json')
            command = [str(node), 'server/index.js']
        else:
            command = [str(rust_exe), '--data', str(directory / '.data')]
        with serve_fixture(command, directory, env, backend) as url:
            created = api(url, '/api/rooms', 'POST', {
                'name': '流程校验会话', 'repoPath': str(repo), 'requirement': '验证流程保存校验',
                'mode': 'serial', 'autoApprove': False, 'flowTemplate': 'code',
                'members': [{'name': '执行者', 'worker': 'codex'}, {'name': '检查者', 'worker': 'codex'}],
                'plannerName': '执行者', 'reviewerName': '检查者',
            })
            room_id = created['room']['id']
            verify_invalid_graphs(url, room_id)
            prepare_autofill_baseline(url, room_id)
            verify_ui(browser, url, room_id)
    assert not directory.exists(), 'Fixture output must be removed after the server process tree exits'
    print(f'{backend}: flow auto-fill, delete-reconnect, and 4 rejected graphs with unchanged flow_json passed', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--backend', choices=('all', 'node', 'rust'), default='all')
    parser.add_argument('--rust-exe', type=Path, default=ROOT / 'rust' / 'target' / 'debug' / 'devhub.exe')
    args = parser.parse_args()
    verify_fixture_ui()
    with sync_playwright() as pw:
        browser = launch_test_browser(pw)
        try:
            for backend in (('node', 'rust') if args.backend == 'all' else (args.backend,)):
                run_case(browser, backend, args.rust_exe.resolve())
        finally:
            close_test_browser(browser)
    print('Flow save validation browser acceptance passed.', flush=True)


if __name__ == '__main__':
    main()
