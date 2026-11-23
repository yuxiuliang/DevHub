import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

// Exercise the actual UI formatter without booting the application or accessing
// workers, the filesystem store, or the DOM. Keep its existing inline location.
const source = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const first = source.indexOf('function eventRunMetrics(');
const last = source.indexOf('\nfunction renderTimeline(', first);
assert.ok(first >= 0 && last > first, 'Expected the real timeline metrics formatter');
const formatterSource = source.slice(first, last);

function metrics(payload, { event = {}, events = [] } = {}) {
  const format = runInNewContext(`(${formatterSource})`, { state: { events } });
  return Array.from(format({ type: 'task.finished', payload, task_id: 'task', run_id: 'run', ...event }));
}

const start = (runId, at, taskId = 'task') => ({
  type: 'task.started', task_id: taskId, run_id: runId, created_at: at,
});

// Explicit totals can include fields beyond input/output; never recompute them.
test('timeline preserves reported totals, exact zero, and provider cost', () => {
  assert.deepEqual(metrics({ cost: 0.012345, usage: { total_tokens: 1320, input_tokens: 1200, output_tokens: 100 } }),
    ['费用 $0.012345 USD', '用量 1,320 tokens']);
  assert.deepEqual(metrics({ cost: 0, usage: { total_tokens: 0 } }), ['费用 $0 USD', '用量 0 tokens']);
});

test('a partial token report is labeled as input or output, not total usage', () => {
  assert.deepEqual(metrics({ usage: { input_tokens: 1200 } }), ['输入 1,200 tokens']);
  assert.deepEqual(metrics({ usage: { output_tokens: 40 } }), ['输出 40 tokens']);
  assert.deepEqual(metrics({ usage: { input_tokens: 0 } }), ['输入 0 tokens']);
});

test('input and output remain separate when other usage categories exist', () => {
  assert.deepEqual(metrics({ usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 70 } }),
    ['输入 10 tokens', '输出 20 tokens']);
});

test('supported worker aliases preserve their reported units', () => {
  for (const usage of [{ inputTokens: 100, outputTokens: 25 }, { prompt_tokens: 100, completion_tokens: 25 }, { input: 100, output: 25 }]) {
    assert.deepEqual(metrics({ usage }), ['输入 100 tokens', '输出 25 tokens']);
  }
  for (const usage of [{ total_tokens: 1234 }, { totalTokens: 1234 }, { total: 1234 }]) {
    assert.deepEqual(metrics({ usage }), ['用量 1,234 tokens']);
  }
});

test('invalid token counts are not rounded or coerced and fall back to run duration', () => {
  const events = [start('run', '2026-11-21T00:00:00Z')];
  const event = { created_at: '2026-11-21T00:00:09Z' };
  for (const invalid of [-1, 1.5, NaN, Infinity, '100', true, Number.MAX_SAFE_INTEGER + 1]) {
    assert.deepEqual(metrics({ usage: { total_tokens: invalid, input_tokens: invalid, output_tokens: invalid } }, { events, event }),
      ['耗时 9秒']);
  }
});

test('positive sub-microdollar costs never display as a free run', () => {
  assert.deepEqual(metrics({ cost: 0.00000001 }), ['费用 <$0.000001 USD']);
  assert.deepEqual(metrics({ cost: 0.000001 }), ['费用 $0.000001 USD']);
  for (const invalid of [-1, Infinity, NaN, '0.01', null]) assert.deepEqual(metrics({ cost: invalid }), []);
  assert.deepEqual(metrics({ cost: 1e21 }), ['费用 $1000000000000000000000 USD']);
});

test('duration matches the task and run without mixing retry or review events', () => {
  const events = [
    start('old', '2026-11-21T00:00:00Z'),
    start('run', '2026-11-21T01:00:00Z'),
    start('other', '2026-11-21T01:02:00Z', 'another-task'),
  ];
  assert.deepEqual(metrics({}, { events, event: { created_at: '2026-11-21T01:02:03Z' } }), ['耗时 2分 3秒']);
  assert.deepEqual(metrics({}, { events, event: { type: 'review.done', created_at: '2026-11-21T01:02:03Z' } }), []);
  assert.deepEqual(metrics({}, { events, event: { run_id: 'missing', created_at: '2026-11-21T01:02:03Z' } }), []);
  assert.deepEqual(metrics({}, { events, event: { created_at: '2026-11-21T00:59:59Z' } }), []);
});

test('legacy duration uses the preceding start for the same identified task', () => {
  const events = [
    start(null, '2026-11-21T00:00:00Z'),
    start(null, '2026-11-21T01:00:00Z'),
    start(null, '2026-11-21T02:00:00Z'),
  ];
  assert.deepEqual(metrics({}, { events, event: { run_id: null, created_at: '2026-11-21T01:00:07Z' } }), ['耗时 7秒']);
  assert.deepEqual(metrics({}, { events: [start(null, '2026-11-21T00:00:00Z', null)],
    event: { task_id: null, run_id: null, created_at: '2026-11-21T00:00:07Z' } }), []);
});
