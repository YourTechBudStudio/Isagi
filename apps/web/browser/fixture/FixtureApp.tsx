import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Effect } from 'effect';
import { motion } from 'motion/react';
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';

import { zenTransition } from '../../src/lib/motion.js';
import { useTerminalAttachmentResource } from '../../src/lib/workspace/terminal-presentation/context.js';
import { TerminalPresentationProvider } from '../../src/lib/workspace/terminal-presentation/TerminalPresentationProvider.js';
import { sendAgentComposerNewline } from '../../src/routes/workspace/agentComposerKeys.js';
import { PaneTerminal } from '../../src/routes/workspace/PaneTerminal.js';
import type { AnsiRecipe } from './ansi.js';
import { createInstrumentedEnvironment, type FixtureTerminalState } from './instrumentation.js';

const params = new URLSearchParams(location.search);
const renderer = params.get('renderer') === 'dom' ? 'dom' : 'webgl';
const recipe = readRecipe(params.get('recipe'));
const bytes = readNatural(params.get('bytes'), 32 * 1024);
const sessionCount = readNatural(params.get('sessions'), 1);
const maxHiddenSessions = readNonNegative(params.get('maxHidden'), 8);
const maxEstimatedBufferMiB = readNonNegative(params.get('maxMemory'), 64);
const topology = readTopology(params.get('topology'));
// Harness recipes stand in for agent sessions, so they get the same custom-key wiring the
// production pane gives an agent session. An ordinary shell recipe deliberately gets none.
const identityKind = recipe === 'shell' ? 'terminal_session' : 'agent_session';
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const instrumentation = createInstrumentedEnvironment({
  renderer,
  recipe,
  bytes,
  automatic: params.get('manual') !== '1',
});

export function FixtureApp() {
  const [providerMounted, setProviderMounted] = useState(true);
  const counters = useSyncExternalStore(
    instrumentation.subscribe,
    instrumentation.getSnapshot,
    instrumentation.getSnapshot,
  );
  const [inspection, setInspection] = useState<readonly FixtureTerminalState[]>([]);
  return (
    <QueryClientProvider client={queryClient}>
      <main className="h-screen bg-canvas p-4 text-fg" data-browser-terminal-fixture>
        <FixtureControls
          inspect={() => setInspection(instrumentation.inspectTerminals())}
          destroy={() => setProviderMounted(false)}
        />
        <output className="sr-only" data-counters>
          {JSON.stringify(counters)}
        </output>
        <output className="sr-only" data-inspection>
          {JSON.stringify(inspection)}
        </output>
        <output className="sr-only" data-parking-roots>
          {document.querySelectorAll('[data-terminal-parking-root]').length}
        </output>
        {providerMounted ? (
          <TerminalPresentationProvider
            settings={{
              scrollbackLines: 5_000,
              cache: {
                idleTtlMinutes: 180,
                maxHiddenSessions,
                maxEstimatedBufferMiB,
              },
            }}
            environment={instrumentation.environment}
          >
            <FixtureWorkspace />
          </TerminalPresentationProvider>
        ) : (
          <div data-provider-destroyed />
        )}
      </main>
    </QueryClientProvider>
  );
}

