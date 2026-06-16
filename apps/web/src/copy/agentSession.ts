import type { AttentionState } from '../lib/workspace/types.js';

/**
 * The attach/restore states an agent pane can present while a durable agent
 * session sits above its disposable PTY process. These are Phase 1 mock states:
 * copy and shape are reviewed here before the runtime wiring exists.
 *
 *  - running             attached to a live process; the harness is interactive
 *  - connecting          attaching to a process that is already running
 *  - resuming            no live process; recreating one and resuming the session
 *  - resume_unavailable  no harness session id was ever captured; nothing to resume
 *  - resume_failed       resume was attempted and failed; retry is offered
 */
export type AgentPaneRestoreState =
  | 'running'
  | 'connecting'
  | 'resuming'
  | 'resume_unavailable'
  | 'resume_failed';

/**
 * Attention mapping for each restore state. Working states breathe, the
 * "start fresh" prompt waits on the user, a failed resume is a still error.
 */
export const agentPaneAttentionByState: Record<AgentPaneRestoreState, AttentionState> = {
  running: 'working',
  connecting: 'working',
  resuming: 'working',
  resume_unavailable: 'waiting',
  resume_failed: 'error',
};

export const agentSessionCopy = {
  // The compact status that sits right-aligned in the pane header. Dry, since
  // this lives in working chrome the user sees on every attach.
  status: {
    running: 'Running',
    connecting: 'Attaching',
    resuming: 'Resuming',
    resume_unavailable: 'No prior session',
    resume_failed: 'Resume failed',
  } satisfies Record<AgentPaneRestoreState, string>,
  // The one-line notice bar under the header. Only shown when there is
  // something honest to say about the attach.
  notice: {
    connecting: 'Attaching to the live process.',
    resuming: 'No live process. Recreating it and resuming your last session.',
    resume_unavailable:
      'No harness session was captured for this pane, so a new one will start fresh.',
    resume_failed: 'Could not resume the harness session.',
  } satisfies Record<Exclude<AgentPaneRestoreState, 'running'>, string>,
  // The quiet status shown in the work area while there is no live output yet.
  body: {
    connecting: 'Attaching…',
    resuming: 'Resuming your last session…',
    resume_unavailable: 'Nothing to resume yet.',
    resume_failed: 'The harness session did not resume.',
  } satisfies Record<Exclude<AgentPaneRestoreState, 'running'>, string>,
  // Stable diagnostic codes, surfaced verbatim next to any human detail so the
  // state is honest and greppable. These match the runtime diagnostic vocabulary.
  diagnosticCode: {
    resume_unavailable: 'harness_session_id_missing',
    resume_failed: 'harness_resume_failed',
  } satisfies Record<'resume_unavailable' | 'resume_failed', string>,
  action: {
    retry: 'Retry resume',
    startFresh: 'Start a fresh session',
  },
} as const;
