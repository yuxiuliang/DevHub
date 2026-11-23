import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const apiUrl = new URL('../server/api.js', import.meta.url).href;
const storeUrl = new URL('../server/store.js', import.meta.url).href;
const engineUrl = new URL('../server/engine.js', import.meta.url).href;

function isolated(t, body) {
  const directory = mkdtempSync(join(tmpdir(), 'devhub-settings-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = `
    import assert from 'node:assert/strict';
    import { Readable } from 'node:stream';
    import { handleApi } from ${JSON.stringify(apiUrl)};
    import * as E from ${JSON.stringify(engineUrl)};
    import { openStore, get, all, run, emit, bus } from ${JSON.stringify(storeUrl)};
    openStore();
    const ts = '2026-11-20T00:00:00.000Z';
    run('INSERT INTO rooms (id,name,requirement,repo_path,base_branch,flow_json,planner_id,reviewer_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      ['r_one','会话','当前需求','unused-fixture-repo','main','{"nodes":[],"edges":[]}', 'm_one','m_two',ts,ts]);
    run('INSERT INTO rooms (id,name,repo_path,created_at,updated_at) VALUES (?,?,?,?,?)', ['r_other','其他会话','unused',ts,ts]);
    for (const [id,roomId,name,sort] of [['m_one','r_one','成员一',0], ['m_two','r_one','成员二',1], ['m_foreign','r_other','其他成员',0]]) {
      run('INSERT INTO members (id,room_id,name,worker,sort) VALUES (?,?,?,?,?)', [id,roomId,name,'codex',sort]);
    }
    async function api(method, path, body) {
      const req = Readable.from(body === undefined ? [] : [typeof body === 'string' ? body : JSON.stringify(body)]);
      req.method = method;
      let status; let raw;
      const res = { writeHead(code) { status = code; }, end(value) { raw = value; } };
      const handled = await handleApi(req, res, new URL('http://127.0.0.1' + path));
      assert.equal(handled, true);
      return { status, body: JSON.parse(raw) };
    }
    const route = '/api/rooms/r_one/settings';
    const read = async () => (await api('GET',route)).body;
    const snapshot = () => ({ rooms: all('SELECT * FROM rooms ORDER BY id'), members: all('SELECT * FROM members ORDER BY id'), tasks: all('SELECT * FROM tasks ORDER BY id'), events: all('SELECT * FROM events ORDER BY id') });
    const newMember = (key, name) => ({ key, name, worker:'codex', role_name:'', role_brief:'', model:'', concurrency:1, enabled:true });
    await (${body.toString()})({ assert, api, route, read, snapshot, get, all, run, emit, bus, newMember, E });
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
    env: { ...process.env, DEVHUB_DATA: directory }, encoding: 'utf8', windowsHide: true, timeout: 20_000,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stdout + child.stderr);
}

test('settings GET returns canonical editable projection and reads archived rooms without writes', (t) => {
  isolated(t, async ({ assert, api, route, read, run, get }) => {
    const response = await api('GET', route);
    assert.equal(response.status, 200);
    const { body } = response;
    assert.equal(body.roomId, 'r_one');
    assert.equal(body.archived, false);
    assert.equal(body.version, JSON.stringify(body.settings));
    assert.deepEqual(Object.keys(body.settings), ['name','requirement','mode','autoApprove','plannerKey','reviewerKey','members']);
    assert.deepEqual(body.settings.members.map((m) => [m.key,m.id]), [['m_one','m_one'],['m_two','m_two']]);
    assert.deepEqual(Object.keys(body.settings.members[0]), ['key','id','name','worker','role_name','role_brief','model','concurrency','enabled']);
    assert.equal(body.settings.members[0].enabled, true);
    run("UPDATE rooms SET status='archived' WHERE id='r_one'");
    run('PRAGMA query_only=ON');
    const before = get('SELECT total_changes() n').n;
    const archived = await read();
    assert.equal(archived.archived, true);
    assert.equal(archived.version, body.version);
    assert.equal(get('SELECT total_changes() n').n, before);
  });
});

test('one PATCH atomically updates, adds, removes, orders and resolves a new planner key', (t) => {
  isolated(t, async ({ assert, api, route, read, run, all, get, newMember }) => {
    run("INSERT INTO tasks (id,room_id,key,title,owner_id,status,created_at,updated_at) VALUES ('t_history','r_one','T1','历史任务','m_one','done','old','old')");
    const current = await read();
    const saved = structuredClone(current);
    const added = newMember('draft:new', '新评审');
    saved.settings.name = '新会话名';
    saved.settings.requirement = '新需求';
    saved.settings.mode = 'serial';
    saved.settings.autoApprove = false;
    saved.settings.members = [added, { ...saved.settings.members[0], name:'成员一改名', role_brief:'专注验收\\n与测试', concurrency:3 }];
    saved.settings.plannerKey = added.key;
    saved.settings.reviewerKey = 'm_one';
    const result = await api('PATCH', route, saved);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const canonical = result.body;
    assert.equal(canonical.settings.members.length, 2);
    const first = canonical.settings.members[0];
    assert.ok(first.id.startsWith('m_'));
    assert.notEqual(first.id, added.key);
    assert.equal(first.key, first.id);
    assert.equal(canonical.settings.plannerKey, first.id);
    assert.equal(canonical.settings.reviewerKey, 'm_one');
    assert.equal(canonical.settings.members[1].concurrency, 3);
    assert.equal(canonical.settings.members[1].role_brief, '专注验收\\n与测试');
    assert.equal(get("SELECT id FROM members WHERE id='m_two'"), undefined);
    assert.equal(get("SELECT owner_id FROM tasks WHERE id='t_history'").owner_id, 'm_one');
    assert.equal(get("SELECT flow_json FROM rooms WHERE id='r_one'").flow_json, '{"nodes":[],"edges":[]}');
    assert.equal(all("SELECT * FROM events WHERE type='room.settings_updated'").length, 1);
    assert.equal(canonical.version, JSON.stringify(canonical.settings));
    assert.deepEqual(await read(), canonical);
  });
});

test('malformed complete settings are rejected with 400 and do not partially change rows', (t) => {
  isolated(t, async ({ assert, api, route, read, snapshot, newMember }) => {
    const current = await read();
    const before = snapshot();
    const changes = [
      (p) => { delete p.version; },
      (p) => { p.settings = null; },
      (p) => { p.settings.name = ' '; },
      (p) => { p.settings.requirement = 4; },
      (p) => { p.settings.mode = 'unlimited'; },
      (p) => { p.settings.autoApprove = 1; },
      (p) => { p.settings.members = []; },
      (p) => { p.settings.members[0].enabled = 1; },
      (p) => { p.settings.members[0].concurrency = 1.5; },
      (p) => { p.settings.members[0].concurrency = 11; },
      (p) => { p.settings.members[0].worker = '__proto__'; },
      (p) => { p.settings.members[0].model = 'bad\nmodel'; },
      (p) => { p.settings.members[0].role_brief = null; },
      (p) => { p.settings.members[1].name = p.settings.members[0].name; },
      (p) => { p.settings.members[1].key = p.settings.members[0].key; },
      (p) => { p.settings.members[0].key = 'modified'; },
      (p) => { p.settings.members[0].id = 'm_foreign'; p.settings.members[0].key = 'm_foreign'; },
      (p) => { delete p.settings.members[0].id; },
      (p) => { p.settings.members.push(newMember('m_foreign', '伪新增')); },
      (p) => { p.settings.plannerKey = 'missing'; },
      (p) => { p.settings.members[0].enabled = false; },
      (p) => { p.settings.members[1].enabled = false; },
    ];
    for (const change of changes) {
      const patch = structuredClone(current);
      change(patch);
      const result = await api('PATCH', route, patch);
      assert.equal(result.status, 400, JSON.stringify(result));
      assert.deepEqual(snapshot(), before);
    }
  });
});

test('stale, archived and missing settings give actionable statuses; task events do not stale a draft', (t) => {
  isolated(t, async ({ assert, api, route, read, run, emit }) => {
    const current = await read();
    emit('r_one', null, null, 'task.status', { status: 'ready' });
    run("UPDATE rooms SET updated_at='later', status='paused' WHERE id='r_one'");
    assert.equal((await read()).version, current.version);
    current.settings.name = '改名';
    assert.equal((await api('PATCH', route, current)).status, 200);
    assert.equal((await api('PATCH', route, current)).status, 409);
    const latest = await read();
    run("UPDATE rooms SET status='archived' WHERE id='r_one'");
    assert.equal((await api('PATCH', route, latest)).status, 409);
    assert.equal((await api('GET', '/api/rooms/missing/settings')).status, 404);
    assert.equal((await api('PATCH', '/api/rooms/missing/settings', latest)).status, 404);
  });
});

test('a member who owns even a completed task cannot be removed', (t) => {
  isolated(t, async ({ assert, api, route, read, run, snapshot }) => {
    run("INSERT INTO tasks (id,room_id,key,title,owner_id,status,created_at,updated_at) VALUES ('t_done','r_one','T1','已完成','m_two','merged','old','old')");
    const current = await read();
    current.settings.members.pop();
    current.settings.reviewerKey = 'm_one';
    const before = snapshot();
    const result = await api('PATCH', route, current);
    assert.equal(result.status, 400);
    assert.match(result.body.error, /不能删除/);
    assert.deepEqual(snapshot(), before);
  });
});

test('late SQL failure rolls back all members and room changes without emitting events', (t) => {
  isolated(t, async ({ assert, api, route, read, snapshot, run, bus, newMember }) => {
    const current = await read();
    current.settings.members = [newMember('added', '新增'), { ...current.settings.members[0], name:'已修改' }];
    current.settings.plannerKey = 'added';
    current.settings.reviewerKey = 'm_one';
    current.settings.name = '会失败的新名字';
    run("CREATE TRIGGER settings_fail BEFORE UPDATE OF name ON rooms BEGIN SELECT RAISE(ABORT,'late settings failure'); END");
    const before = snapshot();
    let emitted = 0;
    bus.on('event', () => { emitted++; });
    const result = await api('PATCH', route, current);
    assert.equal(result.status, 500);
    assert.match(result.body.error, /late settings failure/);
    assert.deepEqual(snapshot(), before);
    assert.equal(emitted, 0);
    assert.equal((await read()).version, current.version);
  });
});

test('flow writes require a CAS token and reject malformed nodes, edges and positions atomically', (t) => {
  isolated(t, async ({ assert, api, snapshot }) => {
    const route = '/api/rooms/r_one';
    const before = snapshot();
    const valid = { nodes: [{ id:'n1', type:'phase', x:40, y:90 }], edges: [] };
    const missingToken = await api('PATCH', route, { flow:valid, name:'不可写入' });
    assert.equal(missingToken.status, 400);
    assert.deepEqual(snapshot(), before);

    const malformed = [
      null,
      { nodes:{}, edges:[] },
      { nodes:[], edges:{} },
      { nodes:[{ id:'n1' },{ id:'n1' }], edges:[] },
      { nodes:[{ id:'n1' }], edges:[{ from:'n1', to:'missing' }] },
      { nodes:[{ id:'n1', x:null }], edges:[] },
      { nodes:[{ id:'n1', y:-1 }], edges:[] },
      { nodes:[{ id:'n1', outputs:'code_diff' }], edges:[] },
      { nodes:[{ id:'n1', outputs:[null] }], edges:[] },
    ];
    for (const flow of malformed) {
      const response = await api('PATCH', route, { flow, expectedFlow:{ nodes:[], edges:[] }, name:'不可写入' });
      assert.equal(response.status, 400, JSON.stringify(response));
      assert.deepEqual(snapshot(), before);
    }
  });
});

test('flow saves compare the parsed expected flow before changing unrelated room fields', (t) => {
  isolated(t, async ({ assert, api, run, get, snapshot }) => {
    const original = { nodes: [], edges: [] };
    const next = { nodes: [{ id:'n1', type:'phase', name:'实施' }], edges: [] };
    run("UPDATE rooms SET status='paused' WHERE id='r_one'");
    const success = await api('PATCH', '/api/rooms/r_one', { flow:next, expectedFlow:{ edges: [], nodes: [] } });
    assert.equal(success.status, 200);
    const repeated = await api('PATCH', '/api/rooms/r_one', { flow:next, expectedFlow:next });
    assert.equal(repeated.status, 200, 'the current matching content token allows an idempotent repeat');
    const before = snapshot();
    const stale = await api('PATCH', '/api/rooms/r_one', { flow:original, expectedFlow:original, name:'不应写入' });
    assert.equal(stale.status, 409);
    assert.deepEqual(snapshot(), before);
    assert.deepEqual(JSON.parse(get("SELECT flow_json FROM rooms WHERE id='r_one'").flow_json), next);
    assert.equal((await api('PATCH','/api/rooms/r_one',{ requirement:'正常局部编辑' })).status, 200);
    run("UPDATE rooms SET status='archived' WHERE id='r_one'");
    assert.equal((await api('PATCH','/api/rooms/r_one',{ flow:original,expectedFlow:next })).status,409);
  });
});

test('settings and flow writes reject all in-memory room operations before mutation', () => {
  const source = `
    import assert from 'node:assert/strict';
    import { readFileSync } from 'node:fs';
    import vm from 'node:vm';
    const flow = { nodes: [], edges: [] };
    const room = { id:'r_one',status:'draft',flow_json:JSON.stringify(flow) };
    let saves = 0; let writes = 0;
    const exports = {
      './store.js': { all:()=>[], get:()=>room, run:()=>{writes++;}, transaction:(f)=>f(), emit:()=>{}, now:()=>'',uid:()=>'',safeJson:JSON.parse,defaultFlow:()=>flow,starterFlow:()=>flow,roomPayload:(v)=>v,taskPayload:(v)=>v,memberPayload:(v)=>v,WORKTREES:'',bus:{} },
      './settings.js': { readSettings:()=>({roomId:'r_one'}),saveSettings:()=>{saves++;return {ok:true};} },
      './plan.js': { validatePlan:()=>{}, PlanValidationError:class extends Error {} },
      './git.js': {}, './adapters.js': {runWorker:()=>{}, killTree:()=>{},WORKER_DEFS:{}},
      './prompts.js': {buildPlanPrompt:()=>'',buildTaskPrompt:()=>'',buildReviewPrompt:()=>''},
    };
    const context = vm.createContext({console, setTimeout,clearTimeout});
    const text = readFileSync(new URL(${JSON.stringify(engineUrl)}),'utf8') + '\\nexport function testSet(kind,value){ for(const map of [running,taskOperations,liveRuns]) map.clear(); ({running,taskOperations,liveRuns})[kind].set("active",value); }';
    const engine = new vm.SourceTextModule(text,{context});
    await engine.link(async(specifier)=>{
      const values = specifier.startsWith('node:') ? await import(specifier) : exports[specifier];
      if(!values) throw new Error('Unexpected mock import '+specifier);
      const module = new vm.SyntheticModule(Object.keys(values),function(){for(const [name,value] of Object.entries(values))this.setExport(name,value);},{context});
      return module;
    });
    await engine.evaluate();
    const api = engine.namespace;
    assert.deepEqual(api.readSettings('r_one'),{roomId:'r_one'});
    for(const kind of ['running','taskOperations','liveRuns']) {
      const before = saves;
      api.testSet(kind,{roomId:'r_one'});
      assert.throws(()=>api.saveSettings('r_one',{}),(error)=>error.statusCode===409);
      assert.throws(()=>api.updateRoom('r_one',{flow,expectedFlow:flow}),(error)=>error.statusCode===409);
      assert.equal(saves,before); assert.equal(writes,0);
      api.testSet(kind,{roomId:'r_other'});
      api.saveSettings('r_one',{});
    }
    assert.equal(saves,3);
  `;
  const child = spawnSync(process.execPath, ['--experimental-vm-modules','--input-type=module','--eval',source], {encoding:'utf8',windowsHide:true,timeout:15_000});
  assert.ifError(child.error);
  assert.equal(child.status,0,child.stdout+child.stderr);
});
