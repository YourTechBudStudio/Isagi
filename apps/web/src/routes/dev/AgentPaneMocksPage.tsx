import { Bot, CircleDashed, History, Link2, RotateCw, Sparkles, TriangleAlert } from 'lucide-react';

import { AttentionDot } from '../../components/AttentionDot.js';
import { Button } from '../../components/Button.js';
import {
  agentPaneAttentionByState,
  agentSessionCopy,
  type AgentPaneRestoreState,
} from '../../copy/index.js';
import type { IconType } from '../../lib/icon.js';

/**
 * Dev-only preview of the agent-pane attach/restore states (plan Phase 1).
 *
 * This page is mounted only in development (see App.tsx) so it can never become
 * runtime state. Everything here is presentational: it reproduces the real pane
 * chrome but stands in a faux terminal body instead of a live xterm/websocket.
 * Delete this folder once the states are reviewed and the runtime wiring lands.
 */

type MockPane = {
  readonly state: AgentPaneRestoreState;
  readonly title: string;
  readonly caption: string;
  /** Sample human-readable diagnostic detail for failed/unavailable states. */
  readonly diagnosticDetail?: string;
};

const MOCK_PANES: readonly MockPane[] = [
  {
    state: 'running',
    title: 'pi · feat/agent-session-tracking',
    caption:
      'Attached to a live process. The harness is interactive — the work surface is the hero.',
  },
  {
    state: 'connecting',
    title: 'pi · feat/agent-session-tracking',
    caption: 'Reopened a pane whose process is already running. We are reattaching the websocket.',
  },
  {
    state: 'resuming',
    title: 'claude · fix/scrollback-render',
    caption:
      'The runtime restarted; the process is gone. We recreate it and resume the last session.',
  },
  {
    state: 'resume_unavailable',
    title: 'opencode · spike/harness-events',
    caption:
      'No harness session id was ever captured, so there is nothing to resume — only start fresh.',
  },
  {
    state: 'resume_failed',
    title: 'codex · feat/internal-ipc',
    caption: 'Resume was attempted and failed. The pane keeps its evidence and offers a retry.',
    diagnosticDetail: 'harness exited 1 while opening session 0b3f… (no such session)',
  },
];

export function AgentPaneMocksPage() {
  return (
    <main className="canvas-atmosphere h-screen overflow-y-auto p-8">
      <div className="mx-auto flex max-w-5xl flex-col gap-8">
        <header className="flex flex-col gap-1.5">
          <p className="font-mono text-[10.5px] tracking-[0.18em] text-fg-subtle uppercase">
            Dev preview
          </p>
          <h1 className="text-[20px] font-semibold text-fg">Agent pane states</h1>
          <p className="max-w-2xl text-[13px] leading-relaxed text-fg-subtle">
            How an agent pane presents while a durable session sits above its disposable PTY
            process. Each state is shown at a normal pane width and a narrow one.
          </p>
          <p className="font-mono text-[10.5px] text-fg-subtle opacity-60">
            {'// mock only — no runtime is wired here'}
          </p>
        </header>

        <div className="flex flex-col gap-7">
          {MOCK_PANES.map((pane) => (
            <section key={pane.state} className="flex flex-col gap-2.5">
              <div className="flex flex-col gap-0.5">
                <h2 className="font-mono text-[12px] text-fg-muted">{pane.state}</h2>
                <p className="text-[12.5px] leading-snug text-fg-subtle">{pane.caption}</p>
              </div>
              <div className="flex flex-col gap-3 lg:flex-row">
                <div className="h-64 min-w-0 flex-1">
                  <MockAgentPane pane={pane} focused />
                </div>
                <div className="h-64 w-full max-w-64 lg:w-64">
                  <MockAgentPane pane={pane} focused={false} />
                </div>
              </div>
            </section>
          ))}
        </div>
      </div>
    </main>
  );
}

