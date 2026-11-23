import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const apiUrl = new URL('../server/api.js', import.meta.url).href;
const storeUrl = new URL('../server/store.js', import.meta.url).href;
const engineUrl = new URL('../server/engine.js', import.meta.url).href;

function isolated(t, source) {
  const directory = mkdtempSync(join(tmpdir(), 'devhub-task-creation-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const header = `
    import assert from 'node:assert/strict';
    import { Readable } from 'node:stream';
    import { DatabaseSync } from 'node:sqlite';
    import { join } from 'node:path';
    import { openStore, get, all, run, bus } from ${JSON.stringify(storeUrl)};
    import { handleApi } from ${JSON.stringify(apiUrl)};
    import { runningTasks, activeWorkerCount } from ${JSON.stringify(engineUrl)};
    openStore();
    for (const id of ['r','other','empty']) run("INSERT INTO rooms (id,name,repo_path,status,created_at,updated_at) VALUES (?,?,'unused','draft','now','now')",[id,id]);
    for (const [id,room,name,worker,enabled,sort] of [
      ['off','r','Disabled','codex',0,0],['m1','r','First','codex',1,1],['m2','r','Second','opencode',1,2],
      ['bad-worker','r','Legacy','not-a-cli',1,3],['foreign','other','Foreign','codex',1,0],['empty-off','empty','Disabled','codex',0,0],
    ]) run('INSERT INTO members (id,room_id,name,worker,enabled,sort) VALUES (?,?,?,?,?,?)',[id,room,name,worker,enabled,sort]);
    const task = (patch={}) => ({roomId:'r',title:'Manual task',spec:'Implement the task',ownerId:'m1',...patch});
    async function request(value) {
      const req = Readable.from([JSON.stringify(value)]); req.method='POST';
      let status,raw;
      const res = {setHeader(){},writeHead(code){status=code;},end(value){raw=value;}};
      assert.equal(await handleApi(req,res,new URL('http://127.0.0.1/api/tasks')),true);
      return {status,body:JSON.parse(raw)};
    }
    const snapshot = () => JSON.stringify(['rooms','members','tasks','runs','events'].map(table=>all('SELECT * FROM '+table+' ORDER BY rowid')));
    const notices=[];
    bus.on('event',event=>notices.push(event));
    function seed(id,key,status='backlog',deps=[],room='r') {
      run("INSERT INTO tasks (id,room_id,key,title,owner_id,status,deps_json,created_at,updated_at) VALUES (?,?,?,?,'m1',?,?,'now','now')",[id,room,key,key,status,JSON.stringify(deps)]);
    }
    async function reject(value,status=400) {
      const before=snapshot(),sent=notices.length;
      const response=await request(value);
      assert.equal(response.status,status,JSON.stringify(value)+' => '+JSON.stringify(response));
      assert.equal(typeof response.body.error,'string');
      assert.ok(response.body.error.trim());
      assert.equal(snapshot(),before,'invalid input must not change persisted state');
      assert.equal(notices.length,sent,'invalid input must not publish events');
    }
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', header + source], {
    env: { ...process.env, DEVHUB_DATA: directory }, encoding: 'utf8', windowsHide: true, timeout: 20_000,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stdout + child.stderr);
}

test('manual task fields reject malformed JSON shapes and types without writes', (t) => {
  isolated(t, `
    const invalid=[task({acceptance:'not an array'}),task({deps:'T1'}),null,[],true,42,'task',{},
      ...[null,1,{},[],false,'','  '].map(roomId=>task({roomId})),
      ...[null,1,{},[],false].map(title=>task({title})),
      ...[null,1,{},[],false].map(spec=>task({spec})),
      ...[null,1,{},[],false,'','invalid',' code '].map(type=>task({type})),
      ...[1,{},[],false].map(ownerId=>task({ownerId})),
      ...[null,{},false,[1],[null],[''],['  ']].map(deps=>task({deps})),
      ...[null,{},false,[1],[null],[''],['  ']].map(acceptance=>task({acceptance})),
    ];
    for (const value of invalid) await reject(value);
  `);
});

test('manual tasks require an enabled member of their own room and a supported worker key', (t) => {
  isolated(t, `
    for(const ownerId of ['missing','foreign','off','bad-worker']) await reject(task({ownerId}));
    await reject({roomId:'empty'});
    const selected=await request(task({ownerId:' m2 '}));
    assert.equal(selected.status,200);
    assert.equal(get('SELECT owner_id FROM tasks WHERE id=?',[selected.body.id]).owner_id,'m2');
    assert.equal(get('SELECT COUNT(*) AS n FROM runs').n,0);
  `);
});

test('unknown and archived rooms give actionable statuses and preserve read-only history', (t) => {
  isolated(t, `
    await reject(task({roomId:'missing'}),404);
    run("UPDATE rooms SET status='archived' WHERE id='r'");
    await reject(task(),409);
    run("UPDATE rooms SET status='draft' WHERE id='r'");
    assert.equal((await request(task())).status,200);
  `);
});

test('manual creation keeps simple defaults, preserves multiline specifications and normalizes display fields', (t) => {
  isolated(t, `
    const observer=new DatabaseSync(join(process.env.DEVHUB_DATA,'devhub.db'),{readOnly:true});
    const seen=[];
    bus.on('event',event=>seen.push({event,
      task:observer.prepare('SELECT * FROM tasks WHERE id=?').get(event.task_id),
      stored:observer.prepare('SELECT type,payload FROM events WHERE id=?').get(event.id),
    }));
    for(const patch of [{},{ownerId:null},{ownerId:' '},{title:' '}]) {
      const response=await request({roomId:'r',...patch});
      assert.equal(response.status,200,JSON.stringify(response));
      const row=get('SELECT * FROM tasks WHERE id=?',[response.body.id]);
      assert.equal(row.title,'新任务'); assert.equal(row.owner_id,'m1');
      assert.equal(row.spec,''); assert.equal(row.type,'code'); assert.equal(row.status,'backlog');
      assert.deepEqual(JSON.parse(row.deps_json),[]); assert.deepEqual(JSON.parse(row.acceptance_json),[]);
    }
    const spec='  第一行\\n第二行\\n  ';
    for(const type of ['code','document','research']) {
      const response=await request(task({roomId:' r ',title:'  标题  ',spec,type,acceptance:[' 条件一 ',' 条件二\\n保留换行 ']}));
      assert.equal(response.status,200);
      const row=get('SELECT * FROM tasks WHERE id=?',[response.body.id]);
      assert.equal(row.title,'标题'); assert.equal(row.spec,spec); assert.equal(row.type,type);
      assert.deepEqual(JSON.parse(row.acceptance_json),['条件一','条件二\\n保留换行']);
    }
    for(const notice of seen) {
      assert.ok(notice.task); assert.equal(notice.stored.type,'task.created');
      assert.equal(notice.event.payload.title,notice.task.title);
      assert.deepEqual(JSON.parse(notice.stored.payload),notice.event.payload);
    }
    assert.equal(seen.length,7);
    assert.deepEqual(runningTasks(),[]); assert.equal(activeWorkerCount(),0);
    observer.close();
  `);
});

test('manual dependencies are unique existing room keys and never refer to the new task itself', (t) => {
  isolated(t, `
    await reject(task({deps:['T1']}));
    seed('upstream','T1','ready'); seed('done','T2','done'); seed('other-task','FOREIGN','done',[],'other');
    for(const deps of [['missing'],['FOREIGN'],['T1',' T1 '],['T1','missing'],['T4']]) await reject(task({deps}));
    const response=await request(task({deps:[' T1 ','T2'],acceptance:[]}));
    assert.equal(response.status,200);
    const row=get('SELECT * FROM tasks WHERE id=?',[response.body.id]);
    assert.deepEqual(JSON.parse(row.deps_json),['T1','T2']);
    assert.equal(row.status,'backlog');
  `);
});

test('dependency chain validation catches cycles and legacy ambiguity without blocking unrelated tasks', (t) => {
  isolated(t, `
    seed('a','A','backlog',['B']); seed('b','B','backlog',['A']);
    seed('unknown','UNKNOWN','backlog',['absent']);
    seed('bad','BAD','backlog'); run("UPDATE tasks SET deps_json='null' WHERE id='bad'");
    seed('dup1','DUP'); seed('dup2','DUP');
    seed('finished','FIN','merged'); run("UPDATE tasks SET deps_json='null' WHERE id='finished'");
    seed('spaces','SPACES','backlog',[' FIN ']);
    seed('repeated','REPEAT','backlog',['FIN','FIN']);
    // The tenth existing record points at T11, the key creation would allocate.
    seed('forward','FORWARD','backlog',['T11']);
    for(const deps of [['A'],['UNKNOWN'],['BAD'],['DUP'],['SPACES'],['REPEAT'],['FORWARD']]) await reject(task({deps}));
    assert.equal((await request(task({deps:['FIN']}))).status,200,'terminal history need not be revalidated');
    assert.equal((await request(task())).status,200,'unrelated legacy errors must not prevent independent work');
  `);
});

test('sparse legacy task numbers and simultaneous requests never reuse a room key', (t) => {
  isolated(t, `
    seed('old1','T1'); seed('old3','T3');
    const first=await request(task()); assert.equal(first.status,200);
    assert.equal(get('SELECT key FROM tasks WHERE id=?',[first.body.id]).key,'T4');
    const results=await Promise.all(Array.from({length:12},(_,i)=>request(task({title:'Concurrent '+i}))));
    assert.ok(results.every(result=>result.status===200),JSON.stringify(results));
    const rows=all("SELECT id,key FROM tasks WHERE room_id='r'");
    assert.equal(rows.length,15); assert.equal(new Set(rows.map(row=>row.key)).size,15);
    assert.equal(new Set(results.map(result=>result.body.id)).size,12);
    assert.equal(notices.length,13); assert.equal(get('SELECT COUNT(*) AS n FROM runs').n,0);
  `);
});

test('late task-created event failures roll back the task and preserve the next available key', (t) => {
  isolated(t, `
    for(const failure of ["SELECT RAISE(ABORT, 'fixture task event');",'SELECT RAISE(IGNORE);']) {
      run("CREATE TRIGGER fail_created BEFORE INSERT ON events WHEN NEW.type='task.created' BEGIN "+failure+' END');
      await reject(task(),500);
      run('DROP TRIGGER fail_created');
      const before=get("SELECT COUNT(*) AS n FROM tasks WHERE room_id='r'").n;
      const response=await request(task()); assert.equal(response.status,200);
      const row=get('SELECT * FROM tasks WHERE id=?',[response.body.id]);
      assert.equal(row.key,'T'+(before+1));
      assert.equal(get('SELECT COUNT(*) AS n FROM events WHERE task_id=?',[row.id]).n,1);
    }
  `);
});

test('new work reopens a completed room as paused and rolls back that transition on failure', (t) => {
  isolated(t, `
    seed('finished','T1','done');
    run("UPDATE rooms SET status='completed' WHERE id='r'");
    run("CREATE TRIGGER fail_reopen BEFORE INSERT ON events WHEN NEW.type='room.paused' BEGIN SELECT RAISE(ABORT, 'fixture reopen'); END");
    await reject(task(),500);
    run('DROP TRIGGER fail_reopen');
    const response=await request(task()); assert.equal(response.status,200);
    assert.equal(get("SELECT status FROM rooms WHERE id='r'").status,'paused');
    const row=get('SELECT key,status FROM tasks WHERE id=?',[response.body.id]);
    assert.equal(row.key,'T2'); assert.equal(row.status,'backlog');
    assert.deepEqual(notices.map(event=>event.type).sort(),['room.paused','task.created']);
    assert.equal(get('SELECT COUNT(*) AS n FROM runs').n,0);
    assert.equal(activeWorkerCount(),0);
  `);
});

test('task creation also rolls back a deferred SQLite COMMIT failure and can retry', (t) => {
  isolated(t, `
    run('PRAGMA foreign_keys=ON');
    run('CREATE TABLE task_commit_guard (room_id TEXT REFERENCES rooms(id) DEFERRABLE INITIALLY DEFERRED)');
    run("CREATE TRIGGER fail_created AFTER INSERT ON events WHEN NEW.type='task.created' BEGIN INSERT INTO task_commit_guard VALUES ('absent'); END");
    await reject(task(),500);
    assert.equal(get('SELECT COUNT(*) AS n FROM task_commit_guard').n,0);
    run('DROP TRIGGER fail_created');
    const response=await request(task()); assert.equal(response.status,200);
    assert.equal(get('SELECT key FROM tasks WHERE id=?',[response.body.id]).key,'T1');
    assert.equal(notices.length,1);
  `);
});
