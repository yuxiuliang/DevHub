import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const apiUrl = new URL('../server/api.js', import.meta.url).href;
const storeUrl = new URL('../server/store.js', import.meta.url).href;

test('task mutations require POST; other methods preserve tasks, runs, reviews and events', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'devhub-task-methods-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = `
    import assert from 'node:assert/strict';
    import { Readable } from 'node:stream';
    import { openStore, all, run } from ${JSON.stringify(storeUrl)};
    import { handleApi } from ${JSON.stringify(apiUrl)};
    openStore();
    run("INSERT INTO rooms (id,name,repo_path,status,created_at,updated_at) VALUES ('r','methods','unused','draft','now','now')");
    run("INSERT INTO tasks (id,room_id,key,title,status,created_at,updated_at) VALUES ('t','r','T1','Methods','ready','now','now')");
    const snapshot = () => JSON.stringify(['rooms','tasks','runs','reviews','events'].map((table) => all('SELECT * FROM ' + table)));
    const original = snapshot();
    async function request(method, action) {
      const req = Readable.from([]);
      req.method = method;
      let status, raw;
      const headers = {};
      const res = {
        setHeader(name, value) { headers[name.toLowerCase()] = value; },
        writeHead(code, values) { status = code; Object.assign(headers, values); },
        end(value) { raw = value; },
      };
      assert.equal(await handleApi(req, res, new URL('http://127.0.0.1/api/tasks/t/' + action)), true);
      return { status, headers, body: JSON.parse(raw) };
    }
    for (const action of ['run','review','merge','reject','retry','cancel']) {
      for (const method of ['GET','HEAD','OPTIONS','PUT','PATCH','DELETE']) {
        const response = await request(method, action);
        assert.equal(response.status, 405, method + ' ' + action + ' must not perform a mutation');
        assert.equal(response.headers.allow, 'POST');
        assert.match(response.body.error, /POST/);
        assert.equal(snapshot(), original, method + ' ' + action + ' changed persisted state');
      }
    }
    const cancelled = await request('POST', 'cancel');
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.ok, true);
    assert.equal(all("SELECT status FROM tasks WHERE id='t'")[0].status, 'cancelled');
    assert.notEqual(snapshot(), original, 'the supported POST still performs the action');
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
    env: { ...process.env, DEVHUB_DATA: directory }, encoding: 'utf8', windowsHide: true, timeout: 15_000,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stdout + child.stderr);
});
