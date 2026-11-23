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
  const directory = mkdtempSync(join(tmpdir(), 'devhub-flow-validation-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = `
    import assert from 'node:assert/strict';
    import { Readable } from 'node:stream';
    import { handleApi } from ${JSON.stringify(apiUrl)};
    import * as E from ${JSON.stringify(engineUrl)};
    import { openStore, get, all, run, emit, bus, defaultFlow } from ${JSON.stringify(storeUrl)};
    openStore();
    const ts = '2026-11-20T00:00:00.000Z';
    run('INSERT INTO rooms (id,name,requirement,repo_path,base_branch,flow_json,planner_id,reviewer_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      ['r_one','会话','当前需求','unused-fixture-repo','main','{"nodes":[],"edges":[]}','m_one','m_two',ts,ts]);
    run('INSERT INTO rooms (id,name,repo_path,created_at,updated_at) VALUES (?,?,?,?,?)', ['r_other','其他会话','unused',ts,ts]);
    for (const [id,roomId,name,sort,enabled] of [['m_one','r_one','成员一',0,1], ['m_two','r_one','成员二',1,1], ['m_off','r_one','停用成员',2,0], ['m_foreign','r_other','外部成员',0,1]]) {
      run('INSERT INTO members (id,room_id,name,worker,sort,enabled) VALUES (?,?,?,?,?,?)', [id,roomId,name,'codex',sort,enabled]);
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
    const route = '/api/rooms/r_one';
    const notices = [];
    bus.on('event', (event) => notices.push(event));
    const snapshot = () => JSON.stringify(['rooms','members','tasks','events'].map((table) => all('SELECT * FROM ' + table + ' ORDER BY rowid')));
    const currentFlow = () => JSON.parse(get("SELECT flow_json FROM rooms WHERE id='r_one'").flow_json);
    const writeFlow = (flow) => run("UPDATE rooms SET flow_json=? WHERE id='r_one'", [JSON.stringify(flow)]);
    const save = (flow) => api('PATCH', route, { flow, expectedFlow: currentFlow() });
    async function rejected(flow, message) {
      const before = snapshot();
      const sent = notices.length;
      const response = await save(flow);
      assert.equal(response.status, 400, JSON.stringify(response.body));
      assert.equal(response.body.error, message);
      assert.equal(snapshot(), before, 'a rejected flow must not change the database');
      assert.equal(notices.length, sent, 'a rejected flow must not publish events');
      return response;
    }
    const validFlow = () => ({
      id: 'flow-custom', name: '自定义流程', template: 'code',
      nodes: [
        { id:'n1', type:'phase', name:'需求澄清', owner:'成员一', gate:'human', outputs:['prd'], x:40, y:90, maxLoop:0 },
        { id:'n2', type:'phase', name:'执行', owner:'', gate:'auto', outputs:['code_diff'], x:270, y:90, maxLoop:0 },
        { id:'n3', type:'phase', name:'评审', owner:'成员二', gate:'agent', outputs:['review_report'], x:500, y:90, maxLoop:2 },
        { id:'n4', type:'phase', name:'交付', owner:'停用成员', gate:'human', outputs:[], x:730, y:90, maxLoop:0 },
      ],
      edges: [
        { from:'n1', to:'n2', condition:'passed' },
        { from:'n2', to:'n3', condition:'passed' },
        { from:'n3', to:'n4', condition:'passed' },
        { from:'n3', to:'n2', condition:'rejected' },
      ],
    });
    await (${body.toString()})({ assert, api, route, save, rejected, snapshot, currentFlow, writeFlow, notices, get, all, run, bus, defaultFlow, validFlow });
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
    env: { ...process.env, DEVHUB_DATA: directory }, encoding: 'utf8', windowsHide: true, timeout: 20_000,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stdout + child.stderr);
}

test('valid flows save: the default template and a rejected back edge with maxLoop', (t) => {
  isolated(t, async ({ assert, save, currentFlow, notices, defaultFlow, validFlow }) => {
    const template = defaultFlow();
    const templateSave = await save(template);
    assert.equal(templateSave.status, 200, JSON.stringify(templateSave.body));
    assert.deepEqual(currentFlow(), template);
    assert.equal(notices.at(-1).type, 'room.updated');

    const custom = validFlow();
    const customSave = await save(custom);
    assert.equal(customSave.status, 200, JSON.stringify(customSave.body));
    assert.deepEqual(currentFlow(), custom);
    assert.equal(customSave.body.room.flow.nodes.length, 4);

    // 只有回边、但不成环时不需要 maxLoop；timeout / always 也是允许的条件。
    const withoutLoop = validFlow();
    withoutLoop.nodes = withoutLoop.nodes.slice(0, 3);
    withoutLoop.nodes[2].maxLoop = 0;
    withoutLoop.edges = [
      { from:'n1', to:'n2', condition:'always' },
      { from:'n1', to:'n3', condition:'passed' },
      { from:'n3', to:'n2', condition:'rejected' },
    ];
    const withoutLoopSave = await save(withoutLoop);
    assert.equal(withoutLoopSave.status, 200, JSON.stringify(withoutLoopSave.body));
    assert.deepEqual(currentFlow(), withoutLoop);

    const withTimeout = validFlow();
    withTimeout.nodes = withTimeout.nodes.slice(0, 3);
    withTimeout.nodes[2].maxLoop = 0;
    withTimeout.edges = [
      { from:'n1', to:'n2', condition:'passed' },
      { from:'n2', to:'n3', condition:'timeout' },
    ];
    assert.equal((await save(withTimeout)).status, 200);
    assert.deepEqual(currentFlow(), withTimeout);
  });
});

test('node field rules 9-13 reject with exact messages and leave rooms and events untouched', (t) => {
  isolated(t, async ({ assert, rejected, validFlow }) => {
    const mutate = (change) => { const flow = validFlow(); change(flow); return flow; };

    await rejected(mutate((flow) => { flow.nodes[1].type = 'stage'; }), '流程阶段类型只支持 phase');
    await rejected(mutate((flow) => { flow.nodes[1].type = null; }), '流程阶段类型只支持 phase');

    await rejected(mutate((flow) => { flow.nodes[1].gate = 'manual'; }), '流程阶段完成条件只支持 auto / agent / human');
    await rejected(mutate((flow) => { flow.nodes[1].gate = null; }), '流程阶段完成条件只支持 auto / agent / human');

    for (const bad of [1.5, '2', -1, 10, null, true]) {
      await rejected(mutate((flow) => { flow.nodes[2].maxLoop = bad; }), '回边上限必须是 0-9 的整数');
    }

    await rejected(mutate((flow) => { flow.nodes[1].owner = 5; }), '流程阶段负责人必须是成员名字');
    await rejected(mutate((flow) => { flow.nodes[1].owner = null; }), '流程阶段负责人必须是成员名字');
    await rejected(mutate((flow) => { flow.nodes[2].owner = '陌生人'; }), '阶段「评审」的负责人「陌生人」不在成员列表中');
    // 其他房间的成员不算本房间成员
    await rejected(mutate((flow) => { flow.nodes[1].owner = '外部成员'; }), '阶段「执行」的负责人「外部成员」不在成员列表中');
    // 阶段没有名字时用 id 代替
    await rejected(mutate((flow) => {
      delete flow.nodes[3].name;
      flow.nodes[3].owner = '陌生人';
    }), '阶段「n4」的负责人「陌生人」不在成员列表中');
    // 结构错误先于图结构错误报出
    await rejected(mutate((flow) => {
      flow.nodes[1].gate = 'manual';
      flow.nodes.push({ id:'n9', type:'phase', name:'孤立' });
    }), '流程阶段完成条件只支持 auto / agent / human');
  });
});

test('edge rules 14-17 reject with exact messages and leave rooms and events untouched', (t) => {
  isolated(t, async ({ assert, rejected, validFlow }) => {
    const mutate = (change) => { const flow = validFlow(); change(flow); return flow; };

    await rejected(mutate((flow) => { flow.edges[0] = null; }), '流程连线格式无效');
    await rejected(mutate((flow) => { flow.edges[0] = []; }), '流程连线格式无效');
    await rejected(mutate((flow) => { flow.edges[0].to = 'missing'; }), '流程连线的起点和终点必须是现有阶段');
    await rejected(mutate((flow) => { flow.edges[0].from = 7; }), '流程连线的起点和终点必须是现有阶段');
    await rejected(mutate((flow) => { flow.edges.push({ from:'n2', to:'n2', condition:'passed' }); }), '流程连线不能指向自己');
    await rejected(mutate((flow) => { flow.edges[0].condition = 'maybe'; }), '流程连线条件只支持 passed / rejected / timeout / always');
    await rejected(mutate((flow) => { flow.edges[0].condition = null; }), '流程连线条件只支持 passed / rejected / timeout / always');
  });
});

test('graph rules 18-20 reject with exact messages and leave rooms and events untouched', (t) => {
  isolated(t, async ({ assert, rejected, save, currentFlow, validFlow }) => {
    const phase = (id, name, extra = {}) => ({ id, type:'phase', name, owner:'', gate:'auto', outputs:[], x:40, y:90, maxLoop:0, ...extra });

    // 18：没有入边的节点必须恰好一个
    await rejected({ nodes:[phase('n1','开始'), phase('n2','结束')], edges:[] }, '流程必须有且只有一个起始阶段');
    await rejected({
      nodes:[phase('n1','开始'), phase('n2','结束')],
      edges:[{ from:'n1', to:'n2', condition:'passed' }, { from:'n2', to:'n1', condition:'passed' }],
    }, '流程必须有且只有一个起始阶段');

    // 19：从起始阶段沿任意边都到不了的阶段，按 nodes 顺序用顿号连接
    await rejected({
      nodes:[phase('n1','开始'), phase('n2','执行'), phase('n3','评审'), phase('n4')],
      edges:[
        { from:'n1', to:'n2', condition:'passed' },
        { from:'n3', to:'n4', condition:'passed' },
        { from:'n4', to:'n3', condition:'passed' },
      ],
    }, '这些阶段没有连到起始阶段：评审、n4');

    // 20 分支一：由通过边构成的循环
    await rejected({
      nodes:[phase('n1','开始'), phase('n2','执行'), phase('n3','评审')],
      edges:[
        { from:'n1', to:'n2', condition:'passed' },
        { from:'n2', to:'n3', condition:'passed' },
        { from:'n3', to:'n2', condition:'passed' },
      ],
    }, '流程不能有由通过边构成的循环：执行 → 评审');

    // 20 分支二：回边没有打回上限（0 和缺省都算没有）
    await rejected({
      nodes:[phase('n1','开始'), phase('n2','执行'), phase('n3','评审')],
      edges:[
        { from:'n1', to:'n2', condition:'passed' },
        { from:'n2', to:'n3', condition:'passed' },
        { from:'n3', to:'n2', condition:'rejected' },
      ],
    }, '回边必须设置打回上限（maxLoop ≥ 1）：评审 → 执行');
    await rejected({
      nodes:[phase('n1','开始'), phase('n2','执行'), (() => { const node = phase('n3','评审'); delete node.maxLoop; return node; })()],
      edges:[
        { from:'n1', to:'n2', condition:'passed' },
        { from:'n2', to:'n3', condition:'passed' },
        { from:'n3', to:'n2', condition:'rejected' },
      ],
    }, '回边必须设置打回上限（maxLoop ≥ 1）：评审 → 执行');

    // 上限挂在发起打回的节点上：上限在终点节点无效
    const wrongSide = validFlow();
    wrongSide.nodes[2].maxLoop = 0;
    wrongSide.nodes[1].maxLoop = 2;
    await rejected(wrongSide, '回边必须设置打回上限（maxLoop ≥ 1）：评审 → 执行');

    // 回边按「任意边」成环：A --rejected--> B 且 B --rejected--> A 互相打回也要上限，
    // 按 edges 顺序命中第一条。
    const mutual = () => ({
      nodes:[phase('n1','开始'), phase('A','A'), phase('B','B')],
      edges:[
        { from:'n1', to:'A', condition:'passed' },
        { from:'A', to:'B', condition:'rejected' },
        { from:'B', to:'A', condition:'rejected' },
      ],
    });
    await rejected(mutual(), '回边必须设置打回上限（maxLoop ≥ 1）：A → B');
    const mutualLoops = mutual();
    mutualLoops.nodes[1].maxLoop = 2;
    mutualLoops.nodes[2].maxLoop = 2;
    const mutualSave = await save(mutualLoops);
    assert.equal(mutualSave.status, 200, JSON.stringify(mutualSave.body));
    assert.deepEqual(currentFlow(), mutualLoops);
  });
});

test('an empty flow saves and the stored graph is replaced', (t) => {
  isolated(t, async ({ assert, save, currentFlow, defaultFlow }) => {
    assert.equal((await save(defaultFlow())).status, 200);
    assert.equal(currentFlow().nodes.length, 4);
    const empty = await save({ nodes: [], edges: [] });
    assert.equal(empty.status, 200, JSON.stringify(empty.body));
    assert.deepEqual(currentFlow(), { nodes: [], edges: [] });
    assert.deepEqual(empty.body.room.flow, { nodes: [], edges: [] });
  });
});

test('legacy invalid flows stay readable and are only rejected when saved again', (t) => {
  isolated(t, async ({ assert, api, route, rejected, currentFlow, writeFlow, snapshot, notices }) => {
    const isolatedNodes = { nodes: [{ id:'n1', type:'phase', name:'孤立' }, { id:'n2', type:'phase', name:'孤儿' }], edges: [] };
    writeFlow(isolatedNodes);
    const before = snapshot();
    const sent = notices.length;
    const read = await api('GET', route);
    assert.equal(read.status, 200);
    assert.deepEqual(read.body.room.flow, isolatedNodes);
    assert.equal(snapshot(), before, 'reading a legacy flow must not write');
    assert.equal(notices.length, sent, 'reading a legacy flow must not publish events');
    await rejected(isolatedNodes, '流程必须有且只有一个起始阶段');
    assert.deepEqual(currentFlow(), isolatedNodes);

    const legacyGate = { nodes: [{ id:'n1', type:'phase', name:'旧阶段', gate:'manual', owner:'已离开的成员' }], edges: [] };
    writeFlow(legacyGate);
    assert.equal((await api('GET', route)).status, 200);
    await rejected(legacyGate, '流程阶段完成条件只支持 auto / agent / human');
    assert.deepEqual(currentFlow(), legacyGate);

    // 修复后的同一张图可以保存
    const fixed = { nodes: [{ id:'n1', type:'phase', name:'旧阶段', gate:'auto', owner:'' }], edges: [] };
    const fixedSave = await api('PATCH', route, { flow: fixed, expectedFlow: legacyGate });
    assert.equal(fixedSave.status, 200, JSON.stringify(fixedSave.body));
    assert.deepEqual(currentFlow(), fixed);
  });
});

test('structural messages 1-8 keep their original wording', (t) => {
  isolated(t, async ({ assert, rejected }) => {
    await rejected(null, '流程必须是对象');
    await rejected([], '流程必须是对象');
    await rejected({ nodes:{}, edges:[] }, '流程阶段必须是数组');
    await rejected({ nodes:[], edges:{} }, '流程连线必须是数组');
    await rejected({ nodes:[5], edges:[] }, '流程阶段格式无效');
    await rejected({ nodes:[[]], edges:[] }, '流程阶段格式无效');
    await rejected({ nodes:[{ id:'' }], edges:[] }, '流程阶段必须有有效标识');
    await rejected({ nodes:[{ id:'   ' }], edges:[] }, '流程阶段必须有有效标识');
    await rejected({ nodes:[{ id:7 }], edges:[] }, '流程阶段必须有有效标识');
    await rejected({ nodes:[{ id:'n1' }, { id:'n1' }], edges:[] }, '流程阶段标识重复：n1');
    await rejected({ nodes:[{ id:'n1', outputs:'code_diff' }], edges:[] }, '流程阶段产出必须是文字标签列表');
    await rejected({ nodes:[{ id:'n1', outputs:[null] }], edges:[] }, '流程阶段产出必须是文字标签列表');
    await rejected({ nodes:[{ id:'n1', x:null }], edges:[] }, '流程阶段位置 x 必须是有限的非负数');
    await rejected({ nodes:[{ id:'n1', x:1.5, y:-1 }], edges:[] }, '流程阶段位置 y 必须是有限的非负数');
    await rejected({ nodes:[{ id:'n1', y:Infinity }], edges:[] }, '流程阶段位置 y 必须是有限的非负数');
  });
});
