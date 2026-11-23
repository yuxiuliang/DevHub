"""Real-backend gate tri-state browser regression for DevHub (Node + Rust).

Each backend gets a fresh temporary Git repo, a mock ``codex`` CLI and an isolated
DevHub data directory. A room is created from the ``generic`` flow template and a
plan is applied through ``POST /api/rooms/{id}/plan/apply`` with every task naming
its phase explicitly, so the tasks bind to phases whose ``gate`` differs:

* ``执行`` (auto)   - the run lands directly in ``approved``; the drawer can merge.
* ``需求澄清`` (human) - the run lands in ``review``; 「通过」 approves it, then merge.
* ``评审`` (agent, maxLoop 2) - review returns ``request_changes`` twice; the second
  rejection escalates the task into the overview inbox; 「人工通过」 then merges.

The mock CLI reads its review verdict from ``DEVHUB_TEST_GATE_MODE`` (a file the test
rewrites), so no model service is ever called. The test also counts the POSTs the
page issues for each action and checks they happen exactly once.
"""

import json
import shutil
import sys
import tempfile
import time
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from playwright.sync_api import expect

from browser_flow import ROOT, check_git, make_fixture, serve_fixture

MEMBER = '执行者'
AUTO_TITLE = '自动门禁任务'
HUMAN_TITLE = '人工门禁任务'
AGENT_TITLE = '评审门禁任务'
RUN_TIMEOUT = 120
STATUS_TEXT = {
    'ready': '就绪',
    'running': '运行中',
    'review': '待评审',
    'approved': '已通过',
    'changes_requested': '待修改',
    'escalated': '已升级',
    'merged': '已合并',
    'done': '已完成',
    'failed': '失败',
}
AUTO_HINT = '自动通过：这次有产出就算通过，不用评审，可以直接合并。'
HUMAN_HINT = '人工确认：等你看完改动后点「通过」，再决定是否合并。'
AGENT_HINT = '评审通过：由评审者检查改动后给出结论，不通过会打回给执行者。'

# A codex stand-in: execution writes a per-task file (the server commits it), review
# only prints JSON. The verdict is controlled by a file so one server process can
# serve the approve and request_changes phases of the scenario.
GATE_FIXTURE = r"""
const fs = require('node:fs');
const text = process.argv.find((arg) => arg.startsWith('Read the task file at '));
const match = /^Read the task file at (.+) and carry it out exactly\./.exec(text || '');
if (!match) throw new Error('Missing prompt file argument');
const prompt = fs.readFileSync(match[1], 'utf8');
const emit = (message) => {
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'gate-fixture' }));
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: message } }));
};
if (prompt.startsWith('# 任务：评审一个改动')) {
  const modeFile = process.env.DEVHUB_TEST_GATE_MODE || '';
  const mode = modeFile && fs.existsSync(modeFile) ? fs.readFileSync(modeFile, 'utf8').trim() : 'approve';
  emit(mode === 'request_changes'
    ? JSON.stringify({ verdict: 'request_changes', blocking: [{ file: 'README.md', line: 1, issue: '模拟阻塞问题', suggestion: '请补充说明后重试' }], notes: '模拟评审要求修改' })
    : JSON.stringify({ verdict: 'approve', blocking: [], notes: '模拟评审通过' }));
} else {
  const key = /- 编号：(T\d+)/.exec(prompt);
  const title = /^# 任务：(.+)$/m.exec(prompt);
  fs.writeFileSync(`gate-${key ? key[1] : 'task'}.txt`, `${title ? title[1] : '任务'} 的模拟产出\n`);
  emit('模拟执行完成');
}
"""


def api(url, path, method='GET', body=None, timeout=30):
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode('utf-8')
    request = Request(url + path, data=data, method=method, headers={'Content-Type': 'application/json'})
    try:
        with urlopen(request, timeout=timeout) as response:
            return json.load(response)
    except HTTPError as error:
        detail = error.read().decode('utf-8', 'replace')[:800]
        raise AssertionError(f'{method} {path} -> HTTP {error.code}: {detail}') from None


def emit(line):
    """Write one UTF-8 line so Chinese diagnostics stay readable in captured output."""
    buffer = getattr(sys.stdout, 'buffer', None)
    if buffer is None:
        print(line, flush=True)
        return
    sys.stdout.flush()
    buffer.write((line + '\n').encode('utf-8', 'replace'))
    buffer.flush()


