import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type {
  AgentSessionMetadata,
  AgentSessionRecoveryAction,
  HarnessLaunchBlockReason,
  HarnessLaunchProjection,
  SessionDiagnosticCode,
  SessionStatus,
  TerminalSessionMetadata,
} from '@isagi/contracts';

import {
  derivePaneAttachmentIntent,
  derivePaneView,
  ptyPaneSession,
  type PaneConnectionSnapshot,
  type PtyPaneSession,
} from './view.js';

const NO_CONNECTION: PaneConnectionSnapshot = { code: null, attachRequested: false };
const LAUNCHABLE: HarnessLaunchProjection = { status: 'launchable' };
const blocked = (reason: HarnessLaunchBlockReason): HarnessLaunchProjection => ({
  status: 'blocked',
  reason,
});

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
    assert.deepEqual(derivePaneView(null, NO_CONNECTION, LAUNCHABLE), { kind: 'empty' });
  });

  it('mounts the terminal for running and starting agent sessions', () => {
    for (const status of ['running', 'starting'] as const) {
      assert.deepEqual(
        derivePaneView(
          agentSession({ status, recoveryAction: 'connect_existing' }),
          NO_CONNECTION,
          LAUNCHABLE,
        ),
        { kind: 'live' },
      );
    }
  });

  it('treats a stopped agent with valid metadata and no harness session id as attachable', () => {
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
          LAUNCHABLE,
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
        LAUNCHABLE,
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
        LAUNCHABLE,
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
        LAUNCHABLE,
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
        LAUNCHABLE,
      ),
      { kind: 'live' },
    );
  });

  it('never offers a fresh prompt for a create_replacement session, even with attach requested', () => {
    assert.deepEqual(
      derivePaneView(
        agentSession({ status: 'failed', recoveryAction: 'create_replacement' }),
        { code: null, attachRequested: true },
        LAUNCHABLE,
      ),
      { kind: 'needs_fresh' },
    );
  });

  it('keeps stopped terminals live so they relaunch on attach', () => {
    for (const status of ['exited', 'failed', 'killed'] as const) {
      assert.deepEqual(derivePaneView(terminalSession(status), NO_CONNECTION, LAUNCHABLE), {
        kind: 'live',
      });
    }
  });

  it('surfaces the connection-owned states regardless of session status', () => {
    const running = agentSession({ status: 'running', recoveryAction: 'connect_existing' });
    assert.deepEqual(
      derivePaneView(running, { code: 'unsupported_harness', attachRequested: false }, LAUNCHABLE),
      { kind: 'unsupported' },
    );
    assert.deepEqual(
      derivePaneView(
        running,
        { code: 'session_attachment_moved', attachRequested: false },
        LAUNCHABLE,
      ),
      { kind: 'moved' },
    );
  });

  describe('launch policy', () => {
    it('blocks a stopped agent whose harness is disabled behind a close-only state', () => {
      assert.deepEqual(
        derivePaneView(
          agentSession({
            status: 'exited',
            recoveryAction: 'resume_existing',
            harnessSessionId: 'a',
          }),
          NO_CONNECTION,
          blocked('harness_disabled'),
        ),
        { kind: 'blocked', reason: 'harness_disabled' },
      );
    });

    it('routes onboarding and config blocks to the close-only state too', () => {
      for (const reason of ['onboarding_incomplete', 'config_invalid'] as const) {
        assert.deepEqual(
          derivePaneView(
            agentSession({ status: 'failed', recoveryAction: 'relaunch_fresh' }),
            NO_CONNECTION,
            blocked(reason),
          ),
          { kind: 'blocked', reason },
        );
      }
    });

    it('routes availability blocks to the recheckable unavailable state', () => {
      for (const reason of [
        'inventory_pending',
        'harness_missing',
        'harness_incompatible',
        'harness_probe_failed',
      ] as const) {
        assert.deepEqual(
          derivePaneView(
            agentSession({
              status: 'exited',
              recoveryAction: 'resume_existing',
              harnessSessionId: 'a',
            }),
            NO_CONNECTION,
            blocked(reason),
          ),
          { kind: 'unavailable', reason },
        );
      }
    });

    it('turns a blocked create_replacement into blocked, and a launchable one into needs_fresh', () => {
      const session = agentSession({ status: 'failed', recoveryAction: 'create_replacement' });
      assert.deepEqual(derivePaneView(session, NO_CONNECTION, blocked('harness_missing')), {
        kind: 'unavailable',
        reason: 'harness_missing',
      });
      assert.deepEqual(derivePaneView(session, NO_CONNECTION, LAUNCHABLE), { kind: 'needs_fresh' });
    });

    it('never blocks a running process even when its harness is now disabled', () => {
      assert.deepEqual(
        derivePaneView(
          agentSession({ status: 'running', recoveryAction: 'connect_existing' }),
          NO_CONNECTION,
          blocked('harness_disabled'),
        ),
        { kind: 'live' },
      );
    });

    it('never blocks pure attach: connect_existing stays attachable even when blocked', () => {
      // connect_existing does not create a process, so launch policy does not gate
      // it (it normally implies a running process, but the pure function must not
      // gate it regardless).
      assert.deepEqual(
        derivePaneView(
          agentSession({ status: 'exited', recoveryAction: 'connect_existing' }),
          NO_CONNECTION,
          blocked('harness_disabled'),
        ),
        { kind: 'attachable', resumeFailed: false },
      );
    });

    it('never blocks reclaiming a moved attachment', () => {
      assert.deepEqual(
        derivePaneView(
          agentSession({ status: 'running', recoveryAction: 'connect_existing' }),
          { code: 'session_attachment_moved', attachRequested: false },
          blocked('harness_disabled'),
        ),
        { kind: 'moved' },
      );
    });

    it('never blocks a terminal session', () => {
      assert.deepEqual(
        derivePaneView(terminalSession('exited'), NO_CONNECTION, blocked('harness_disabled')),
        {
          kind: 'live',
        },
      );
    });
  });
});

