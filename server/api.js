import { all, get, run, emit, now, uid, bus, safeJson, flowTemplateList } from './store.js';
import * as E from './engine.js';
import { detectWorkers } from './adapters.js';
import { browseDir } from './fs.js';
import { listInbox } from './inbox.js';
import { taskLog } from './logs.js';
import { taskPrompt } from './inputs.js';

let workerCache = { at: 0, data: null };

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 5_000_000) req.destroy(); });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

export async function handleApi(req, res, url) {
  const p = url.pathname;
  if (!p.startsWith('/api/')) return false;
  const method = req.method;

  try {
    if (p === '/api/health') return json(res, 200, { ok: true, at: now() }), true;

    if (p === '/api/stop-all' && method === 'POST') {
      return json(res, 200, { stopped: E.stopAll() }), true;
    }

    if (p === '/api/workers') {
      if (!workerCache.data || url.searchParams.get('refresh') === '1' || Date.now() - workerCache.at > 30000) {
        workerCache = { at: Date.now(), data: await detectWorkers() };
      }
      return json(res, 200, { workers: workerCache.data }), true;
    }

    if (p === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(': connected\n\n');
      const send = (e) => { try { res.write(`data: ${JSON.stringify(e)}\n\n`); } catch {} };
      const onEvent = (e) => send({ kind: 'event', ...e });
      const onLog = (e) => send({ kind: 'log', ...e });
      bus.on('event', onEvent);
      bus.on('log', onLog);
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15000);
      req.on('close', () => {
        clearInterval(ping);
        bus.off('event', onEvent);
        bus.off('log', onLog);
      });
      return true;
    }

    if (p === '/api/fs' && method === 'GET') {
      try {
        return json(res, 200, await browseDir(url.searchParams.get('path'))), true;
      } catch (e) {
        return json(res, 400, { error: e.message }), true;
      }
    }

    if (p === '/api/state' && method === 'GET') {
      return json(res, 200, {
        rooms: E.listRooms(),
        running: E.runningTasks(),
        activeWorkers: E.activeWorkerCount(),
        flowTemplates: flowTemplateList(),
        inbox: listInbox(),
      }), true;
    }

    if (p === '/api/rooms' && method === 'POST') {
      const body = await readBody(req);
      const state = await E.createRoom(body);
      return json(res, 200, state), true;
    }

    let m;

    if ((m = p.match(/^\/api\/rooms\/([^/]+)\/settings$/))) {
      if (method === 'GET') return json(res, 200, E.readSettings(m[1])), true;
      if (method === 'PATCH') {
        const body = await readBody(req);
        return json(res, 200, E.saveSettings(m[1], body)), true;
      }
    }

    if ((m = p.match(/^\/api\/rooms\/([^/]+)$/))) {
      const id = m[1];
      if (method === 'GET') {
        const state = E.getRoomState(id);
        if (!state) return json(res, 404, { error: '房间不存在' }), true;
        return json(res, 200, state), true;
      }
      if (method === 'PATCH') {
        const body = await readBody(req);
        return json(res, 200, E.updateRoom(id, body)), true;
      }
      if (method === 'DELETE') {
        E.archiveRoom(id);
        return json(res, 200, { ok: true }), true;
      }
    }

    if ((m = p.match(/^\/api\/rooms\/([^/]+)\/members$/)) && method === 'POST') {
      const body = await readBody(req);
      return json(res, 200, E.addRoomMember(m[1], body)), true;
    }

    if ((m = p.match(/^\/api\/members\/([^/]+)$/))) {
      if (method === 'PATCH') {
        const body = await readBody(req);
        return json(res, 200, E.updateRoomMember(m[1], body)), true;
      }
      if (method === 'DELETE') {
        E.removeRoomMember(m[1]);
        return json(res, 200, { ok: true }), true;
      }
    }

    if ((m = p.match(/^\/api\/rooms\/([^/]+)\/plan$/)) && method === 'POST') {
      const plan = await E.generatePlan(m[1]);
      return json(res, 200, { plan }), true;
    }

    if ((m = p.match(/^\/api\/rooms\/([^/]+)\/plan\/apply$/)) && method === 'POST') {
      const body = await readBody(req);
      const state = E.applyPlan(m[1], body.plan || body);
      return json(res, 200, state), true;
    }

    if ((m = p.match(/^\/api\/rooms\/([^/]+)\/start$/)) && method === 'POST') {
      return json(res, 200, E.startRoom(m[1])), true;
    }

    if ((m = p.match(/^\/api\/rooms\/([^/]+)\/pause$/)) && method === 'POST') {
      E.pauseRoom(m[1]);
      return json(res, 200, { ok: true }), true;
    }

    if ((m = p.match(/^\/api\/rooms\/([^/]+)\/runs\/cancel$/)) && method === 'POST') {
      return json(res, 200, { cancelled: E.cancelRoomRun(m[1]) }), true;
    }

    if ((m = p.match(/^\/api\/rooms\/([^/]+)\/restore$/)) && method === 'POST') {
      return json(res, 200, E.restoreRoom(m[1])), true;
    }

    if (p === '/api/tasks' && method === 'POST') {
      const body = await readBody(req);
      return json(res, 200, E.createTask(body)), true;
    }

    if ((m = p.match(/^\/api\/tasks\/([^/]+)\/(run|review|approve|merge|reject|retry|cancel)$/))) {
      if (method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return json(res, 405, { error: '此操作仅支持 POST 请求' }), true;
      }
      const id = m[1];
      const action = m[2];
      const body = await readBody(req);
      if (action === 'run') return json(res, 200, await E.startTask(id)), true;
      if (action === 'review') return json(res, 200, await E.reviewTask(id, { resultSha: body.resultSha })), true;
      if (action === 'approve') return json(res, 200, E.approveTask(id)), true;
      if (action === 'merge') return json(res, 200, await E.mergeTask(id, { resultSha: body.resultSha })), true;
      if (action === 'reject') { E.rejectTask(id, body.note); return json(res, 200, { ok: true }), true; }
      if (action === 'retry') { E.retryTask(id); return json(res, 200, { ok: true }), true; }
      if (action === 'cancel') { E.cancelTask(id); return json(res, 200, { ok: true }), true; }
    }

    if ((m = p.match(/^\/api\/tasks\/([^/]+)\/diff$/)) && method === 'GET') {
      return json(res, 200, await E.taskDiff(m[1])), true;
    }

    if ((m = p.match(/^\/api\/tasks\/([^/]+)\/prompt$/)) && method === 'GET') {
      const runId = url.searchParams.has('runId') ? url.searchParams.get('runId') : undefined;
      return json(res, 200, await taskPrompt(m[1], runId)), true;
    }

    if ((m = p.match(/^\/api\/tasks\/([^/]+)\/log$/)) && method === 'GET') {
      return json(res, 200, await taskLog(m[1])), true;
    }

    if (p === '/api/decisions' && method === 'POST') {
      const b = await readBody(req);
      const id = uid('d');
      run('INSERT INTO decisions (id, room_id, text, rationale, status, created_at) VALUES (?,?,?,?,?,?)',
        [id, b.roomId, String(b.text || '').slice(0, 2000), String(b.rationale || '').slice(0, 2000), 'active', now()]);
      emit(b.roomId, null, null, 'decision.added', { text: b.text });
      return json(res, 200, { id }), true;
    }

    return json(res, 404, { error: 'not found', path: p }), true;
  } catch (e) {
    return json(res, e.statusCode || 500, { error: String(e.message || e) }), true;
  }
}
