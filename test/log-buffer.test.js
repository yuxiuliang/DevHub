import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendRecentLog, limitLog, MAX_LOG_CHARS, MAX_LOG_LINES } from '../web/log-buffer.js';

test('small CRLF logs stay unchanged and stream appends do not add a blank line', () => {
  const log = '开始\r\n完成\r\n';
  assert.deepEqual(limitLog(log), { text: log, truncated: false });
  assert.equal(appendRecentLog(log, '继续').text, `${log}继续\n`);
  assert.equal(appendRecentLog('开始', '继续').text, '开始\n继续\n');
});

test('the most recent complete 2000 lines are retained', () => {
  const input = Array.from({ length: MAX_LOG_LINES + 20 }, (_, index) => `line ${index}`).join('\n') + '\n';
  const output = limitLog(input);
  assert.equal(output.truncated, true);
  assert.ok(output.text.startsWith('line 20\n'));
  assert.ok(output.text.endsWith('line 2019\n'));
  assert.equal(output.text.split('\n').length - 1, MAX_LOG_LINES);
});

test('giant single-line Unicode messages are bounded without a broken surrogate', () => {
  for (const ending of ['', '\n']) {
    const output = limitLog('😀'.repeat(MAX_LOG_CHARS) + ending);
    assert.equal(output.truncated, true);
    assert.ok(output.text.length <= MAX_LOG_CHARS);
    assert.ok(output.text.startsWith('😀'));
    assert.equal(output.text.includes('\ufffd'), false);
  }
});

test('bursty live output remains bounded and keeps the newest marker', () => {
  let text = '';
  for (let index = 0; index < 3000; index++) text = appendRecentLog(text, `event ${index}`).text;
  assert.ok(text.length <= MAX_LOG_CHARS);
  assert.ok(text.startsWith('event 1000\n'));
  assert.ok(text.endsWith('event 2999\n'));
});
