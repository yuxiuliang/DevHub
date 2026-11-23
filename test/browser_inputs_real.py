"""Verify saved execution inputs and per-run flow snapshots end to end.

Each backend runs one code task twice (a first run, then a human reject that feeds
the review note into the second prompt) and checks the saved ``prompts/<runId>.md``
files and the per-run flow snapshots against what the 「依据」 drawer tab shows.
Between the two runs the room flow is patched through ``PATCH /api/rooms/{id}``:
the older run must keep its pre-patch snapshot while the newer run records the
patched flow.
"""

import argparse
from contextlib import closing
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import sys
import tempfile
import time
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from playwright.sync_api import expect, sync_playwright

from browser_cleanup import close_test_browser, launch_test_browser
from browser_flow import ROOT, make_fixture, serve_fixture


TITLE = '增加负责人筛选'
SPEC = '在任务板增加按负责人筛选，并保证没有匹配任务时显示空态说明。'
ACCEPTANCE = ['选中负责人后只显示该成员的任务', '没有匹配任务时显示空态说明']
NOTE = '请补充筛选空态'
INPUT_NOTE = '这里显示的是每次执行时保存的输入原文和当时的流程，不会按当前设置重新生成。'
SNAPSHOT_NOTE = '这是这次运行启动时保存的流程，之后改流程不会改变它。'
SNAPSHOT_LABEL = '这次运行用的流程快照'
NEW_PHASE = '验收'
STATUS_TEXT = {'completed': '已完成', 'failed': '失败', 'cancelled': '已取消', 'running': '运行中'}
RUN_TIMEOUT = 120


def api(url, path, method='GET', body=None, timeout=30):
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode('utf-8')
    request = Request(url + path, data=data, method=method, headers={'Content-Type': 'application/json'})
    try:
        with urlopen(request, timeout=timeout) as response:
            return json.load(response)
    except HTTPError as error:
        detail = error.read().decode('utf-8', 'replace')[:800]
        raise AssertionError(f'{method} {path} -> HTTP {error.code}: {detail}') from None


def flow_phase_names(flow):
    """Phase names in node order, falling back to id exactly like the drawer does."""
    return [node.get('name') or node.get('id') for node in (flow or {}).get('nodes', [])]


def snapshot_phase_texts(dialog):
    return dialog.get_by_label(SNAPSHOT_LABEL).locator('.flow-snapshot-phases li').all_inner_texts()


def assert_snapshot_phases(dialog, names):
    """The snapshot lists every phase in node order, numbered from 1."""
    texts = snapshot_phase_texts(dialog)
    assert len(texts) == len(names), (texts, names)
    for index, name in enumerate(names, start=1):
        assert texts[index - 1].startswith(f'{index}. {name}'), (texts, names)


def normalize(text):
    return text.replace('\r\n', '\n')


def emit(line):
    """Write one line as UTF-8 so captured output keeps diagnostics readable."""
    buffer = getattr(sys.stdout, 'buffer', None)
    if buffer is None:
        print(line, flush=True)
        return
    sys.stdout.flush()
    buffer.write((line + '\n').encode('utf-8', 'replace'))
    buffer.flush()


def latest_run(directory, task_id):
    """Read the newest run directly from SQLite using the same order as the API."""
    with closing(sqlite3.connect(directory / '.data' / 'devhub.db', timeout=15)) as database:
        row = database.execute(
            'SELECT id,status,started_at FROM runs WHERE task_id=? ORDER BY started_at DESC,rowid DESC LIMIT 1',
            (task_id,)).fetchone()
    assert row and row[0], f'no run recorded for task {task_id}'
    return {'id': row[0], 'status': row[1], 'started_at': row[2]}


def saved_prompt(directory, run_id):
    path = directory / '.data' / 'prompts' / f'{run_id}.md'
    assert path.is_file(), f'saved execution input is missing: {path}'
    assert path.stat().st_size > 0, f'saved execution input is empty: {path}'
    return path.read_text(encoding='utf-8')


