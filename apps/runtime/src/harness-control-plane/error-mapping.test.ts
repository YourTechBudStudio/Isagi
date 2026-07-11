import assert from 'node:assert/strict';
import test from 'node:test';

import { websocketError } from '../pty-processes/api.js';
import { toSurfaceApiError } from '../surfaces/api.js';
import { HarnessLaunchBlocked } from './index.js';

test('launch blocks retain stable reasons and diagnostics across HTTP and PTY websocket errors', () => {
  const blocked = new HarnessLaunchBlocked({
    harness: 'codex',
    reason: 'harness_probe_failed',
    diagnostic: 'probe timed out',
  });
  const api = toSurfaceApiError(blocked, {
    endpointId: 'surfaces.createPaneSession',
    requestId: 'request-1',
  });
  assert.deepEqual(api, {
    code: 'session_launch_rejected',
    status: 400,
    message: 'Harness process creation is blocked: harness_probe_failed.',
    requestId: 'request-1',
    data: { reason: 'harness_probe_failed', diagnostic: 'probe timed out' },
  });
  assert.deepEqual(websocketError(blocked), {
    code: 'harness_probe_failed',
    message: 'Harness process creation is blocked: harness_probe_failed. probe timed out',
  });
});
