import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';

import { nodeRuntimeProcessAdapter, ownsRuntimeProcessGroup } from './process-adapter.js';

test('runtime process-group ownership stays POSIX-only and respects inherited development ownership', () => {
  assert.equal(ownsRuntimeProcessGroup('darwin', 'self'), true);
  assert.equal(ownsRuntimeProcessGroup('linux', 'self'), true);
  assert.equal(ownsRuntimeProcessGroup('win32', 'self'), false);
  assert.equal(ownsRuntimeProcessGroup('darwin', 'external'), false);
  assert.equal(ownsRuntimeProcessGroup('win32', 'external'), false);
});

test('runtime escalation sends SIGKILL after SIGTERM marked the child as killed', async () => {
  const child = nodeRuntimeProcessAdapter.spawn({
    command: process.execPath,
    args: [
      '-e',
      "process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setInterval(() => {}, 1000)",
    ],
    cwd: process.cwd(),
    env: process.env,
    processGroupOwnership: 'external',
  });
  try {
    await once(child.stdout, 'data');
    nodeRuntimeProcessAdapter.signal(child, 'SIGTERM');
    assert.equal(child.killed, true);
    nodeRuntimeProcessAdapter.signal(child, 'SIGKILL');
    const [code, signal] = await once(child, 'exit');
    assert.equal(code, null);
    assert.equal(signal, 'SIGKILL');
  } finally {
    if (child.exitCode === null && child.signalCode === null && child.pid) {
      process.kill(child.pid, 'SIGKILL');
    }
  }
});