def task_snapshot(url, room_id, task_id):
    state = api(url, f'/api/rooms/{room_id}')
    return next(task for task in state['tasks'] if task['id'] == task_id)


def wait_for_status(url, room_id, task_id, wanted, timeout=RUN_TIMEOUT):
    deadline = time.monotonic() + timeout
    task = None
    while time.monotonic() < deadline:
        task = task_snapshot(url, room_id, task_id)
        if task['status'] in wanted:
            return task
        time.sleep(0.2)
    raise AssertionError(f'task {task_id} did not reach {sorted(wanted)} in {timeout}s; '
                         f'last status={task and task["status"]!r}')


def start_and_finish(url, room_id, task_id):
    """Start one execution and wait for a terminal state, reporting failures."""
    started = api(url, f'/api/tasks/{task_id}/run', 'POST', {}, timeout=RUN_TIMEOUT)
    assert started.get('ok') is True, started
    task = wait_for_status(url, room_id, task_id, {'review', 'done', 'failed'})
    if task['status'] == 'failed':
        raise AssertionError(f'execution failed: status={task["status"]!r} '
                             f'summary={str(task.get("summary"))[:600]!r}')
    return task


def prompt_requests_for(page, prompt_path, sink):
    def record(request):
        parts = urlsplit(request.url)
        if parts.path == prompt_path:
            sink.append(parts.path + (f'?{parts.query}' if parts.query else ''))
    page.on('request', record)


