import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  AgentSessionStatusReason,
  ApiError,
  TerminalSessionStatusReason,
} from '@isagi/contracts';

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

test('session status reasons produce degraded pane status labels', () => {
  assert.equal(ptyCopy.sessionStatus('failed', 'harness_launch_failed', exit()), 'Launch failed');
  assert.equal(ptyCopy.sessionStatus('failed', 'shell_launch_failed', exit()), 'Launch failed');
  assert.equal(ptyCopy.sessionStatus('failed', 'process_attach_failed', exit()), 'Attach failed');
  assert.equal(
    ptyCopy.sessionStatus('failed', 'harness_session_id_missing', exit()),
    'No prior session',
  );
  assert.equal(ptyCopy.sessionStatus('failed', 'harness_resume_failed', exit()), 'Resume failed');
  assert.equal(ptyCopy.sessionStatus('failed', 'pty_process_missing', exit()), 'Process missing');
  assert.equal(
    ptyCopy.sessionStatus('failed', 'pty_process_not_running', exit()),
    'Process not running',
  );
  assert.equal(ptyCopy.sessionStatus('killed', 'harness_process_killed', exit()), 'Killed');
  assert.equal(ptyCopy.sessionStatus('killed', 'shell_killed', exit()), 'Killed');
  assert.equal(ptyCopy.sessionStatus('killed', 'runtime_shutdown', exit()), 'Killed on shutdown');
});

test('session status reasons produce restrained pane notices', () => {
  assert.equal(ptyCopy.sessionNotice('running', null), null);

  const notices: Record<AgentSessionStatusReason | TerminalSessionStatusReason, string | null> = {
    runtime_shutdown: ptyCopy.sessionNotice('killed', 'runtime_shutdown'),
    harness_launch_failed: ptyCopy.sessionNotice('failed', 'harness_launch_failed'),
    shell_launch_failed: ptyCopy.sessionNotice('failed', 'shell_launch_failed'),
    harness_process_exited: ptyCopy.sessionNotice('exited', 'harness_process_exited'),
    shell_exited: ptyCopy.sessionNotice('exited', 'shell_exited'),
    harness_process_killed: ptyCopy.sessionNotice('killed', 'harness_process_killed'),
    shell_killed: ptyCopy.sessionNotice('killed', 'shell_killed'),
    process_attach_failed: ptyCopy.sessionNotice('failed', 'process_attach_failed'),
    harness_session_id_missing: ptyCopy.sessionNotice('failed', 'harness_session_id_missing'),
    harness_resume_failed: ptyCopy.sessionNotice('failed', 'harness_resume_failed'),
    pty_process_missing: ptyCopy.sessionNotice('failed', 'pty_process_missing'),
    pty_process_not_running: ptyCopy.sessionNotice('failed', 'pty_process_not_running'),
  };

  assert.match(notices.runtime_shutdown ?? '', /runtime shut down/);
  assert.match(notices.harness_launch_failed ?? '', /did not launch/);
  assert.match(notices.shell_launch_failed ?? '', /did not launch/);
  assert.equal(notices.harness_process_exited, null);
  assert.equal(notices.shell_exited, null);
  assert.equal(notices.harness_process_killed, null);
  assert.equal(notices.shell_killed, null);
  assert.match(notices.process_attach_failed ?? '', /attach/);
  assert.match(notices.harness_session_id_missing ?? '', /No harness session/);
  assert.match(notices.harness_resume_failed ?? '', /resume/);
  assert.match(notices.pty_process_missing ?? '', /backing process/);
  assert.match(notices.pty_process_not_running ?? '', /not running/);
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
