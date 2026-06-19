import assert from 'node:assert/strict';
import test from 'node:test';

import { createCommandLogTransport } from './transport.js';

test('command log transport buffers output until xterm connects', () => {
  const transport = createCommandLogTransport();
  const writes: string[] = [];

  transport.pushOutput('before');
  transport.connect({
    write: (data) => writes.push(data),
    setInteractive: () => undefined,
    onConnected: () => undefined,
  });
  transport.pushOutput('after');

  assert.deepEqual(writes, ['before', 'after']);
});

test('command log transport freezes output after exit', () => {
  const transport = createCommandLogTransport();
  const writes: string[] = [];
  const interactive: boolean[] = [];

  transport.connect({
    write: (data) => writes.push(data),
    setInteractive: (value) => interactive.push(value),
    onConnected: () => undefined,
  });
  transport.pushOutput('before');
  transport.freeze();
  transport.pushOutput('after');

  assert.deepEqual(writes, ['before']);
  assert.deepEqual(interactive, [false, false]);
});
