/**
 * Development-only fixtures for the terminal-state gallery.
 *
 * Everything here is invented for review: the transcript is not real output,
 * these strings are not production copy (production copy lives under
 * `src/copy/`), and none of it is reachable from a production build.
 */

export type TerminalFixtureId =
  | 'cold-loading'
  | 'parsed-not-rendered'
  | 'revealed-live'
  | 'warm-reacquisition'
  | 'sealed-stale'
  | 'alternate-screen'
  | 'anchor-trimmed';

export type TerminalBodyKind = 'blank' | 'transcript' | 'trimmed' | 'tui';

export type TerminalFixture = {
  readonly id: TerminalFixtureId;
  readonly label: string;
  /** What a reviewer is being asked to confirm about this state. */
  readonly claim: string;
  readonly revealed: boolean;
  readonly body: TerminalBodyKind;
  readonly attention: 'working' | 'waiting' | 'idle' | 'error';
  readonly notice?: string;
  readonly recovery?: { readonly primary: string; readonly secondary: string };
};

export const TERMINAL_FIXTURES: readonly TerminalFixture[] = [
  {
    id: 'cold-loading',
    label: 'Cold loading',
    claim:
      'First bytes are arriving. The cover is fully opaque — no row, cursor, or scroll motion reaches the user.',
    revealed: false,
    body: 'blank',
    attention: 'working',
  },
  {
    id: 'parsed-not-rendered',
    label: 'Parsed, not rendered',
    claim:
      'Replay is fully parsed and the terminal beneath holds real content — and this must look identical to cold loading, because xterm has not painted yet.',
    revealed: false,
    body: 'transcript',
    attention: 'working',
  },
  {
    id: 'revealed-live',
    label: 'Revealed, live',
    claim: 'xterm reported a render. The cover is gone and the terminal is the hero of the pane.',
    revealed: true,
    body: 'transcript',
    attention: 'idle',
  },
  {
    id: 'warm-reacquisition',
    label: 'Warm reacquisition',
    claim:
      'A hidden-then-revisited terminal. Same xterm, same viewport, no cover and no entrance animation — nothing here should draw the eye at all.',
    revealed: true,
    body: 'transcript',
    attention: 'idle',
  },
  {
    id: 'sealed-stale',
    label: 'Sealed / stale',
    claim:
      'The attachment is sealed. The last faithful display stays intact; the warning and the recovery action sit outside the viewport, never over the history.',
    revealed: true,
    body: 'transcript',
    attention: 'error',
    notice: 'Stream ended — this display is frozen at its last output.',
    recovery: { primary: 'Start fresh', secondary: 'Reconnect' },
  },
  {
    id: 'alternate-screen',
    label: 'Alternate screen',
    claim:
      'A TUI owns the whole screen. No scrollback, no synthetic viewport restoration, no Isagi chrome inside the grid.',
    revealed: true,
    body: 'tui',
    attention: 'working',
  },
  {
    id: 'anchor-trimmed',
    label: 'Anchor trimmed',
    claim:
      'The saved scroll anchor no longer exists, so the terminal lands at the oldest retained history — and says nothing about it. Isagi does not manufacture deleted terminal history, and does not apologise for it either.',
    revealed: true,
    body: 'trimmed',
    attention: 'idle',
  },
];

export const SHORT_TITLE = 'codex · apps/runtime';
export const LONG_TITLE =
  'codex · apps/runtime/src/agent-sessions/harness/skill-content — terminal-presentation-cache';
