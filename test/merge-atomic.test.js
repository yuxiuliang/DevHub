import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const engineUrl = new URL('../server/engine.js', import.meta.url).href;
const storeUrl = new URL('../server/store.js', import.meta.url).href;

function isolated(t, source) {
  const directory = mkdtempSync(join(tmpdir(), 'devhub-merge-atomic-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
    env: { ...process.env, DEVHUB_DATA: join(directory, 'data'), DEVHUB_ATOMIC_REPO: join(directory, 'repo') },
    encoding: 'utf8', windowsHide: true, timeout: 30_000,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stdout + child.stderr);
}

const cases = [
  { name: 'dependency row', dependent: true,
    trigger: "BEFORE UPDATE OF status ON tasks WHEN NEW.id='t2' AND NEW.status='ready'" },
  { name: 'merged task status event', dependent: true,
    trigger: "BEFORE INSERT ON events WHEN NEW.type='task.status' AND NEW.task_id='t1'" },
  { name: 'merge event', dependent: true,
    trigger: "BEFORE INSERT ON events WHEN NEW.type='task.merged'" },
  { name: 'ignored merge event', dependent: true, ignore: true,
    trigger: "BEFORE INSERT ON events WHEN NEW.type='task.merged'" },
  { name: 'dependency event', dependent: true,
    trigger: "BEFORE INSERT ON events WHEN NEW.type='task.status' AND NEW.task_id='t2'" },
  { name: 'room completion row', dependent: false,
    trigger: "BEFORE UPDATE OF status ON rooms WHEN NEW.status='completed'" },
  { name: 'room completion event', dependent: false,
    trigger: "BEFORE INSERT ON events WHEN NEW.type='room.completed'" },
  { name: 'no-change room completion event', dependent: false, noChange: true,
    trigger: "BEFORE INSERT ON events WHEN NEW.type='room.completed'" },
];

for (const scenario of cases) {
  test(`merge finalization rolls back ${scenario.name} failure without broadcasting partial success`, (t) => {
    isolated(t, `
      import assert from 'node:assert/strict';
      import { execFileSync } from 'node:child_process';
      import { mkdirSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { DatabaseSync } from 'node:sqlite';
      import { openStore, get, run, bus } from ${JSON.stringify(storeUrl)};
      import { mergeTask } from ${JSON.stringify(engineUrl)};
      const scenario = ${JSON.stringify(scenario)};
      const repo = process.env.DEVHUB_ATOMIC_REPO;
      mkdirSync(repo);
      const git = (...args) => execFileSync('git', ['-C', repo, ...args], {
        encoding:'utf8', windowsHide:true, stdio:['ignore','pipe','pipe'],
      }).trim();
      git('init','-b','main');
      git('config','core.autocrlf','false');
      git('config','commit.gpgsign','false');
      writeFileSync(join(repo,'README.md'),'initial\\n');
      git('add','-A');
      git('-c','user.name=DevHub','-c','user.email=devhub@local','commit','-m','initial');
      const base = git('rev-parse','HEAD');
      git('checkout','-b','feature');
      if (!scenario.noChange) {
        writeFileSync(join(repo,'result.txt'),'fixed result\\n');
        git('add','-A');
        git('-c','user.name=DevHub','-c','user.email=devhub@local','commit','-m','result');
      }
      const resultSha = git('rev-parse','HEAD');
      git('checkout','main');
      openStore();
      const roomStatus = scenario.dependent ? 'paused' : 'running';
      run("INSERT INTO rooms (id,name,repo_path,base_branch,status,created_at,updated_at) VALUES ('r','Atomic',?,'main',?,'now','now')", [repo,roomStatus]);
      run("INSERT INTO tasks (id,room_id,key,title,status,branch,base_sha,result_sha,created_at,updated_at) VALUES ('t1','r','T1','Atomic result','review','feature',?,?,'now','now')", [base,resultSha]);
      if (scenario.dependent) {
        run("INSERT INTO tasks (id,room_id,key,title,status,deps_json,created_at,updated_at) VALUES ('t2','r','T2','Dependent','backlog',?,'now','now')", [JSON.stringify(['T1'])]);
      }
      const failure = scenario.ignore ? 'SELECT RAISE(IGNORE);' : "SELECT RAISE(ABORT, 'fixture atomic finalization');";
      run('CREATE TRIGGER fail_finalize ' + scenario.trigger + ' BEGIN ' + failure + ' END');

      // Read through an independent connection: notifications must describe
      // committed database contents, not uncommitted rows visible to the writer.
      const observer = new DatabaseSync(join(process.env.DEVHUB_DATA,'devhub.db'), {readOnly:true});
      const read = (sql,...params) => observer.prepare(sql).get(...params);
      const notices = [];
      bus.on('event', (event) => {
        if (!['task.status','task.merged','room.completed'].includes(event.type)) return;
        notices.push({ event,
          task: read("SELECT status FROM tasks WHERE id='t1'").status,
          dependent: scenario.dependent ? read("SELECT status FROM tasks WHERE id='t2'").status : null,
          room: read("SELECT status FROM rooms WHERE id='r'").status,
          persisted: read('SELECT type,payload FROM events WHERE id=?',event.id),
        });
      });
      await assert.rejects(mergeTask('t1',{resultSha}), scenario.ignore ? /事件没有写入数据库/ : /fixture atomic finalization/);
      assert.equal(get("SELECT status FROM tasks WHERE id='t1'").status,'review');
      assert.equal(get("SELECT updated_at FROM tasks WHERE id='t1'").updated_at,'now');
      assert.equal(get("SELECT status FROM rooms WHERE id='r'").status,roomStatus);
      assert.equal(get("SELECT updated_at FROM rooms WHERE id='r'").updated_at,'now');
      if (scenario.dependent) assert.equal(get("SELECT status FROM tasks WHERE id='t2'").status,'backlog');
      assert.equal(get("SELECT COUNT(*) AS n FROM events WHERE type IN ('task.status','task.merged','room.completed')").n,0);
      assert.deepEqual(notices,[], 'rolled-back completion must not reach SSE observers');
      const committed = git('rev-parse','HEAD');
      assert.equal(git('rev-list','--count','HEAD'),scenario.noChange ? '1' : '2');
      assert.equal(git('status','--porcelain'),'');
      run('DROP TRIGGER fail_finalize');

      const response = await mergeTask('t1',{resultSha});
      assert.equal(response.ok,true);
      const finalTask = scenario.noChange ? 'done' : 'merged';
      const finalRoom = scenario.dependent ? 'paused' : 'completed';
      assert.equal(get("SELECT status FROM tasks WHERE id='t1'").status,finalTask);
      if (scenario.dependent) assert.equal(get("SELECT status FROM tasks WHERE id='t2'").status,'ready');
      assert.equal(get("SELECT status FROM rooms WHERE id='r'").status,finalRoom);
      assert.equal(git('rev-parse','HEAD'),committed,'retry must not create a duplicate Git commit');
      assert.equal(get("SELECT COUNT(*) AS n FROM events WHERE type='task.merged'").n,1);
      assert.equal(get("SELECT COUNT(*) AS n FROM events WHERE type='task.status' AND task_id='t1'").n,1);
      assert.equal(get("SELECT COUNT(*) AS n FROM events WHERE type='room.completed'").n,scenario.dependent ? 0 : 1);
      assert.equal(notices.length,3);
      for (const notice of notices) {
        assert.equal(notice.task,finalTask);
        assert.equal(notice.dependent,scenario.dependent ? 'ready' : null);
        assert.equal(notice.room,finalRoom);
        assert.equal(notice.persisted.type,notice.event.type);
        assert.deepEqual(JSON.parse(notice.persisted.payload),notice.event.payload);
      }
      observer.close();
    `);
  });
}

test('committed transaction events survive a failing observer and reach the remaining observers', (t) => {
  isolated(t, `
    import assert from 'node:assert/strict';
    import { join } from 'node:path';
    import { DatabaseSync } from 'node:sqlite';
    import { openStore, run, emit, transaction, bus } from ${JSON.stringify(storeUrl)};
    openStore();
    run("INSERT INTO rooms (id,name,repo_path,status,created_at,updated_at) VALUES ('r','Observers','unused','draft','now','now')");
    const observer = new DatabaseSync(join(process.env.DEVHUB_DATA,'devhub.db'),{readOnly:true});
    const notices = [], errors = [];
    let once = 0;
    bus.once('event', () => once++);
    console.error = (...args) => errors.push(args);
    bus.on('event', () => { throw new Error('fixture observer failure'); });
    bus.on('event', (event) => notices.push({event,
      status:observer.prepare("SELECT status FROM rooms WHERE id='r'").get().status,
      stored:observer.prepare('SELECT type FROM events WHERE id=?').get(event.id),
    }));
    const saved = transaction(() => {
      run("UPDATE rooms SET status='running' WHERE id='r'");
      emit('r',null,null,'room.started',{});
      run("UPDATE rooms SET status='completed' WHERE id='r'");
      emit('r',null,null,'room.completed',{});
      return 'saved';
    });
    assert.equal(saved,'saved');
    assert.equal(notices.length,2);
    assert.equal(once,1,'native once listeners keep their single-delivery semantics');
    assert.equal(errors.length,2,'observer errors remain diagnosable');
    for (const notice of notices) {
      assert.equal(notice.status,'completed');
      assert.equal(notice.stored.type,notice.event.type);
    }
    observer.close();
  `);
});

test('a failed SQLite COMMIT discards queued events and leaves the next transaction usable', (t) => {
  isolated(t, `
    import assert from 'node:assert/strict';
    import { openStore, get, run, emit, transaction, bus } from ${JSON.stringify(storeUrl)};
    openStore();
    run('PRAGMA foreign_keys=ON');
    run('CREATE TABLE parents (id INTEGER PRIMARY KEY)');
    run('CREATE TABLE children (id INTEGER PRIMARY KEY,parent_id INTEGER REFERENCES parents(id) DEFERRABLE INITIALLY DEFERRED)');
    run("INSERT INTO rooms (id,name,repo_path,status,created_at,updated_at) VALUES ('r','Commit rollback','unused','draft','now','now')");
    const notices = [];
    bus.on('event', (event) => notices.push(event));
    const save = () => transaction(() => {
      run('INSERT INTO children VALUES (1,999)');
      run("UPDATE rooms SET status='completed' WHERE id='r'");
      emit('r',null,null,'room.completed',{});
    });
    assert.throws(save,/FOREIGN KEY constraint failed/);
    assert.equal(get("SELECT status FROM rooms WHERE id='r'").status,'draft');
    assert.equal(get('SELECT COUNT(*) AS n FROM children').n,0);
    assert.equal(get('SELECT COUNT(*) AS n FROM events').n,0);
    assert.deepEqual(notices,[]);
    run('INSERT INTO parents VALUES (999)');
    save();
    assert.equal(get("SELECT status FROM rooms WHERE id='r'").status,'completed');
    assert.equal(get('SELECT COUNT(*) AS n FROM children').n,1);
    assert.equal(notices.length,1);
    assert.equal(get('SELECT type FROM events WHERE id=?',[notices[0].id]).type,'room.completed');
  `);
});
