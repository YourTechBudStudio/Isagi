import { Bot, CircleDashed, CirclePlus, RotateCw, TriangleAlert } from 'lucide-react';

import type { SessionDiagnosticCode } from '@isagi/contracts';

import { AttentionDot } from '../../components/AttentionDot.js';
import { Button } from '../../components/Button.js';
import {
  agentSessionCopy,
  paneRestoreAttention,
  type PaneRestorePrompt,
} from '../../copy/index.js';

/**
 * Dev-only preview of the agent-pane states.
 *
 * This page is mounted only in development (see App.tsx) so it can never become
 * runtime state. Everything here is presentational: it reproduces the real pane
 * chrome but stands in a faux terminal body instead of a live xterm/websocket.
 * The states mirror `derivePaneView` — a live (attached) pane and the three
 * recovery prompts an agent session can present.
 */

type MockState = PaneRestorePrompt | 'live';

type MockPane = {
  readonly state: MockState;
  readonly title: string;
  readonly caption: string;
  /** The right-aligned header status label. */
  readonly status: string;
  /** The one-line notice bar under the header, when there is one. */
  readonly notice?: string;
  /** Sample diagnostic surfaced verbatim in the recovery prompts. */
  readonly diagnosticCode?: SessionDiagnosticCode;
  readonly diagnosticDetail?: string;
};

const MOCK_PANES: readonly MockPane[] = [
  {
    state: 'live',
    title: 'pi · feat/agent-session-tracking',
    caption:
      'Attached to a live process. The harness is interactive — the work surface is the hero.',
    status: 'Running',
  },
  {
    state: 'resume_available',
    title: 'opencode · chore/runtime-shutdown',
    caption: 'The process stopped, but claim+attach can resume it on command.',
    status: agentSessionCopy.status.resume_available,
    notice: 'The backing process is not running.',
    diagnosticCode: 'pty_process_not_running',
  },
  {
    state: 'resume_failed',
    title: 'codex · feat/internal-ipc',
    caption: 'Resume was attempted and failed. The pane keeps its evidence and offers a retry.',
    status: agentSessionCopy.status.resume_failed,
    notice: 'Could not resume the harness session.',
    diagnosticCode: 'harness_resume_failed',
    diagnosticDetail: 'harness exited 1 while opening session 0b3f… (no such session)',
  },
  {
    state: 'start_fresh',
    title: 'opencode · spike/harness-events',
    caption:
      'No harness session id was ever captured, so claim+attach would fail — only start fresh.',
    status: agentSessionCopy.status.start_fresh,
    notice: 'No harness session was captured for this pane, so a new one will start fresh.',
    diagnosticCode: 'harness_session_id_missing',
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
  const live = state === 'live';
  const attention = live ? 'working' : paneRestoreAttention[state];
  const errored = state === 'resume_failed';
  const dimmed = !live;

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
          {pane.status}
        </span>
      </div>
      {pane.notice ? (
        <div className="border-b border-line/12 px-3 py-1.5 font-mono text-[10.5px] text-fg-subtle">
          {pane.notice}
        </div>
      ) : null}
      {live ? <MockTerminalBody /> : <RestorePromptPreview pane={pane} />}
    </section>
  );
}

/**
 * A calm stand-in for the live xterm surface in the recovery states, mirroring
 * the real `RestorePrompt` in PtySurface.
 */
function RestorePromptPreview({ pane }: { readonly pane: MockPane }) {
  const prompt = pane.state as PaneRestorePrompt;
  const Icon = prompt === 'resume_failed' ? TriangleAlert : CircleDashed;
  const canResume = prompt === 'resume_available' || prompt === 'resume_failed';

  return (
    <div className="grid min-h-0 flex-1 place-items-center px-6 py-5">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <Icon
          size={18}
          aria-hidden
          className={prompt === 'resume_failed' ? 'text-error' : 'text-waiting'}
        />
        <p className="font-mono text-[12px] text-fg-muted">{agentSessionCopy.body[prompt]}</p>
        {pane.diagnosticCode ? (
          <p className="font-mono text-[10.5px] leading-relaxed text-fg-subtle">
            <span className="text-fg-muted">{pane.diagnosticCode}</span>
            {pane.diagnosticDetail ? ` · ${pane.diagnosticDetail}` : null}
          </p>
        ) : null}
        <div className="mt-0.5 flex flex-wrap items-center justify-center gap-2">
          {canResume ? (
            <Button variant="secondary" size="sm" icon={RotateCw}>
              {prompt === 'resume_failed'
                ? agentSessionCopy.action.retry
                : agentSessionCopy.action.resume}
            </Button>
          ) : null}
          <Button variant={canResume ? 'ghost' : 'secondary'} size="sm" icon={CirclePlus}>
            {agentSessionCopy.action.startFresh}
          </Button>
        </div>
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
          {line.text || ' '}
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
