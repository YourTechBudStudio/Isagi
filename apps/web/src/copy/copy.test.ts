import assert from 'node:assert/strict';
import test from 'node:test';

import type { ApiError, PtySessionStatusReason } from '@isagi/contracts';

import { ptyCopy, runtimeErrorCopy } from './index.js';

test('surface API error reasons map to web-owned copy', () => {
  assert.equal(
    runtimeErrorCopy.fromApiError(surfaceRejected('surface_not_found')),
    "That surface isn't here anymore.",
  );
  assert.equal(
    runtimeErrorCopy.fromApiError(surfaceRejected('pane_not_found')),
    "That pane isn't here anymore.",
  );
  assert.equal(
    runtimeErrorCopy.fromApiError(surfaceRejected('invalid_surface_title')),
    "That surface title won't work.",
  );
});

test('PTY status reasons produce degraded pane status labels', () => {
  assert.equal(
    ptyCopy.sessionStatus('running', 'backend_unavailable', exit()),
    'Backend unavailable',
  );
  assert.equal(
    ptyCopy.sessionStatus('failed', 'backend_session_missing', exit()),
    'Session missing',
  );
  assert.equal(
    ptyCopy.sessionStatus('failed', 'runtime_ephemeral_lost', exit()),
    'Runtime session lost',
  );
  assert.equal(ptyCopy.sessionStatus('failed', 'backend_launch_failed', exit()), 'Launch failed');
  assert.equal(ptyCopy.sessionStatus('failed', 'backend_attach_failed', exit()), 'Attach failed');
  assert.equal(ptyCopy.sessionStatus('killed', 'user_requested', exit()), 'Killed');
  assert.equal(ptyCopy.sessionStatus('killed', 'runtime_shutdown', exit()), 'Killed on shutdown');
});

test('PTY status reasons produce restrained pane notices', () => {
  assert.equal(ptyCopy.sessionNotice('running', null), null);

  const notices: Record<PtySessionStatusReason, string | null> = {
    user_requested: ptyCopy.sessionNotice('killed', 'user_requested'),
    runtime_shutdown: ptyCopy.sessionNotice('killed', 'runtime_shutdown'),
    backend_unavailable: ptyCopy.sessionNotice('running', 'backend_unavailable'),
    backend_session_missing: ptyCopy.sessionNotice('failed', 'backend_session_missing'),
    backend_attach_failed: ptyCopy.sessionNotice('failed', 'backend_attach_failed'),
    backend_launch_failed: ptyCopy.sessionNotice('failed', 'backend_launch_failed'),
    runtime_ephemeral_lost: ptyCopy.sessionNotice('failed', 'runtime_ephemeral_lost'),
  };

  assert.equal(notices.user_requested, null);
  assert.match(notices.runtime_shutdown ?? '', /runtime shut down/);
  assert.match(notices.backend_unavailable ?? '', /runtime/);
  assert.match(notices.backend_session_missing ?? '', /backend session/);
  assert.match(notices.backend_attach_failed ?? '', /attach/);
  assert.match(notices.backend_launch_failed ?? '', /did not launch/);
  assert.match(notices.runtime_ephemeral_lost ?? '', /runtime memory/);
});

function surfaceRejected(reason: 'surface_not_found' | 'pane_not_found' | 'invalid_surface_title') {
  return {
    code: 'surface_rejected',
    status: 400,
    message: 'diagnostic message from runtime',
    requestId: 'copy-test',
    data: { reason },
  } satisfies ApiError;
}

function exit() {
  return { exitCode: null, signal: null };
}