def task_state(url, room_id, task_id):
    return next(task for task in api(url, f'/api/rooms/{room_id}')['tasks'] if task['id'] == task_id)


def wait_for_status(url, room_id, task_id, wanted, timeout=RUN_TIMEOUT):
    deadline = time.monotonic() + timeout
    task = None
    while time.monotonic() < deadline:
        task = task_state(url, room_id, task_id)
        if task['status'] in wanted:
            return task
        time.sleep(0.2)
    raise AssertionError(f'task {task_id} did not reach {sorted(wanted)} in {timeout}s; '
                         f'last status={task and task["status"]!r}')


def expect_status(dialog, status, timeout=20000):
    expect(dialog.locator('.d-sub')).to_contain_text(STATUS_TEXT[status], timeout=timeout)


def open_task(page, task_id, title):
    card = page.locator(f'.card[data-id="{task_id}"]')
    expect(card).to_be_visible()
    card.click()
    dialog = page.get_by_role('dialog', name=title, exact=True)
    expect(dialog).to_be_visible()
    return dialog


def close_task(page, title):
    dialog = page.get_by_role('dialog', name=title, exact=True)
    dialog.get_by_role('button', name='关闭任务详情', exact=True).click()
    expect(dialog).to_have_count(0)


def open_diff(page, dialog, task_id, timeout=30):
    with page.expect_response(lambda response: response.request.method == 'GET'
                              and urlsplit(response.url).path == f'/api/tasks/{task_id}/diff',
                              timeout=timeout * 1000) as loaded:
        dialog.get_by_role('button', name='改动', exact=True).click()
    response = loaded.value
    assert response.status == 200, response.text()[:1500]
    payload = response.json()
    assert isinstance(payload.get('diff'), str) and payload.get('diff'), payload
    return payload


def click_action(page, dialog, label, path, timeout=RUN_TIMEOUT):
    with page.expect_response(lambda response: response.request.method == 'POST'
                              and urlsplit(response.url).path == path,
                              timeout=timeout * 1000) as caught:
        dialog.get_by_role('button', name=label, exact=True).click()
    response = caught.value
    if response.status != 200:
        raise AssertionError(f'{label} -> HTTP {response.status}: {response.text()[:1500]}')
    return response


def create_room_and_plan(url, repo):
    created = api(url, '/api/rooms', 'POST', {
        'name': '门禁三态验收', 'repoPath': str(repo), 'requirement': '验证门禁三态驱动执行',
        'mode': 'serial', 'autoApprove': False, 'flowTemplate': 'generic',
        'members': [{'name': MEMBER, 'worker': 'codex', 'roleName': '执行者'}],
        'plannerName': MEMBER, 'reviewerName': MEMBER,
    })
    room_id = created['room']['id']
    assert len(created['members']) == 1, created['members']
    plan = {
        'summary': '按阶段门禁分别验证自动、人工与评审三条路径',
        'tasks': [
            {'title': AUTO_TITLE, 'spec': '写一个门禁验收文件。', 'type': 'code', 'owner': MEMBER,
             'phase': '执行', 'acceptance': ['生成 gate-T1.txt'], 'dependsOn': []},
            {'title': HUMAN_TITLE, 'spec': '写一个门禁验收文件。', 'type': 'code', 'owner': MEMBER,
             'phase': '需求澄清', 'acceptance': ['生成 gate-T2.txt'], 'dependsOn': []},
            {'title': AGENT_TITLE, 'spec': '写一个门禁验收文件。', 'type': 'code', 'owner': MEMBER,
             'phase': '评审', 'acceptance': ['生成 gate-T3.txt'], 'dependsOn': []},
        ],
        'decisions': [],
        'risks': [],
    }
    state = api(url, f'/api/rooms/{room_id}/plan/apply', 'POST', {'plan': plan})
    phases = {node['name']: node['id'] for node in state['room']['flow']['nodes']
              if node.get('type') == 'phase'}
    tasks = {task['title']: task for task in state['tasks']}
    assert len(tasks) == 3, state['tasks']
    # Every task must be bound to the phase named in the plan, not guessed by order.
    assert tasks[AUTO_TITLE]['phase_id'] == phases['执行'], tasks[AUTO_TITLE]
    assert tasks[HUMAN_TITLE]['phase_id'] == phases['需求澄清'], tasks[HUMAN_TITLE]
    assert tasks[AGENT_TITLE]['phase_id'] == phases['评审'], tasks[AGENT_TITLE]
    assert all(task['status'] == 'ready' for task in tasks.values()), tasks
    return room_id, {title: task['id'] for title, task in tasks.items()}


