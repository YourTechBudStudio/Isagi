import assert from 'node:assert/strict';
import test from 'node:test';

import { exitCodeForResult, isLoopbackUrl, signalExitCode } from './policy.mjs';

test('loopback validation accepts semantic IPv4 and IPv6 loopback URLs', () => {
  for (const value of ['http://127.0.0.1:4173/', 'http://127.12.4.8:9', 'http://[::1]:4173/']) {
    assert.equal(isLoopbackUrl(value), true, value);
  }
  for (const value of [
    'http://0.0.0.0:4173/',
    'http://192.168.1.2:4173/',
    'http://user@127.0.0.1:4173/',
    'not a URL',
  ]) {
    assert.equal(isLoopbackUrl(value), false, value);
  }
});

test('exit selection preserves codes and maps only known signals', () => {
  assert.equal(exitCodeForResult({ code: 0, signal: null }), 0);
  assert.equal(exitCodeForResult({ code: 23, signal: null }), 23);
  assert.equal(exitCodeForResult({ code: null, signal: 'SIGTERM' }), signalExitCode('SIGTERM'));
  assert.equal(exitCodeForResult({ code: null, signal: 'NOT_A_SIGNAL' }), 1);
  assert.equal(exitCodeForResult({ code: null, signal: null }), 1);
});
