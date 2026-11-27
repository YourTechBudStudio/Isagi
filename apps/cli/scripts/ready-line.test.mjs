import assert from 'node:assert/strict';
import test from 'node:test';

import { readyUrl } from './ready-line.mjs';

const line = 'ISAGI_RUNTIME_READY {"url":"http://127.0.0.1:12345"}\n';

test('a ready line counts only once its newline arrives', () => {
  let stdout = '';
  for (const chunk of ['log line\nISAGI_RUNTIME_READY {"url":', '"http://127.0.0.1:12345"}']) {
    stdout += chunk;
    assert.equal(readyUrl(stdout), undefined);
  }
  stdout += '\n';
  assert.equal(readyUrl(stdout), 'http://127.0.0.1:12345');
});

test('a ready line split at every position yields the URL only when complete', () => {
  for (let index = 1; index < line.length; index += 1) {
    assert.equal(readyUrl(line.slice(0, index)), undefined, `split at ${index}`);
  }
  assert.equal(readyUrl(`other\r\n${line}`), 'http://127.0.0.1:12345');
});

test('a complete but malformed ready line fails', () => {
  assert.throws(() => readyUrl('ISAGI_RUNTIME_READY {"url":\n'), /malformed ready line/u);
  assert.throws(() => readyUrl('ISAGI_RUNTIME_READY {}\n'), /ready line has no url/u);
});