def visit_case(browser, backend, url, directory, repo, env):
    room_id, ids = create_room_and_plan(url, repo)
    auto_id, human_id, agent_id = ids[AUTO_TITLE], ids[HUMAN_TITLE], ids[AGENT_TITLE]
    page = browser.new_page(viewport={'width': 1280, 'height': 800})
    page.set_default_timeout(15000)
    errors, posts, trace = [], [], []
    trace_started = time.monotonic()
    stage = 'open-room'

    def record_request(request):
        parts = urlsplit(request.url)
        if not parts.path.startswith('/api/'):
            return
        trace.append((round(time.monotonic() - trace_started, 3), 'request', request.method, parts.path))
        if request.method == 'POST':
            posts.append(parts.path)

    def record_response(response):
        parts = urlsplit(response.url)
        if parts.path.startswith('/api/'):
            trace.append((round(time.monotonic() - trace_started, 3), 'response', response.status, parts.path))

    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('dialog', lambda dialog: dialog.accept())
    page.on('request', record_request)
    page.on('response', record_response)
    page.on('requestfailed', lambda request: trace.append(
        (round(time.monotonic() - trace_started, 3), 'requestfailed', request.method, urlsplit(request.url).path)))
    try:
        page.goto(url, wait_until='domcontentloaded')
        page.locator(f'[data-act="open-room"][data-id="{room_id}"]').first.click()
        expect(page.locator('.board')).to_be_visible()

        # --- auto gate: the run itself approves the result, then merge -------------
        stage = 'auto-run'
        dialog = open_task(page, auto_id, AUTO_TITLE)
        expect(dialog.get_by_text(AUTO_HINT, exact=True)).to_be_visible()
        expect(dialog.get_by_text('阶段：执行 · 最多打回 2 次', exact=True)).to_be_visible()
        click_action(page, dialog, '运行任务', f'/api/tasks/{auto_id}/run')
        expect_status(dialog, 'approved')
        assert task_state(url, room_id, auto_id)['status'] == 'approved'
        stage = 'auto-merge'
        open_diff(page, dialog, auto_id)
        expect(dialog.locator('.diff-box')).to_contain_text('gate-T1.txt')
        expect(dialog.get_by_role('button', name='自动检查', exact=True)).to_have_count(0)
        expect(dialog.get_by_role('button', name='人工通过', exact=True)).to_have_count(0)
        expect(dialog.get_by_role('button', name='合并到项目', exact=True)).to_be_visible()
        click_action(page, dialog, '合并到项目', f'/api/tasks/{auto_id}/merge')
        expect_status(dialog, 'merged')
        expect(dialog.get_by_text('改动已合并到项目', exact=True)).to_be_visible()
        assert task_state(url, room_id, auto_id)['status'] == 'merged'
        close_task(page, AUTO_TITLE)

        # --- human gate: review -> 「通过」 -> approved -> merge -------------------
        stage = 'human-run'
        dialog = open_task(page, human_id, HUMAN_TITLE)
        expect(dialog.get_by_text(HUMAN_HINT, exact=True)).to_be_visible()
        expect(dialog.get_by_text('阶段：需求澄清 · 最多打回 2 次', exact=True)).to_be_visible()
        click_action(page, dialog, '运行任务', f'/api/tasks/{human_id}/run')
        expect_status(dialog, 'review')
        assert task_state(url, room_id, human_id)['status'] == 'review'
        stage = 'human-approve'
        open_diff(page, dialog, human_id)
        expect(dialog.locator('.diff-box')).to_contain_text('gate-T2.txt')
        approve = dialog.get_by_role('button', name='通过', exact=True)
        expect(approve).to_be_visible()
        assert 'primary' in (approve.get_attribute('class') or '').split(), approve.get_attribute('class')
        expect(dialog.get_by_role('button', name='自动检查', exact=True)).to_have_count(0)
        merge = dialog.get_by_role('button', name='合并到项目', exact=True)
        expect(merge).to_be_visible()
        assert 'primary' not in (merge.get_attribute('class') or '').split(), merge.get_attribute('class')
        click_action(page, dialog, '通过', f'/api/tasks/{human_id}/approve')
        expect_status(dialog, 'approved')
        expect(dialog.get_by_role('button', name='通过', exact=True)).to_have_count(0)
        expect(dialog.get_by_role('button', name='合并到项目', exact=True)).to_be_visible()
        assert task_state(url, room_id, human_id)['status'] == 'approved'
        stage = 'human-merge'
        click_action(page, dialog, '合并到项目', f'/api/tasks/{human_id}/merge')
        expect_status(dialog, 'merged')
        assert task_state(url, room_id, human_id)['status'] == 'merged'
        close_task(page, HUMAN_TITLE)

        # --- agent gate: review -> changes_requested -> rerun -> escalated ---------
        stage = 'agent-run'
        dialog = open_task(page, agent_id, AGENT_TITLE)
        expect(dialog.get_by_text(AGENT_HINT, exact=True)).to_be_visible()
        expect(dialog.get_by_text('阶段：评审 · 最多打回 2 次', exact=True)).to_be_visible()
        click_action(page, dialog, '运行任务', f'/api/tasks/{agent_id}/run')
        expect_status(dialog, 'review')
        assert task_state(url, room_id, agent_id)['status'] == 'review'
        stage = 'agent-review-1'
        open_diff(page, dialog, agent_id)
        expect(dialog.locator('.diff-box')).to_contain_text('gate-T3.txt')
        expect(dialog.get_by_role('button', name='自动检查', exact=True)).to_be_visible()
        manual = dialog.get_by_role('button', name='人工通过', exact=True)
        expect(manual).to_be_visible()
        assert 'primary' not in (manual.get_attribute('class') or '').split(), manual.get_attribute('class')
        merge = dialog.get_by_role('button', name='合并到项目', exact=True)
        assert 'primary' in (merge.get_attribute('class') or '').split(), merge.get_attribute('class')
        expect(dialog.get_by_role('button', name='通过', exact=True)).to_have_count(0)
        click_action(page, dialog, '自动检查', f'/api/tasks/{agent_id}/review')
        expect_status(dialog, 'changes_requested')
        rejected = task_state(url, room_id, agent_id)
        assert rejected['status'] == 'changes_requested', rejected
        assert rejected['reject_count'] == 1, rejected
        assert '第 1 轮评审' in (rejected.get('feedback') or ''), rejected.get('feedback')

        stage = 'agent-rerun'
        click_action(page, dialog, '按意见重跑', f'/api/tasks/{agent_id}/run')
        expect_status(dialog, 'review')
        assert task_state(url, room_id, agent_id)['status'] == 'review'
        stage = 'agent-review-2'
        open_diff(page, dialog, agent_id)
        expect(dialog.get_by_role('button', name='自动检查', exact=True)).to_be_visible()
        click_action(page, dialog, '自动检查', f'/api/tasks/{agent_id}/review')
        expect_status(dialog, 'escalated')
        escalated = task_state(url, room_id, agent_id)
        assert escalated['status'] == 'escalated', escalated
        assert escalated['reject_count'] == 2, escalated

        # The escalation must reach the overview inbox, not just the task drawer.
        stage = 'agent-inbox'
        inbox = [item for item in api(url, '/api/state')['inbox'] if item.get('taskId') == agent_id]
        assert any(item['status'] == 'escalated' and item['kind'] == 'problem' for item in inbox), inbox
        stage = 'agent-escalated-drawer'
        dialog.get_by_role('button', name='概览', exact=True).click()
        expect(dialog.get_by_role('heading', name='已到打回上限', exact=True)).to_be_visible()
        expect(dialog.get_by_text('这个任务已经打回 2 次，达到本阶段上限（2 次），系统不会继续自动检查。'
                                  '请按意见重跑、人工通过，或取消任务。', exact=True)).to_be_visible()
        expect(dialog.get_by_text('已经打回 2 次，达到本阶段上限（2 次）。可以按意见重跑、人工通过，或取消任务。',
                                  exact=True)).to_be_visible()
        expect(dialog.get_by_role('button', name='按意见重跑', exact=True)).to_be_visible()
        expect(dialog.get_by_role('button', name='取消任务', exact=True)).to_be_visible()
        stage = 'agent-approve'
        open_diff(page, dialog, agent_id)
        expect(dialog.get_by_role('button', name='自动检查', exact=True)).to_have_count(0)
        expect(dialog.get_by_role('button', name='人工通过', exact=True)).to_be_visible()
        expect(dialog.get_by_role('button', name='退回修改', exact=True)).to_be_visible()
        expect(dialog.get_by_role('button', name='合并到项目', exact=True)).to_be_visible()
        click_action(page, dialog, '人工通过', f'/api/tasks/{agent_id}/approve')
        expect_status(dialog, 'approved')
        assert task_state(url, room_id, agent_id)['status'] == 'approved'
        stage = 'agent-merge'
        click_action(page, dialog, '合并到项目', f'/api/tasks/{agent_id}/merge')
        expect_status(dialog, 'merged')
        assert task_state(url, room_id, agent_id)['status'] == 'merged'
        close_task(page, AGENT_TITLE)

        # --- exactly-once API calls and final state --------------------------------
        stage = 'counts'
        def count(suffix):
            return sum(path.endswith(suffix) for path in posts)

        assert count(f'/api/tasks/{auto_id}/run') == 1, posts
        assert count(f'/api/tasks/{human_id}/run') == 1, posts
        assert count(f'/api/tasks/{agent_id}/run') == 2, posts
        assert count(f'/api/tasks/{agent_id}/review') == 2, posts
        assert count(f'/api/tasks/{human_id}/approve') == 1, posts
        assert count(f'/api/tasks/{agent_id}/approve') == 1, posts
        for task_id in (auto_id, human_id, agent_id):
            assert count(f'/api/tasks/{task_id}/merge') == 1, posts
        assert count('/reject') == 0, posts
        statuses = {task['title']: task['status'] for task in api(url, f'/api/rooms/{room_id}')['tasks']}
        assert statuses == {AUTO_TITLE: 'merged', HUMAN_TITLE: 'merged', AGENT_TITLE: 'merged'}, statuses
        files = check_git(repo, env, 'ls-tree', '--name-only', 'HEAD').splitlines()
        for name in ('gate-T1.txt', 'gate-T2.txt', 'gate-T3.txt'):
            assert name in files, files
        assert not errors, errors
    except Exception:
        diagnostic = {'backend': backend, 'stage': stage, 'pageErrors': errors[-6:],
                      'recentApi': trace[-24:], 'posts': posts[-24:]}
        try:
            state = api(url, f'/api/rooms/{room_id}')
            diagnostic['tasks'] = [{'key': task.get('key'), 'title': task.get('title'),
                                    'status': task.get('status'), 'phaseId': task.get('phase_id'),
                                    'rejectCount': task.get('reject_count'),
                                    'summary': str(task.get('summary'))[:300],
                                    'feedback': str(task.get('feedback'))[:300]}
                                   for task in state['tasks']]
        except Exception as error:
            diagnostic['taskStateError'] = str(error)
        try:
            diagnostic['inbox'] = api(url, '/api/state').get('inbox')
        except Exception as error:
            diagnostic['inboxError'] = str(error)
        try:
            diagnostic['drawer'] = page.locator('#drawer-root').inner_text(timeout=2000)[:6000]
        except Exception as error:
            diagnostic['drawerError'] = str(error)
        try:
            diagnostic['serverOutput'] = (directory / 'server-output.txt').read_text(
                encoding='utf-8', errors='replace')[-3000:]
        except Exception as error:
            diagnostic['serverOutputError'] = str(error)
        emit(f'{backend}: gate diagnostics ' + json.dumps(diagnostic, ensure_ascii=False))
        raise
    finally:
        page.close()


