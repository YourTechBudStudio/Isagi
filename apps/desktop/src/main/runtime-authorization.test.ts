import assert from 'node:assert/strict';
import test from 'node:test';

import { runtimeRequestHeaders } from './runtime-authorization.js';

const runtime = { host: '127.0.0.1:43129', authorization: 'Bearer launcher' };
const headers = { Accept: 'application/json' };
const headersFor = (url: string) =>
  runtimeRequestHeaders({ url, requestHeaders: headers }, runtime);

test("requests to the runtime's host and port over http and ws carry the bearer", () => {
  for (const url of [
    'http://127.0.0.1:43129/api/v1/workspace',
    'ws://127.0.0.1:43129/api/v1/events',
    'http://127.0.0.1:43129/editor/1/static/main.js',
  ]) {
    assert.deepEqual(headersFor(url), { ...headers, Authorization: 'Bearer launcher' }, url);
  }
});

test('a bearer the request already carries is replaced, never doubled', () => {
  assert.deepEqual(
    runtimeRequestHeaders(
      { url: 'http://127.0.0.1:43129/x', requestHeaders: { authorization: 'Bearer other' } },
      runtime,
    ),
    { Authorization: 'Bearer launcher' },
  );
});

test('other ports, other hosts, other schemes, file: and malformed URLs are left unchanged', () => {
  for (const url of [
    'http://127.0.0.1:5173/',
    'http://127.0.0.1/',
    'http://localhost:43129/',
    'https://127.0.0.1:43129/',
    'wss://127.0.0.1:43129/',
    'https://example.com/',
    'file:///Applications/Isagi.app/Contents/Resources/web/index.html',
    'devtools://devtools/bundled/inspector.html',
    'not a url',
  ]) {
    assert.equal(headersFor(url), headers, url);
  }
});