function FixtureControls({ inspect, destroy }: { inspect: () => void; destroy: () => void }) {
  const [contextLoss, setContextLoss] = useState<'idle' | 'lost' | 'unavailable'>('idle');
  return (
    <div className="mb-2 flex flex-wrap gap-2">
      <button type="button" onClick={instrumentation.openSocket} data-action="open-socket">
        Open socket
      </button>
      <button type="button" onClick={instrumentation.startReplay} data-action="replay-start">
        Replay start
      </button>
      <button type="button" onClick={instrumentation.sendReplayChunks} data-action="replay-chunks">
        Replay chunks
      </button>
      <button type="button" onClick={instrumentation.endReplay} data-action="replay-end">
        Replay end
      </button>
      <button
        type="button"
        onClick={() => instrumentation.sendLive('held-live-marker')}
        data-action="live-output"
      >
        Live output
      </button>
      <button
        type="button"
        onClick={() => instrumentation.sendAnsi('\u001b[?2026hsync-held-marker')}
        data-action="sync-start"
      >
        Sync start
      </button>
      <button
        type="button"
        onClick={() => instrumentation.sendAnsi('\u001b[?2026l')}
        data-action="sync-end"
      >
        Sync end
      </button>
      <button
        type="button"
        onClick={() => instrumentation.sendAnsi('\u001b[?1049halternate-marker')}
        data-action="alternate-on"
      >
        Alternate on
      </button>
      <button
        type="button"
        onClick={() => instrumentation.sendAnsi('\u001b[?1049l')}
        data-action="alternate-off"
      >
        Alternate off
      </button>
      <button type="button" onClick={() => instrumentation.sendAnsi('\u001b[3J')} data-action="ed3">
        ED3
      </button>
      <button
        type="button"
        onClick={() => instrumentation.sendRecipeStage('enter')}
        data-action="recipe-enter"
      >
        Recipe enter
      </button>
      <button
        type="button"
        onClick={() => instrumentation.sendRecipeStage('redraw')}
        data-action="recipe-redraw"
      >
        Recipe redraw
      </button>
      <button
        type="button"
        onClick={() => instrumentation.sendRecipeStage('exit')}
        data-action="recipe-exit"
      >
        Recipe exit
      </button>
      <button
        type="button"
        onClick={() => instrumentation.startRelocationProbe('[data-destination="target"]')}
        data-action="probe-relocation"
      >
        Probe relocation
      </button>
      <button type="button" onClick={inspect} data-action="inspect">
        Inspect
      </button>
      <button type="button" onClick={destroy} data-action="destroy-provider">
        Destroy provider
      </button>
      <button
        type="button"
        onClick={() => setContextLoss(instrumentation.loseWebglContext() ? 'lost' : 'unavailable')}
        data-action="lose-context"
      >
        Lose context
      </button>
      <output data-context-loss>{contextLoss}</output>
    </div>
  );
}

function FixtureWorkspace() {
  const [visible, setVisible] = useState(true);
  const [sourceVisible, setSourceVisible] = useState(true);
  const [destinationVisible, setDestinationVisible] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [width, setWidth] = useState<'wide' | 'narrow'>('wide');
  const [bottomRailVisible, setBottomRailVisible] = useState(false);
  const [attachmentRequest, setAttachmentRequest] = useState(0);
  const surfaceNavigate = useCallback(() => {
    if (sourceVisible) {
      setSourceVisible(false);
      window.setTimeout(() => setDestinationVisible(true), 0);
    } else {
      setDestinationVisible(false);
      window.setTimeout(() => setSourceVisible(true), 0);
    }
  }, [sourceVisible]);
  const zenNavigate = useCallback(() => {
    if (sourceVisible) {
      setDestinationVisible(true);
      window.requestAnimationFrame(() => setSourceVisible(false));
    } else {
      setSourceVisible(true);
      window.requestAnimationFrame(() => setDestinationVisible(false));
    }
  }, [sourceVisible]);
  return (
    <>
      <div className="mb-2 flex gap-2">
        <button type="button" onClick={() => setVisible((value) => !value)} data-action="toggle">
          Toggle visibility
        </button>
        <button type="button" onClick={surfaceNavigate} data-action="surface-relocate">
          Surface relocate
        </button>
        <button type="button" onClick={zenNavigate} data-action="zen-relocate">
          Zen relocate
        </button>
        <button
          type="button"
          onClick={() => setDestinationVisible(true)}
          data-action="register-overlap"
        >
          Register overlap
        </button>
        <button
          type="button"
          onClick={() => setDestinationVisible(false)}
          data-action="release-overlap"
        >
          Release overlap
        </button>
        <button
          type="button"
          onClick={() => setFocusedIndex((value) => (value === 0 ? 1 : 0))}
          data-action="focus-next"
        >
          Focus next
        </button>
        <button
          type="button"
          onClick={() => setWidth((value) => (value === 'wide' ? 'narrow' : 'wide'))}
          data-action="resize"
        >
          Resize
        </button>
        <button
          type="button"
          onClick={() => setBottomRailVisible((value) => !value)}
          data-action="toggle-bottom-rail"
        >
          Toggle bottom rail
        </button>
        <button
          type="button"
          onClick={() => setAttachmentRequest((value) => value + 1)}
          data-action="reattach"
        >
          Reattach
        </button>
      </div>
      <div className="flex flex-col" style={{ height: 'calc(100vh - 10rem)' }}>
        <motion.div
          layoutId="fixture-canvas"
          transition={zenTransition}
          className="min-h-0 min-w-0 flex-1"
          data-fixture-canvas
        >
          <section
            className="grid h-full min-h-0 min-w-0 grid-cols-2 gap-2"
            style={{
              gridTemplateRows: `repeat(${Math.ceil(sessionCount / 2)}, minmax(0, 1fr))`,
            }}
            data-workspace
          >
            {Array.from({ length: sessionCount }, (_, index) => (
              <FixtureTerminal
                key={index}
                index={index}
                visible={visible}
                sourceVisible={index === 0 ? sourceVisible : true}
                destinationVisible={index === 0 ? destinationVisible : false}
                focused={topology === 'focus' ? focusedIndex === index : index === 0}
                width={width}
                attachmentRequest={attachmentRequest}
              />
            ))}
          </section>
        </motion.div>
        {bottomRailVisible ? <div className="h-16 flex-none" data-bottom-rail /> : null}
      </div>
    </>
  );
}