def run_case(browser, backend, rust_exe):
    started_at = time.monotonic()
    with tempfile.TemporaryDirectory(prefix='devhub-gate-real-') as temporary:
        directory = Path(temporary)
        repo, env, node = make_fixture(directory)
        # make_fixture provisions the repo, PATH and env; swap in the gate-aware CLI.
        (directory / 'fixture.cjs').write_text(GATE_FIXTURE, encoding='utf-8')
        env['DEVHUB_TEST_GATE_MODE'] = str(directory / 'gate-mode.txt')
        (directory / 'gate-mode.txt').write_text('request_changes', encoding='ascii')
        if backend == 'node':
            shutil.copytree(ROOT / 'server', directory / 'server')
            shutil.copytree(ROOT / 'web', directory / 'web')
            shutil.copy(ROOT / 'package.json', directory / 'package.json')
            command = [str(node), 'server/index.js']
        else:
            command = [str(rust_exe), '--data', str(directory / '.data')]
        with serve_fixture(command, directory, env, backend) as url:
            visit_case(browser, backend, url, directory, repo, env)
    assert not directory.exists(), 'Fixture output must be removed after the server process tree exits'
    emit(f'{backend}: auto/human/agent gate paths, escalation inbox, exactly-once actions and merge passed '
         f'({time.monotonic() - started_at:.1f}s)')
