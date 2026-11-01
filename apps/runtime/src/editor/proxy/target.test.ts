import assert from 'node:assert/strict';
import { test } from 'node:test';

import { editorProxyRequestTarget } from './target.js';

test('editorProxyRequestTarget strips the prefix and keeps the rest of the raw URL', () => {
  assert.deepEqual(editorProxyRequestTarget('/editor/7/stable-abc/x?y=1'), {
    editorContextId: 7,
    path: '/stable-abc/x?y=1',
  });
  assert.deepEqual(editorProxyRequestTarget('/editor/7/'), { editorContextId: 7, path: '/' });
  assert.deepEqual(editorProxyRequestTarget('/editor/12/?folder=%2Fa%20b'), {
    editorContextId: 12,
    path: '/?folder=%2Fa%20b',
  });
  assert.deepEqual(editorProxyRequestTarget('/editor/3/a%2Fb/../c'), {
    editorContextId: 3,
    path: '/a%2Fb/../c',
  });
});

test('editorProxyRequestTarget refuses an id that is not a positive integer', () => {
  for (const rawUrl of [
    '/editor/0/',
    '/editor/-1/',
    '/editor/07/',
    '/editor/1.5/',
    '/editor/abc/',
    '/editor//',
    '/editor/99999999999999999999/',
    '/editor/7',
    '/editor/7?x=1',
    '/other/7/',
  ]) {
    assert.equal(editorProxyRequestTarget(rawUrl), null, rawUrl);
  }
});