function MockAgentPane({ pane, focused }: { readonly pane: MockPane; readonly focused: boolean }) {
  const { state } = pane;
  const attention = agentPaneAttentionByState[state];
  const errored = state === 'resume_failed';
  const dimmed = state === 'resume_unavailable' || state === 'resume_failed';
  const notice = state === 'running' ? null : agentSessionCopy.notice[state];

  return (
    <section
      aria-label={pane.title}
      className={`group relative flex h-full min-w-0 flex-col overflow-hidden rounded-md border bg-elevated/50 backdrop-blur-sm transition-opacity duration-ui ease-expo ${
        focused ? 'opacity-100' : 'opacity-55'
      } ${errored ? 'border-error/35' : focused ? 'border-blue/40' : 'border-line/20'} ${
        dimmed ? 'bg-elevated/38' : ''
      }`}
    >
      <div className="flex min-h-9 items-center gap-2 border-b border-line/15 px-3 py-2">
        <Bot size={13} className="text-fg-subtle" />
        <AttentionDot state={attention} />
        <span className="truncate font-mono text-[11.5px] text-fg-muted">{pane.title}</span>
        <span className="ml-auto truncate font-mono text-[10.5px] text-fg-subtle">
          {agentSessionCopy.status[state]}
        </span>
      </div>
      {notice ? (
        <div className="border-b border-line/12 px-3 py-1.5 font-mono text-[10.5px] text-fg-subtle">
          {notice}
        </div>
      ) : null}
      {state === 'running' ? (
        <MockTerminalBody />
      ) : (
        <RestoreStatus state={state} diagnosticDetail={pane.diagnosticDetail} />
      )}
    </section>
  );
}

/** Per-state indicator icon and tone. Working states breathe (opacity pulse);
 *  the still states hold steady. */
const RESTORE_INDICATOR: Record<
  Exclude<AgentPaneRestoreState, 'running'>,
  { readonly icon: IconType; readonly className: string }
> = {
  connecting: { icon: Link2, className: 'text-working animate-breathe' },
  resuming: { icon: History, className: 'text-working animate-breathe' },
  resume_unavailable: { icon: CircleDashed, className: 'text-waiting' },
  resume_failed: { icon: TriangleAlert, className: 'text-error' },
};

/**
 * A calm stand-in for the live xterm surface in non-running states. Working
 * states get a slow ambient pulse; the still states sit quiet with their
 * diagnostic and the affordance that moves the user forward.
 */
function RestoreStatus({
  state,
  diagnosticDetail,
}: {
  readonly state: Exclude<AgentPaneRestoreState, 'running'>;
  readonly diagnosticDetail?: string | undefined;
}) {
  const indicator = RESTORE_INDICATOR[state];
  const diagnosticCode =
    state === 'resume_unavailable' || state === 'resume_failed'
      ? agentSessionCopy.diagnosticCode[state]
      : null;

  return (
    <div className="grid min-h-0 flex-1 place-items-center px-6 py-5">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <indicator.icon size={18} aria-hidden className={indicator.className} />
        <p className="font-mono text-[12px] text-fg-muted">{agentSessionCopy.body[state]}</p>
        {diagnosticCode ? (
          <p className="font-mono text-[10.5px] leading-relaxed text-fg-subtle">
            <span className="text-fg-muted">{diagnosticCode}</span>
            {diagnosticDetail ? ` · ${diagnosticDetail}` : null}
          </p>
        ) : null}
        {state === 'resume_failed' ? (
          <div className="mt-0.5 flex flex-wrap items-center justify-center gap-2">
            <Button variant="secondary" size="sm" icon={RotateCw}>
              {agentSessionCopy.action.retry}
            </Button>
            <Button variant="ghost" size="sm" icon={Sparkles}>
              {agentSessionCopy.action.startFresh}
            </Button>
          </div>
        ) : null}
        {state === 'resume_unavailable' ? (
          <Button variant="secondary" size="sm" icon={Sparkles}>
            {agentSessionCopy.action.startFresh}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** Faux agent output — decoration only, kept quiet so it never competes. */
function MockTerminalBody() {
  return (
    <div className="min-h-0 flex-1 overflow-hidden px-3 py-2.5 font-mono text-[11.5px] leading-relaxed text-fg-muted">
      {MOCK_TERMINAL_LINES.map((line) => (
        <div key={line.id} className={line.className}>
          {line.text || ' '}
        </div>
      ))}
    </div>
  );
}

const MOCK_TERMINAL_LINES: readonly { id: number; text: string; className?: string }[] = [
  { id: 0, text: 'pi 1.4.0  ·  worktree feat/agent-session-tracking', className: 'text-fg-subtle' },
  { id: 1, text: '' },
  { id: 2, text: '> summarize the changes on this branch', className: 'text-fg' },
  { id: 3, text: '' },
  { id: 4, text: 'reading 6 files…', className: 'text-fg-subtle' },
  {
    id: 5,
    text: 'This branch decouples the durable agent session from the PTY process that',
  },
  { id: 6, text: 'backs it, so a pane survives a runtime restart and reattaches on open.' },
  { id: 7, text: '' },
  { id: 8, text: '> _', className: 'text-fg' },
];
