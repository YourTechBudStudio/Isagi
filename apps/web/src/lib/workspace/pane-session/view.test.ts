import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type {
  AgentSessionMetadata,
  AgentSessionRecoveryAction,
  SessionDiagnosticCode,
  SessionStatus,
  TerminalSessionMetadata,
} from '@isagi/contracts';

import { derivePaneView, type PaneConnectionSnapshot, type PtyPaneSession } from './view.js';

const NO_CONNECTION: PaneConnectionSnapshot = { code: null, attachRequested: false };

function agentSession(overrides: {
  readonly status: SessionStatus;
  readonly recoveryAction: AgentSessionRecoveryAction;
  readonly harnessSessionId?: string | null;
  readonly diagnosticCode?: SessionDiagnosticCode | null;
}): PtyPaneSession {
  return {
    kind: 'agent_session',
    id: 1,
    paneId: 1,
    worktreeId: 1,
    harness: 'pi',
    cwd: '/tmp/worktree',
    harnessSessionId: overrides.harnessSessionId ?? null,
    statusReason: null,
    recoveryAction: overrides.recoveryAction,
    status: overrides.status,
    diagnosticCode: overrides.diagnosticCode ?? null,
    diagnosticDetail: null,
    createdAt: '2026-06-17T00:00:00.000Z',
    updatedAt: '2026-06-17T00:00:00.000Z',
    lastSeenAt: null,
  } satisfies { readonly kind: 'agent_session' } & AgentSessionMetadata;
}

function terminalSession(status: SessionStatus): PtyPaneSession {
  return {
    kind: 'terminal_session',
    id: 2,
    paneId: 1,
    worktreeId: 1,
    cwd: '/tmp/worktree',
    shellCommand: '/bin/zsh',
    shellArgs: [],
    statusReason: null,
    status,
    diagnosticCode: null,
    diagnosticDetail: null,
    createdAt: '2026-06-17T00:00:00.000Z',
    updatedAt: '2026-06-17T00:00:00.000Z',
    lastSeenAt: null,
  } satisfies { readonly kind: 'terminal_session' } & TerminalSessionMetadata;
}

describe('derivePaneView', () => {
  it('is empty without a session', () => {
    assert.deepEqual(derivePaneView(null, NO_CONNECTION), { kind: 'empty' });
  });

  it('mounts the terminal for running and starting agent sessions', () => {
    for (const status of ['running', 'starting'] as const) {
      assert.deepEqual(
        derivePaneView(agentSession({ status, recoveryAction: 'connect_existing' }), NO_CONNECTION),
        { kind: 'live' },
      );
    }
  });

  it('treats a stopped agent with valid metadata and no harness session id as attachable', () => {
    // Process died before a harness session id was captured: claim+attach
    // relaunches fresh in the same durable session.
    for (const status of ['exited', 'failed', 'killed'] as const) {
      assert.deepEqual(
        derivePaneView(
          agentSession({
            status,
            recoveryAction: 'relaunch_fresh',
            harnessSessionId: null,
            diagnosticCode: status === 'failed' ? 'pty_process_missing' : null,
          }),
          NO_CONNECTION,
        ),
        { kind: 'attachable', resumeFailed: false },
      );
    }
  });

  it('goes live for a relaunch_fresh agent session once the user requests attach', () => {
    assert.deepEqual(
      derivePaneView(
        agentSession({
          status: 'failed',
          recoveryAction: 'relaunch_fresh',
          harnessSessionId: null,
          diagnosticCode: 'pty_process_missing',
        }),
        { code: null, attachRequested: true },
      ),
      { kind: 'live' },
    );
  });

  it('is attachable when a stopped agent session can resume', () => {
    assert.deepEqual(
      derivePaneView(
        agentSession({
          status: 'exited',
          recoveryAction: 'resume_existing',
          harnessSessionId: 'abc',
        }),
        NO_CONNECTION,
      ),
      { kind: 'attachable', resumeFailed: false },
    );
  });

  it('marks the attachable prompt as failed when the last resume failed', () => {
    assert.deepEqual(
      derivePaneView(
        agentSession({
          status: 'failed',
          recoveryAction: 'resume_existing',
          harnessSessionId: 'abc',
          diagnosticCode: 'harness_resume_failed',
        }),
        NO_CONNECTION,
      ),
      { kind: 'attachable', resumeFailed: true },
    );
  });

  it('goes live for a resumable agent session once the user requests attach', () => {
    assert.deepEqual(
      derivePaneView(
        agentSession({
          status: 'exited',
          recoveryAction: 'resume_existing',
          harnessSessionId: 'a',
        }),
        { code: null, attachRequested: true },
      ),
      { kind: 'live' },
    );
  });

  it('never offers a fresh prompt for a create_replacement session, even with attach requested', () => {
    assert.deepEqual(
      derivePaneView(agentSession({ status: 'failed', recoveryAction: 'create_replacement' }), {
        code: null,
        attachRequested: true,
      }),
      { kind: 'needs_fresh' },
    );
  });

  it('keeps stopped terminals live so they relaunch on attach', () => {
    for (const status of ['exited', 'failed', 'killed'] as const) {
      assert.deepEqual(derivePaneView(terminalSession(status), NO_CONNECTION), { kind: 'live' });
    }
  });

  it('surfaces the connection-owned states regardless of session status', () => {
    const running = agentSession({ status: 'running', recoveryAction: 'connect_existing' });
    assert.deepEqual(
      derivePaneView(running, { code: 'unsupported_harness', attachRequested: false }),
      { kind: 'unsupported' },
    );
    assert.deepEqual(
      derivePaneView(running, { code: 'session_attachment_moved', attachRequested: false }),
      { kind: 'moved' },
    );
  });
});