def visit_case(browser, backend, url, directory, repo):
    created = api(url, '/api/rooms', 'POST', {
        'name': '执行输入验收', 'repoPath': str(repo), 'requirement': '验证每次执行保存的输入原文',
        'mode': 'serial', 'autoApprove': False,
        'members': [{'name': '执行者', 'worker': 'codex', 'roleName': '执行者'}],
        'plannerName': '执行者', 'reviewerName': '执行者',
    })
    room_id = created['room']['id']
    assert len(created['members']) == 1 and created['members'][0]['name'] == '执行者', created['members']
    task_id = api(url, '/api/tasks', 'POST', {
        'roomId': room_id, 'title': TITLE, 'type': 'code', 'spec': SPEC, 'acceptance': ACCEPTANCE,
    })['id']

    # First execution: the worker fixture writes a file, so the task lands in review.
    start_and_finish(url, room_id, task_id)
    first = latest_run(directory, task_id)
    first_prompt = saved_prompt(directory, first['id'])
    assert NOTE not in first_prompt, 'the first saved input must predate the review note'
    first_flow = api(url, f'/api/rooms/{room_id}')['room']['flow']
    first_names = flow_phase_names(first_flow)
    assert len(first_names) >= 2, first_names

    page = browser.new_page(viewport={'width': 1280, 'height': 800})
    errors, prompt_requests, trace = [], [], []
    trace_started = time.monotonic()
    prompt_path = f'/api/tasks/{task_id}/prompt'
    stage = 'open-input-tab'
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('dialog', lambda dialog: dialog.accept())
    page.on('request', lambda request: trace.append(
        (round(time.monotonic() - trace_started, 3), 'request', request.method, urlsplit(request.url).path))
        if urlsplit(request.url).path.startswith('/api/') else None)
    page.on('response', lambda response: trace.append(
        (round(time.monotonic() - trace_started, 3), 'response', response.status, urlsplit(response.url).path))
        if urlsplit(response.url).path.startswith('/api/') else None)
    page.on('requestfailed', lambda request: trace.append(
        (round(time.monotonic() - trace_started, 3), 'requestfailed', request.method, urlsplit(request.url).path)))
    prompt_requests_for(page, prompt_path, prompt_requests)
    try:
        page.goto(url, wait_until='domcontentloaded')
        page.locator(f'[data-act="open-room"][data-id="{room_id}"]').first.click()
        card = page.locator(f'.card[data-id="{task_id}"]')
        expect(card).to_be_visible()
        card.click()
        dialog = page.get_by_role('dialog', name=TITLE, exact=True)
        expect(dialog).to_be_visible()
        assert prompt_requests == [], f'overview must not read the saved input: {prompt_requests}'

        stage = 'first-run-input'
        views = dialog.get_by_role('group', name='任务详情视图', exact=True)
        input_tab = views.get_by_role('button', name='任务执行依据', exact=True)
        input_tab.click()
        expect(input_tab).to_have_attribute('aria-pressed', 'true')
        expect(dialog.get_by_role('heading', name='执行依据', exact=True)).to_be_visible()
        expect(dialog.get_by_text(INPUT_NOTE)).to_be_visible()
        box = dialog.get_by_label('当时保存的执行输入')
        expect(box).to_be_visible()
        assert normalize(box.evaluate('e => e.textContent')) == normalize(first_prompt), \
            'drawer text must equal the saved prompt file'
        assert box.evaluate('e => e.childElementCount') == 0, 'execution input must render as plain text'
        picker = dialog.get_by_label('选择运行记录')
        expect(picker).to_have_value(first['id'])
        expect(picker.locator('option')).to_have_count(1)
        labels = picker.locator('option').all_inner_texts()
        assert labels[0].startswith('第 1 次 · 已完成 · '), labels
        meta = dialog.locator('.input-meta')
        expect(meta).to_contain_text(f'本次运行：{STATUS_TEXT.get(first["status"], first["status"])}')
        meta_text = meta.inner_text()
        assert re.search(r'开始于 \S', meta_text), meta_text
        assert prompt_requests == [prompt_path], f'default read must not pass runId: {prompt_requests}'

        # The snapshot must list exactly the room flow that started this run.
        snapshot = dialog.get_by_label(SNAPSHOT_LABEL)
        expect(snapshot).to_be_visible()
        expect(snapshot.get_by_role('heading', name='流程快照', exact=True)).to_be_visible()
        expect(snapshot.get_by_text(SNAPSHOT_NOTE)).to_be_visible()
        assert_snapshot_phases(dialog, first_names)
        expect(snapshot.locator('.flow-snapshot-links li')).to_have_count(len(first_flow['edges']))

        # Patch the room flow while the first run stays historical: append 验收
        # after the old last phase with a passed edge (still one start, connected,
        # acyclic passed edges, and the existing rejected edge keeps its maxLoop).
        stage = 'patch-flow'
        patched_flow = json.loads(json.dumps(first_flow))
        last_node = patched_flow['nodes'][-1]
        patched_flow['nodes'].append({
            'id': 'n_accept', 'type': 'phase', 'name': NEW_PHASE, 'owner': '', 'gate': 'human',
            'outputs': [], 'maxLoop': 0,
            'x': last_node.get('x', 40) + 230, 'y': last_node.get('y', 90),
        })
        patched_flow['edges'].append({'from': last_node['id'], 'to': 'n_accept', 'condition': 'passed'})
        patched_names = flow_phase_names(patched_flow)
        saved = api(url, f'/api/rooms/{room_id}', 'PATCH',
                    {'flow': patched_flow, 'expectedFlow': first_flow})
        assert saved['room']['flow']['nodes'][-1]['name'] == NEW_PHASE, saved['room']['flow']
        assert flow_phase_names(saved['room']['flow']) == patched_names, saved['room']['flow']

        page.reload(wait_until='domcontentloaded')
        page.locator(f'[data-act="open-room"][data-id="{room_id}"]').first.click()
        card = page.locator(f'.card[data-id="{task_id}"]')
        expect(card).to_be_visible()
        card.click()
        dialog = page.get_by_role('dialog', name=TITLE, exact=True)
        expect(dialog).to_be_visible()
        views = dialog.get_by_role('group', name='任务详情视图', exact=True)
        input_tab = views.get_by_role('button', name='任务执行依据', exact=True)
        input_tab.click()
        expect(dialog.get_by_role('heading', name='执行依据', exact=True)).to_be_visible()
        box = dialog.get_by_label('当时保存的执行输入')
        expect(box).to_be_visible()
        assert normalize(box.evaluate('e => e.textContent')) == normalize(first_prompt), \
            'reloading after a flow patch must keep the first saved prompt'
        assert_snapshot_phases(dialog, first_names)
        assert all(NEW_PHASE not in text for text in snapshot_phase_texts(dialog)), \
            'patching the room flow must not rewrite the old run snapshot'

        # Second execution: rejecting with a note must change the saved input.
        stage = 'second-run'
        api(url, f'/api/tasks/{task_id}/reject', 'POST', {'note': NOTE})
        rejected = wait_for_status(url, room_id, task_id, {'changes_requested'})
        assert NOTE in (rejected.get('feedback') or ''), rejected.get('feedback')
        start_and_finish(url, room_id, task_id)
        second = latest_run(directory, task_id)
        second_prompt = saved_prompt(directory, second['id'])
        assert second['id'] != first['id'], 'the second execution must create a new run'
        assert second_prompt != first_prompt, 'each execution must save the prompt built at that time'
        assert NOTE in second_prompt, 'the rerun prompt must carry the review note'
        # The new run records the patched flow; the old run keeps its own snapshot.
        second_flow = api(url, f'/api/tasks/{task_id}/prompt?runId={second["id"]}')['flow']
        assert flow_phase_names(second_flow) == patched_names, second_flow
        assert NEW_PHASE in flow_phase_names(second_flow), second_flow
        stored_first = api(url, f'/api/tasks/{task_id}/prompt?runId={first["id"]}')['flow']
        assert flow_phase_names(stored_first) == first_names, stored_first
        assert NEW_PHASE not in flow_phase_names(stored_first), stored_first

        # Refresh the tab: both runs are listed, newest selected, newest text shown.
        stage = 'run-history'
        with page.expect_response(lambda response: response.request.method == 'GET'
                                  and urlsplit(response.url).path == prompt_path
                                  and not urlsplit(response.url).query, timeout=20000) as refreshed:
            dialog.get_by_role('button', name='刷新', exact=True).click()
        assert refreshed.value.status == 200
        assert prompt_requests[-1] == prompt_path, prompt_requests[-4:]
        picker = dialog.get_by_label('选择运行记录')
        expect(picker.locator('option')).to_have_count(2)
        expect(picker).to_have_value(second['id'])
        labels = picker.locator('option').all_inner_texts()
        assert labels[0].startswith('第 2 次 · ') and labels[1].startswith('第 1 次 · '), labels
        box = dialog.get_by_label('当时保存的执行输入')
        expect(box).to_be_visible()
        assert normalize(box.evaluate('e => e.textContent')) == normalize(second_prompt), \
            'refreshed tab must show the newest saved prompt'
        expect(dialog.locator('.input-meta')).to_contain_text('本次运行：已完成')
        assert_snapshot_phases(dialog, patched_names)
        assert any(NEW_PHASE in text for text in snapshot_phase_texts(dialog)), \
            'the newest run snapshot must include the patched phase'
        expect(dialog.locator('.flow-snapshot-links li')).to_have_count(len(patched_flow['edges']))

        # Switching to the older run must read exactly that run and its pre-patch snapshot.
        stage = 'older-run'
        with page.expect_response(lambda response: response.request.method == 'GET'
                                  and urlsplit(response.url).path == prompt_path
                                  and urlsplit(response.url).query == f'runId={first["id"]}',
                                  timeout=20000) as earlier:
            dialog.get_by_label('选择运行记录').select_option(first['id'])
        assert earlier.value.status == 200
        box = dialog.get_by_label('当时保存的执行输入')
        expect(box).to_be_visible()
        assert normalize(box.evaluate('e => e.textContent')) == normalize(first_prompt), \
            'older run must show its own saved prompt'
        assert f'{prompt_path}?runId={first["id"]}' in prompt_requests, prompt_requests
        expect(dialog.get_by_label('选择运行记录')).to_have_value(first['id'])
        assert_snapshot_phases(dialog, first_names)
        assert all(NEW_PHASE not in text for text in snapshot_phase_texts(dialog)), \
            'the older run must keep its pre-patch snapshot'

        # Switching back to the newest run restores the second prompt and patched snapshot.
        stage = 'newest-run'
        with page.expect_response(lambda response: response.request.method == 'GET'
                                  and urlsplit(response.url).path == prompt_path
                                  and urlsplit(response.url).query == f'runId={second["id"]}',
                                  timeout=20000) as newest:
            dialog.get_by_label('选择运行记录').select_option(second['id'])
        assert newest.value.status == 200
        box = dialog.get_by_label('当时保存的执行输入')
        expect(box).to_be_visible()
        assert normalize(box.evaluate('e => e.textContent')) == normalize(second_prompt), \
            'newest run must show the second saved prompt'
        assert f'{prompt_path}?runId={second["id"]}' in prompt_requests, prompt_requests
        assert_snapshot_phases(dialog, patched_names)
        assert any(NEW_PHASE in text for text in snapshot_phase_texts(dialog)), \
            'switching back must show the patched snapshot again'
        assert not errors, errors
    except Exception:
        diagnostic = {'backend': backend, 'stage': stage, 'pageErrors': errors[-6:],
                      'promptRequests': prompt_requests[-8:], 'recentApi': trace[-20:]}
        try:
            state = api(url, f'/api/rooms/{room_id}')
            diagnostic['tasks'] = [{'key': task.get('key'), 'status': task.get('status'),
                                    'summary': str(task.get('summary'))[:400],
                                    'feedback': str(task.get('feedback'))[:400]}
                                   for task in state['tasks']]
        except Exception as error:
            diagnostic['taskStateError'] = str(error)
        try:
            with closing(sqlite3.connect(directory / '.data' / 'devhub.db', timeout=10)) as database:
                diagnostic['runs'] = database.execute(
                    'SELECT id,status,exit_code,error,started_at FROM runs WHERE task_id=? '
                    'ORDER BY started_at DESC,rowid DESC LIMIT 5', (task_id,)).fetchall()
        except Exception as error:
            diagnostic['runsError'] = str(error)
        try:
            diagnostic['drawer'] = page.locator('#drawer-root').inner_text(timeout=2000)[:4000]
        except Exception as error:
            diagnostic['drawerError'] = str(error)
        emit(f'{backend}: saved-input diagnostics ' + json.dumps(diagnostic, ensure_ascii=False))
        raise
    finally:
        page.close()


def run_case(browser, backend, rust_exe):
    started_at = time.monotonic()
    with tempfile.TemporaryDirectory(prefix='devhub-inputs-real-') as temporary:
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
            visit_case(browser, backend, url, directory, repo)
    assert not directory.exists(), 'Fixture output must be removed after the server process tree exits'
    emit(f'{backend}: saved run inputs, per-run flow snapshots, run switching and prompt fidelity passed '
         f'({time.monotonic() - started_at:.1f}s)')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--backend', choices=('all', 'node', 'rust'), default='all')
    parser.add_argument('--rust-exe', type=Path, default=ROOT / 'rust' / 'target' / 'debug' / 'devhub.exe')
    args = parser.parse_args()
    if os.name != 'nt':
        parser.error('The test uses a Windows .cmd fixture for the current Node adapter.')
    with sync_playwright() as pw:
        browser = launch_test_browser(pw)
        try:
            for backend in (('node', 'rust') if args.backend == 'all' else (args.backend,)):
                run_case(browser, backend, args.rust_exe.resolve())
        finally:
            close_test_browser(browser)


if __name__ == '__main__':
    main()