function FixtureTerminal(input: {
  readonly index: number;
  readonly visible: boolean;
  readonly sourceVisible: boolean;
  readonly destinationVisible: boolean;
  readonly focused: boolean;
  readonly width: 'wide' | 'narrow';
  readonly attachmentRequest: number;
}) {
  const placement = useMemo(
    () => ({ worktreeId: 1, surfaceId: input.index + 1, paneId: input.index + 1 }),
    [input.index],
  );
  const attachment = useTerminalAttachmentResource({
    identity: { kind: identityKind, sessionId: input.index + 1 },
    placement,
    connect: true,
    // Destination topology and cache visibility are separate facts. Surface navigation may
    // briefly have no registered destination while the pane itself remains mounted/visible.
    mounted: input.visible,
    attachmentRequest: input.attachmentRequest,
    initiallyInteractive: true,
    resolveUrl: () => {
      instrumentation.claimAttempt();
      return Effect.succeed(`fixture://terminal/${input.index + 1}`);
    },
    onMilestone: instrumentation.observeMilestone,
    ...(identityKind === 'agent_session' ? { onCustomKey: sendAgentComposerNewline } : {}),
  });
  return (
    <article
      className={`flex min-h-0 min-w-0 flex-col border border-line ${input.width === 'narrow' ? 'w-64' : 'w-full'}`}
      data-session={input.index + 1}
      data-phase={attachment.snapshot.readiness.phase}
      data-renderer-warning={attachment.snapshot.rendererWarning ?? ''}
    >
      {input.visible && attachment.resource && input.sourceVisible ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-destination="source">
          <PaneTerminal
            surfaceId={placement.surfaceId}
            paneId={placement.paneId}
            focused={input.focused && !input.destinationVisible}
            presentation={attachment.resource}
          />
        </div>
      ) : null}
      {input.visible && attachment.resource && input.destinationVisible ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-destination="target">
          <PaneTerminal
            surfaceId={placement.surfaceId}
            paneId={placement.paneId}
            focused={false}
            presentation={attachment.resource}
          />
        </div>
      ) : null}
    </article>
  );
}

function readNatural(value: string | null, fallback: number) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readNonNegative(value: string | null, fallback: number) {
  if (value === null) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function readRecipe(value: string | null): AnsiRecipe {
  return value === 'codex' || value === 'claude' || value === 'pi' || value === 'opencode'
    ? value
    : 'shell';
}

function readTopology(value: string | null) {
  return value === 'focus' ? 'focus' : 'default';
}
