import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const apiUrl = new URL('../server/api.js', import.meta.url).href;
const storeUrl = new URL('../server/store.js', import.meta.url).href;

// `beforeOpen` runs before openStore() so a test can pre-create a legacy database;
// `directory` reuses an existing data directory (for restart/migration tests).
function isolated(t, source, { beforeOpen = '', directory } = {}) {
  const dir = directory || mkdtempSync(join(tmpdir(), 'devhub-input-records-'));
  if (!directory) t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = `
    import assert from 'node:assert/strict';
    import { Readable } from 'node:stream';
    import { writeFileSync, readFileSync, mkdirSync, existsSync, symlinkSync, statSync } from 'node:fs';
    import { DatabaseSync } from 'node:sqlite';
    import { join } from 'node:path';
    import { openStore, all, get, run, bus, PROMPTS, DATA } from ${JSON.stringify(storeUrl)};
    import { handleApi } from ${JSON.stringify(apiUrl)};
    ${beforeOpen}
    openStore();
    for(const id of ['r1','r2']) run("INSERT OR IGNORE INTO rooms (id,name,repo_path,requirement,status,created_at,updated_at) VALUES (?,?,'unused','current requirement','paused','now','now')",[id,id]);
    run("INSERT OR IGNORE INTO members (id,room_id,name,worker) VALUES ('m1','r1','Current member','codex')");
    for(const [id,room] of [['t1','r1'],['t2','r2']]) run("INSERT OR IGNORE INTO tasks (id,room_id,key,title,spec,status,created_at,updated_at) VALUES (?,?,'T1','Current title','current specification','done','now','now')",[id,room]);
    function seed(id,{task='t1',status='completed',at='2026-11-22T00:00:00Z',code=0,error='original worker error',flow=''}={}) {
      run('INSERT INTO runs (id,task_id,member_id,status,exit_code,error,started_at,ended_at,flow_json) VALUES (?,?,?, ?,?,?,?,?,?)',[id,task,'m1',status,code,error,at,status==='running'?null:'2026-11-22T00:01:00Z',flow]);
    }
    const file = id => join(PROMPTS,id+'.md');
    async function request(task='t1',runId) {
      const req=Readable.from([]); req.method='GET';
      let status,raw,headers;
      const res={writeHead(code,value){status=code;headers=value;},end(value){raw=value;}};
      const url=new URL('http://127.0.0.1/api/tasks/'+encodeURIComponent(task)+'/prompt');
      if(runId!==undefined) url.searchParams.set('runId',runId);
      assert.equal(await handleApi(req,res,url),true);
      return {status,headers,body:JSON.parse(raw)};
    }
    const notices=[];
    bus.on('event',event=>notices.push(event));
    const snapshot=()=>JSON.stringify(['rooms','members','tasks','runs','decisions','events'].map(table=>all('SELECT * FROM '+table+' ORDER BY rowid')));
    async function unchanged(task='t1',runId) {
      const before=snapshot(),sent=notices.length;
      const response=await request(task,runId);
      assert.equal(snapshot(),before,'reading saved input must not change database state');
      assert.equal(notices.length,sent,'reading saved input must not publish events');
      return response;
    }
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script + source], {
    env: { ...process.env, DEVHUB_DATA: dir }, encoding: 'utf8', windowsHide: true, timeout: 20_000,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stdout + child.stderr);
  return child.stdout;
}

test('saved input exposes exact empty defaults and distinguishes an unknown task', (t) => {
  isolated(t, `
    const response=await unchanged();
    assert.equal(response.status,200);
    assert.deepEqual(response.body,{
      prompt:'',runId:null,status:'',exitCode:null,startedAt:null,endedAt:null,available:false,
      truncated:false,totalBytes:0,readError:'',flow:null,runs:[],runsTruncated:false,
    });
    assert.equal(response.headers['Cache-Control'],'no-store');
    assert.equal((await unchanged('missing')).status,404);
    assert.equal((await unchanged('t1','absent')).status,404);
    assert.equal((await unchanged('t1','')).status,404);
  `);
});

test('latest and selected historical input come from saved files rather than current settings', (t) => {
  isolated(t, `
    seed('run-old',{at:'2026-11-21T00:00:00Z'});
    seed('run-new',{status:'failed',code:7});
    const old='旧需求\\r\\n旧角色\\r\\n旧决策\\r\\n<script>untrusted()</script>\\r\\n';
    const latest='实际第二次输入\\r\\n';
    writeFileSync(file('run-old'),old); writeFileSync(file('run-new'),latest);
    run("UPDATE rooms SET requirement='changed now' WHERE id='r1'");
    run("UPDATE members SET name='Changed now',role_brief='changed now' WHERE id='m1'");
    run("INSERT INTO decisions (id,room_id,text,status,created_at) VALUES ('d','r1','new decision','active','now')");
    const response=await unchanged(); assert.equal(response.status,200);
    assert.equal(response.body.runId,'run-new'); assert.equal(response.body.prompt,latest);
    assert.equal(response.body.status,'failed'); assert.equal(response.body.exitCode,7);
    assert.deepEqual(response.body.runs.map(run=>run.runId),['run-new','run-old']);
    const selected=await unchanged('t1','run-old');
    assert.equal(selected.body.prompt,old); assert.equal(selected.body.runId,'run-old');
    assert.equal(selected.body.totalBytes,Buffer.byteLength(old));
    assert.equal(selected.body.available,true); assert.equal(selected.body.truncated,false);
    assert.equal(readFileSync(file('run-old'),'utf8'),old);
    assert.equal(get("SELECT error FROM runs WHERE id='run-new'").error,'original worker error');
  `);
});

test('flow snapshot is returned only when the selected run stored a JSON object', (t) => {
  isolated(t, `
    const valid=JSON.stringify({id:'flow-saved',name:'当时流程',nodes:[{id:'n1',type:'phase',gate:'auto',outputs:['code_diff']}],edges:[]});
    seed('valid',{flow:valid});
    seed('empty',{flow:''});
    seed('broken',{flow:'{bad'});
    seed('array',{flow:'[]'});
    seed('null',{flow:'null'});
    seed('scalar',{flow:'"just text"'});
    for(const [id,expected] of [['valid',JSON.parse(valid)],['empty',null],['broken',null],['array',null],['null',null],['scalar',null]]) {
      const response=await unchanged('t1',id);
      assert.equal(response.status,200);
      assert.deepEqual(response.body.flow,expected);
      assert.equal(response.body.runId,id);
      assert.equal(response.body.status,'completed');
      assert.equal(response.body.exitCode,0);
      assert.equal(response.body.startedAt,'2026-11-22T00:00:00Z');
      assert.equal(response.body.endedAt,'2026-11-22T00:01:00Z');
      assert.equal(response.body.prompt,''); assert.equal(response.body.available,false);
      assert.deepEqual(response.body.runs.map(run=>run.runId),['scalar','null','array','broken','empty','valid']);
      assert.ok(!('flow_json' in response.body.runs[0]),'run history must not leak raw flow_json');
    }
    assert.equal(get("SELECT flow_json FROM runs WHERE id='broken'").flow_json,'{bad');
  `);
});

test('each run keeps its own flow snapshot and later room edits never rewrite history', (t) => {
  isolated(t, `
    const first=JSON.stringify({id:'flow-first',name:'第一次',nodes:[{id:'n1',type:'phase'}],edges:[]});
    const second=JSON.stringify({id:'flow-second',name:'第二次',nodes:[{id:'n2',type:'phase'}],edges:[{from:'n1',to:'n2'}]});
    seed('run-first',{at:'2026-11-21T00:00:00Z',flow:first});
    seed('run-second',{flow:second});
    run("UPDATE rooms SET flow_json=? WHERE id='r1'",[JSON.stringify({id:'flow-edited-after-run'})]);
    const latest=await unchanged();
    assert.equal(latest.status,200); assert.equal(latest.body.runId,'run-second');
    assert.deepEqual(latest.body.flow,JSON.parse(second));
    const selected=await unchanged('t1','run-first');
    assert.equal(selected.status,200); assert.equal(selected.body.runId,'run-first');
    assert.deepEqual(selected.body.flow,JSON.parse(first));
    assert.notDeepEqual(latest.body.flow,selected.body.flow);
    assert.equal(get("SELECT flow_json FROM runs WHERE id='run-first'").flow_json,first);
    assert.equal(get("SELECT flow_json FROM runs WHERE id='run-second'").flow_json,second);
    assert.equal(get("SELECT flow_json FROM rooms WHERE id='r1'").flow_json,JSON.stringify({id:'flow-edited-after-run'}));
  `);
});

test('input history is task-scoped, remains readable when archived, and cannot select another room', (t) => {
  isolated(t, `
    seed('own'); seed('foreign',{task:'t2'});
    writeFileSync(file('own'),'own input'); writeFileSync(file('foreign'),'other room secret');
    assert.equal((await unchanged('t1','foreign')).status,404);
    assert.equal((await unchanged('missing','foreign')).status,404);
    assert.equal((await unchanged('t2','own')).status,404);
    run("UPDATE rooms SET status='archived' WHERE id='r1'");
    const response=await unchanged();
    assert.equal(response.status,200); assert.equal(response.body.prompt,'own input');
    assert.deepEqual(response.body.runs.map(run=>run.runId),['own']);
  `);
});

test('missing latest input never falls back to a previous run or a reconstructed draft', (t) => {
  isolated(t, `
    seed('older',{at:'2026-11-21T00:00:00Z'}); seed('preparation-failed',{status:'failed',code:null});
    writeFileSync(file('older'),'old saved input');
    const response=await unchanged();
    assert.equal(response.status,200); assert.equal(response.body.runId,'preparation-failed');
    assert.equal(response.body.available,false); assert.equal(response.body.prompt,'');
    assert.equal(response.body.readError,''); assert.equal(response.body.status,'failed');
    assert.equal(existsSync(file('preparation-failed')),false);
    const selected=await unchanged('t1','older'); assert.equal(selected.body.prompt,'old saved input');
    writeFileSync(file('preparation-failed'),'');
    const empty=await unchanged();
    assert.equal(empty.body.available,true); assert.equal(empty.body.prompt,'');
    assert.equal(empty.body.totalBytes,0); assert.equal(empty.body.readError,'');
  `);
});

test('small Unicode, BOM, CRLF and blank lines are returned unchanged under query-only access', (t) => {
  isolated(t, `
    seed('unicode',{status:'interrupted',code:null});
    const text='\\uFEFF# 当时的输入\\r\\n\\r\\n中文💥é\\r\\n';
    writeFileSync(file('unicode'),text);
    const modified=statSync(file('unicode')).mtimeMs;
    run('PRAGMA query_only=ON');
    const response=await unchanged();
    assert.equal(response.status,200); assert.equal(response.body.prompt,text);
    assert.equal(response.body.available,true); assert.equal(response.body.truncated,false);
    assert.equal(response.body.totalBytes,Buffer.byteLength(text));
    assert.equal(statSync(file('unicode')).mtimeMs,modified);
    assert.equal(response.body.status,'interrupted');
  `);
});

test('large inputs use a bounded head and never split a Unicode character or return the tail', (t) => {
  isolated(t, `
    seed('large');
    const limit=262144;
    for(const [text,expected] of [
      ['x'.repeat(limit-1)+'💥TAIL','x'.repeat(limit-1)],
      ['x'.repeat(limit-3)+'错TAIL','x'.repeat(limit-3)+'错'],
      ['x'.repeat(2*1024*1024)+'TAIL_MARK','x'.repeat(limit)],
    ]) {
      writeFileSync(file('large'),text);
      const response=await unchanged();
      assert.equal(response.status,200); assert.equal(response.body.prompt,expected);
      assert.equal(response.body.available,true); assert.equal(response.body.truncated,true);
      assert.equal(response.body.totalBytes,Buffer.byteLength(text));
      assert.ok(Buffer.byteLength(response.body.prompt)<=limit);
      assert.ok(!response.body.prompt.includes('TAIL'));
      assert.ok(!response.body.prompt.includes('\\uFFFD'));
    }
  `);
});

test('invalid UTF8, unsafe run IDs and directories fail closed without changing the run error', (t) => {
  isolated(t, `
    seed('invalid-bytes',{status:'failed',code:3});
    writeFileSync(file('invalid-bytes'),Buffer.from([0xff,0x61]));
    let response=await unchanged();
    assert.equal(response.body.prompt,''); assert.equal(response.body.available,false); assert.ok(response.body.readError);
    assert.equal(response.body.totalBytes,2); assert.equal(response.body.status,'failed');
    assert.equal(get("SELECT error FROM runs WHERE id='invalid-bytes'").error,'original worker error');
    seed('directory',{at:'2026-11-22T01:00:00Z'}); mkdirSync(file('directory'));
    response=await unchanged(); assert.equal(response.body.available,false); assert.ok(response.body.readError);
    writeFileSync(join(DATA,'outside.md'),'PRIVATE OUTSIDE CONTENT');
    for(const id of ['../outside','..\\\\outside','C:outside','run\\n']) {
      seed(id);
      response=await unchanged('t1',id);
      assert.equal(response.status,200); assert.equal(response.body.prompt,'');
      assert.equal(response.body.available,false); assert.ok(response.body.readError);
    }
  `);
});

test('history is bounded and deterministically ordered while an older run remains selectable', (t) => {
  isolated(t, `
    for(let i=0;i<55;i++) seed('run-'+String(i).padStart(2,'0'));
    writeFileSync(file('run-54'),'latest'); writeFileSync(file('run-00'),'earliest saved input');
    let response=await unchanged();
    assert.equal(response.body.runId,'run-54'); assert.equal(response.body.runs.length,50);
    assert.equal(response.body.runsTruncated,true);
    assert.deepEqual(response.body.runs.map(run=>run.runId),Array.from({length:50},(_,i)=>'run-'+String(54-i).padStart(2,'0')));
    response=await unchanged('t1','run-00');
    assert.equal(response.body.runId,'run-00'); assert.equal(response.body.prompt,'earliest saved input');
    assert.equal(response.body.runs.length,50); assert.equal(response.body.runsTruncated,true);
    assert.ok(!response.body.runs.some(run=>run.runId==='run-00'));
  `);
});

test('a symbolic link cannot expose another file as a saved input', (t) => {
  const output=isolated(t, `
    seed('linked');
    const outside=join(DATA,'outside.txt'); writeFileSync(outside,'PRIVATE LINK TARGET');
    try { symlinkSync(outside,file('linked'),'file'); }
    catch(error) { if(['EPERM','EACCES','ENOSYS'].includes(error.code)) { console.log('SKIP_SYMLINK'); process.exit(0); } throw error; }
    const response=await unchanged();
    assert.equal(response.status,200); assert.equal(response.body.available,false);
    assert.equal(response.body.prompt,''); assert.ok(response.body.readError);
  `);
  if(output.includes('SKIP_SYMLINK')) t.skip('This host cannot create symbolic links');
});

test('database failures produce an error rather than a fabricated empty input', (t) => {
  isolated(t, `
    run('ALTER TABLE runs RENAME TO unavailable_runs');
    const response=await request();
    assert.equal(response.status,500); assert.ok(response.body.error);
    assert.equal(get('SELECT COUNT(*) AS n FROM events').n,0);
  `);
});

test('a legacy database without runs.flow_json migrates on startup and keeps old runs at flow:null', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'devhub-input-records-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const legacySchema = `
    mkdirSync(DATA,{recursive:true});
    const legacyDb=new DatabaseSync(join(DATA,'devhub.db'));
    legacyDb.exec("CREATE TABLE runs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, member_id TEXT NOT NULL, status TEXT NOT NULL, session_id TEXT DEFAULT '', exit_code INTEGER, log_path TEXT DEFAULT '', error TEXT DEFAULT '', started_at TEXT NOT NULL, ended_at TEXT)");
    legacyDb.exec("INSERT INTO runs (id,task_id,member_id,status,exit_code,started_at,ended_at) VALUES ('legacy-run','t1','m1','completed',0,'2026-11-20T00:00:00Z','2026-11-20T00:01:00Z')");
    legacyDb.close();
  `;
  isolated(t, `
    const names=all('PRAGMA table_info(runs)').map(column=>column.name);
    assert.ok(names.includes('flow_json'),'startup must add runs.flow_json');
    assert.equal(names.filter(name=>name==='flow_json').length,1);
    assert.equal(get("SELECT flow_json FROM runs WHERE id='legacy-run'").flow_json,'');
    const response=await unchanged();
    assert.equal(response.status,200);
    assert.equal(response.body.runId,'legacy-run');
    assert.equal(response.body.flow,null);
    assert.equal(response.body.status,'completed');
    assert.equal(response.body.exitCode,0);
    assert.equal(response.body.startedAt,'2026-11-20T00:00:00Z');
    assert.equal(response.body.endedAt,'2026-11-20T00:01:00Z');
    assert.deepEqual(response.body.runs.map(run=>run.runId),['legacy-run']);
    assert.equal(get("SELECT flow_json FROM runs WHERE id='legacy-run'").flow_json,'');
  `, { beforeOpen: legacySchema, directory });
  // A second start on the already-migrated database must not duplicate the column or rewrite rows.
  isolated(t, `
    const names=all('PRAGMA table_info(runs)').map(column=>column.name);
    assert.equal(names.filter(name=>name==='flow_json').length,1);
    assert.equal(get('SELECT COUNT(*) AS n FROM runs').n,1);
    assert.equal(get("SELECT flow_json FROM runs WHERE id='legacy-run'").flow_json,'');
    const response=await unchanged();
    assert.equal(response.status,200); assert.equal(response.body.runId,'legacy-run');
    assert.equal(response.body.flow,null); assert.equal(response.body.status,'completed');
  `, { directory });
});

test('the real run insert saves the room flow snapshot verbatim', (t) => {
  const source = readFileSync(new URL('../server/engine.js', import.meta.url), 'utf8');
  const statements = [...source.matchAll(/INSERT INTO runs \(([^)]*)\) VALUES \(([^)]*)\)/g)];
  assert.equal(statements.length, 1, 'engine must keep exactly one runs insert');
  const columns = statements[0][1].split(',').map((value) => value.trim());
  const placeholders = statements[0][2].split(',').map((value) => value.trim());
  assert.ok(columns.includes('flow_json'), 'the run insert must save the flow snapshot');
  assert.equal(columns.length, placeholders.length);
  assert.ok(placeholders.every((value) => value === '?'));
  const flowIndex = columns.indexOf('flow_json');
  const params = source.slice(statements[0].index + statements[0][0].length).match(/\[\s*([^[\]]*)\]/);
  assert.ok(params, 'expected the insert parameter list right after the statement');
  const values = params[1].split(',').map((value) => value.trim());
  assert.equal(values.length, columns.length);
  assert.equal(values[flowIndex], 'room.flow_json');
  // Execute the extracted statement against the migrated schema so the column/placeholder
  // contract is exercised by a real SQLite database, not only by reading source text.
  isolated(t, `
    const statement=${JSON.stringify(statements[0][0])};
    const columns=${JSON.stringify(columns)};
    const flow=JSON.stringify({id:'flow-written',nodes:[{id:'n1',type:'phase',gate:'human'}],edges:[]});
    const values=columns.map(column=>{
      if(column==='flow_json') return flow;
      if(column==='id') return 'run-snapshot-probe';
      if(column==='status') return 'running';
      return 'probe';
    });
    run(statement,values);
    const saved=get("SELECT * FROM runs WHERE id='run-snapshot-probe'");
    assert.equal(saved.flow_json,flow);
    assert.equal(saved.status,'running');
  `);
});

