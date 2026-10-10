import assert from 'node:assert/strict';
import test from 'node:test';

import { HarnessLaunchBlocked } from '../../harnesses/index.js';
import { websocketError } from '../sessions/attach-route.js';
import { sessionLaunchRejection } from '../surfaces/api.js';

test('launch blocks retain stable reasons and diagnostics across HTTP and PTY websocket errors', () => {
  const blocked = new HarnessLaunchBlocked({
    harness: 'codex',
    reason: 'harness_probe_failed',
    diagnostic: 'probe timed out',
  });
  // The route boundary adds the request id.
  assert.deepEqual(sessionLaunchRejection(blocked), {
    code: 'session_launch_rejected',
    status: 400,
    message: 'Harness process creation is blocked: harness_probe_failed.',
    data: { reason: 'harness_probe_failed', diagnostic: 'probe timed out' },
  });
  assert.deepEqual(websocketError(blocked), {
    code: 'harness_probe_failed',
    message: 'Harness process creation is blocked: harness_probe_failed. probe timed out',
  });
});
