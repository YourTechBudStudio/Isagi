import assert from 'node:assert/strict';
import test from 'node:test';

import { isAllowedRuntimeOrigin } from './origin.js';

test('allows only exact configured browser origins', () => {
  const previous = process.env.ISAGI_ALLOWED_ORIGINS;
  process.env.ISAGI_ALLOWED_ORIGINS = 'http://127.0.0.1:43129, https://runtime-ui.example.test';
  try {
    assert.equal(isAllowedRuntimeOrigin('http://127.0.0.1:43129'), true);
    assert.equal(isAllowedRuntimeOrigin('https://runtime-ui.example.test'), true);
    assert.equal(isAllowedRuntimeOrigin('http://127.0.0.1:43130'), false);
    assert.equal(isAllowedRuntimeOrigin('http://localhost:43129'), false);
    assert.equal(isAllowedRuntimeOrigin('http://127.0.0.1:5173'), false);
  } finally {
    if (previous === undefined) delete process.env.ISAGI_ALLOWED_ORIGINS;
    else process.env.ISAGI_ALLOWED_ORIGINS = previous;
  }
});

test('allows absent and null origins for local non-browser and opaque clients', () => {
  assert.equal(isAllowedRuntimeOrigin(undefined), true);
  assert.equal(isAllowedRuntimeOrigin('null'), true);
});

test('allows the packaged file renderer only when it is explicitly configured', () => {
  const previous = process.env.ISAGI_ALLOWED_ORIGINS;
  delete process.env.ISAGI_ALLOWED_ORIGINS;
  try {
    assert.equal(isAllowedRuntimeOrigin('file://'), false);
    process.env.ISAGI_ALLOWED_ORIGINS = 'file://';
    assert.equal(isAllowedRuntimeOrigin('file://'), true);
    assert.equal(isAllowedRuntimeOrigin('file:///Applications/Isagi.app'), false);
  } finally {
    if (previous === undefined) delete process.env.ISAGI_ALLOWED_ORIGINS;
    else process.env.ISAGI_ALLOWED_ORIGINS = previous;
  }
});