describe('derivePaneAttachmentIntent', () => {
  it('keeps rendering presence after an exit drops connect intent', () => {
    const exited = agentSession({ status: 'exited', recoveryAction: 'resume_existing' });

    // A sealed session: `usePaneSession` has cleared `userAttach` and the runtime no longer
    // reports it running, so nothing wants the transport — but `PtyPane` still mounts the
    // sealed terminal as final output, so the pane must keep its visibility lease.
    assert.deepEqual(derivePaneAttachmentIntent(exited, false), {
      connect: false,
      mounted: true,
    });
  });

  it('asks for transport only while something actually wants to be connected', () => {
    const running = agentSession({ status: 'running', recoveryAction: 'connect_existing' });

    assert.deepEqual(derivePaneAttachmentIntent(running, true), { connect: true, mounted: true });
  });

  it('claims neither for an unbound pane', () => {
    assert.deepEqual(derivePaneAttachmentIntent(null, true), { connect: false, mounted: false });
  });
});

describe('ptyPaneSession', () => {
  it('flattens each PTY-backed kind', () => {
    assert.equal(
      ptyPaneSession({
        kind: 'terminal_session',
        terminalSession: {
          id: 3,
          paneId: 1,
          worktreeId: 1,
          cwd: '/tmp/worktree',
          shellCommand: '/bin/zsh',
          shellArgs: [],
          statusReason: null,
          status: 'running',
          diagnosticCode: null,
          diagnosticDetail: null,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          lastSeenAt: null,
        },
      })?.kind,
      'terminal_session',
    );
  });

  it('excludes an editor context rather than reading it as a terminal', () => {
    // An editor owns no PTY attachment, so it has no flattened session for this
    // domain to return. The pane renders as unbound, which is what an absence of
    // a PTY session has always meant here.
    assert.equal(
      ptyPaneSession({
        kind: 'editor_context',
        editorContext: {
          paneId: 9,
          id: 4,
          worktreeId: 1,
          activePtyProcessId: null,
          attempt: { state: 'none' },
          processStatus: null,
          processDiagnostic: null,
          processDiagnosticDetail: null,
          workbenchReadiness: null,
          readinessDetail: null,
          endpoint: null,
          hasDiagnostics: false,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      }),
      null,
    );
  });

  it('returns null for an unbound pane', () => {
    assert.equal(ptyPaneSession(null), null);
  });
});
