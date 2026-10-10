import assert from 'node:assert/strict';
import test from 'node:test';

import { describeOperationalCause } from '../../platform/diagnostics/index.js';
import {
  PtyInspectError,
  PtyKillError,
  PtyResizeError,
  PtyServiceError,
  PtyStartError,
  PtyTerminationInProgressError,
  PtyWriteError,
} from '../types.js';

/**
 * The PTY errors' half of the trust boundary: each class composes its rendered
 * label from authored fields (stable codes, reasons, and the PTY/worktree
 * identifiers) and never from its own text. The classifier's rules are tested at
 * `platform/diagnostics/operational-cause.test.ts`.
 */

const SENTINEL = 'SUPERSECRETTOKEN12345';
const SESSION_NAME = 'isagi_testruntime_801';

test('every PTY error renders its authored label and coordinates', () => {
  assert.equal(
    describeOperationalCause(
      new PtyStartError({
        command: `/bin/${SENTINEL}`,
        cwd: `/home/${SENTINEL}`,
        reason: 'backend_session_not_live',
        ptyProcessId: 3,
        cause: new Error(SENTINEL),
      }),
    ),
    'PTY start error backend_session_not_live (ptyProcess=3): Error',
  );
  assert.equal(
    describeOperationalCause(
      new PtyStartError({ command: SENTINEL, cwd: SENTINEL, cause: undefined }),
    ),
    'PTY start error',
  );
  assert.equal(
    describeOperationalCause(
      new PtyWriteError({ ptyProcessId: 4, cause: new TypeError(SENTINEL) }),
    ),
    'PTY write error (ptyProcess=4): TypeError',
  );
  assert.equal(
    describeOperationalCause(new PtyResizeError({ ptyProcessId: 5, cause: null })),
    'PTY resize error (ptyProcess=5)',
  );
  assert.equal(
    describeOperationalCause(new PtyKillError({ cause: SENTINEL })),
    'PTY kill error: UnknownError',
  );
  assert.equal(
    describeOperationalCause(new PtyInspectError({ ptyProcessId: 6, cause: new Error(SENTINEL) })),
    'PTY inspect error (ptyProcess=6): Error',
  );
  assert.equal(
    describeOperationalCause(new PtyTerminationInProgressError({ ptyProcessId: 7 })),
    'PTY termination already in progress (ptyProcess=7)',
  );
});

test('a PTY service error renders its code and coordinates, never its message', () => {
  // Two authored messages embed ref-derived values today, so even ours is not read.
  const rendered = describeOperationalCause(
    new PtyServiceError({
      code: 'backend_unavailable',
      message: `Could not replay tmux session ${SESSION_NAME}.`,
      ptyProcessId: 7,
      worktreeId: 9,
    }),
  );
  assert.equal(rendered, 'PTY service error backend_unavailable (ptyProcess=7, worktree=9)');
  assert.ok(!rendered.includes(SESSION_NAME));
});

test('a PTY error beneath another recognized error keeps its label', () => {
  assert.equal(
    describeOperationalCause(
      new PtyKillError({
        ptyProcessId: 801,
        cause: new PtyInspectError({ ptyProcessId: 801, cause: new Error(SENTINEL) }),
      }),
    ),
    'PTY kill error (ptyProcess=801): PTY inspect error (ptyProcess=801): Error',
  );
});
