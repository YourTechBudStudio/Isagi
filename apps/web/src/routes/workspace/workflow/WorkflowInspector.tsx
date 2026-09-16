import { motion } from 'motion/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { WorkflowRunSummary } from '@isagi/contracts';

import { surfaceTransition } from '../../../lib/motion.js';
import {
  useWorkflowExecutionOperations,
  useWorkflowRunState,
  useWorkflowStructureQuery,
} from '../../../lib/workspace/workflow/queries.js';
import { WorkflowStructureStaleError } from '../../../lib/workspace/workflow/structure.js';
import { aggregateVisits, emptyAggregation, type VisitAggregation } from './aggregate.js';
import { executionAddressKey } from './ancestry.js';
import { inspectorCopy } from './copy.js';
import { buildDockView } from './dock.js';
import { dockMaxHeight, dockMinHeight } from './format.js';
import { selectionResolves, selectedExecutionId, type InspectorSelection } from './selection.js';
import { buildTopology } from './topology.js';
import { buildTraceModel } from './trace.js';
import type { LayoutEngineFactory } from './useGraphLayout.js';
import { useRunClock } from './useRunClock.js';
import { WorkflowDeclaredCanvas } from './WorkflowDeclaredCanvas.js';
import { WorkflowDock } from './WorkflowDock.js';
import { WorkflowInspectorHeader } from './WorkflowInspectorHeader.js';
import { WorkflowTraceWaterfall } from './WorkflowTraceWaterfall.js';

/**
 * The read-only inspector, opened from the workflow bar and closed with Escape.
 *
 * Two tabs answering two different questions — Declared is a snapshot of the pin the run is on now,
 * Trace is the record of what actually ran — over one shared dock. Mounting this is what starts the
 * run's coordinator, so the expensive half of inspection costs nothing until somebody looks.
 *
 * It drives nothing. There is no Pause, Resume, Retry, Cancel, Dismiss or Advance here, no gate form
 * and no per-node action; the bar stays reachable behind the overlay and remains the only place a
 * person acts on a run.
 */
export function WorkflowInspector({
  summary,
  bottomInset,
  onClose,
  engineFactory,
}: {
  readonly summary: WorkflowRunSummary;
  /**
   * How much room to leave at the bottom for the workflow bar.
   *
   * The overlay stops above the bar instead of covering it. That is what keeps the bar the only
   * action surface *and* a reachable one: a person can answer a question, pause or cancel while
   * looking at the graph, and a keyboard user is never shut away from the controls they need.
   */
  readonly bottomInset: number;
  readonly onClose: () => void;
  /** Swappable so a test can drive the layout protocol without a real engine. */
  readonly engineFactory?: LayoutEngineFactory | undefined;
}) {
  const runId = summary.runId;
  const state = useWorkflowRunState(runId);
  const [tab, setTab] = useState<'declared' | 'trace'>('declared');
  const [selection, setSelection] = useState<InspectorSelection | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [collapsedTraceRows, setCollapsedTraceRows] = useState<ReadonlySet<number>>(
    () => new Set(),
  );
  const [dockHeight, setDockHeight] = useState(340);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const aggregationRef = useRef<VisitAggregation | null>(null);

  /**
   * The run's own facts, preferred over the bar's copy of them.
   *
   * Two summaries reach this component: the attached-run cache the bar reads, kept up to date by
   * surface-level bookkeeping, and the projection's own, applied from revision-ordered deltas. They
   * are the same run and can be momentarily out of step — a `retry_pin_adopted` delta moves the
   * projection's pin immediately, and nothing obliges the surface cache to have heard yet.
   *
   * Revision decides, exactly as it does inside the projection itself: whichever summary describes
   * the later committed state is the one on screen, so the header and the graph cannot disagree
   * about which definition they are showing. A tie goes to the bar's copy, because a run that has
   * just re-attached has a freshly delivered snapshot and a projection still being rebuilt.
   */
  const projected = state?.summary ?? null;
  const runSummary =
    projected !== null && projected.revision > summary.revision ? projected : summary;
  const live = runSummary.endedAt === null;
  const now = useRunClock(live);

  // The pin the run is on now: the hash on whichever summary won above, so the graph is drawn under
  // the same definition the header names. Reading it from the projection independently would put the
  // two back in disagreement the moment they were briefly out of step. The response is validated
  // against it and stored under the hash it reports about itself; a mismatch is a signal to re-key,
  // not a failure to retry.
  const structure = useWorkflowStructureQuery(runId, runSummary.artifactHash);
  const stale = structure.error instanceof WorkflowStructureStaleError;

  const topology = useMemo(
    () => (structure.data ? buildTopology(structure.data.descriptor) : null),
    [structure.data],
  );

  const aggregation = useMemo(() => {
    if (state === null) return emptyAggregation(now);
    const next = aggregateVisits({ state, topology, now, previous: aggregationRef.current });
    aggregationRef.current = next;
    return next;
  }, [state, topology, now]);

  const traceModel = useMemo(
    // Deliberately not keyed on the clock: the model is recorded history, and applying the clock to
    // it every second would rebuild every row of a run's whole past once a second.
    () => (state === null ? null : buildTraceModel({ state, collapsed: collapsedTraceRows })),
    [state, collapsedTraceRows],
  );

  const liveKey = useMemo(() => {
    if (!state || !runSummary.activeNode) return null;
    const execution = state.executions.get(runSummary.activeNode.executionId);
    return execution ? executionAddressKey(state, execution) : null;
  }, [state, runSummary.activeNode]);

  // A selection that no longer resolves would describe one state's visit under another's heading.
  useEffect(() => {
    if (!selectionResolves(selection, state)) setSelection(null);
  }, [selection, state]);

  /**
   * The inspector opens on something rather than on an empty dock.
   *
   * Where the run is now is what a person came to look at, so that is the seed: the live visit if
   * there is one, and otherwise the last thing that ran. A third of the overlay saying "select
   * something" is a third of the overlay saying nothing.
   *
   * A run with no executions at all — one whose graph setup threw — falls back to the root frame,
   * which is the only thing that happened and the only thing worth showing.
   */
  useEffect(() => {
    if (selection !== null || state === null || !state.hydrated) return;
    const liveExecution = runSummary.activeNode?.executionId ?? null;
    const seed =
      liveExecution !== null && state.executions.has(liveExecution)
        ? liveExecution
        : state.executionOrder.at(-1);
    if (seed !== undefined) {
      setSelection({ kind: 'execution', executionId: seed });
      return;
    }
    const root = [...state.frames.values()].find((frame) => frame.parentExecutionId === null);
    if (root) setSelection({ kind: 'frame_segment', frameId: root.frameId, segment: 'entry' });
  }, [selection, state, runSummary.activeNode]);

  // Transient inspector state belongs to the run it was made against.
  useEffect(() => {
    setSelection(null);
    setExpanded(new Set());
    setCollapsedTraceRows(new Set());
  }, [runId]);

  const dockView = useMemo(
    () => (state === null ? null : buildDockView({ selection, state, topology, now })),
    [selection, state, topology, now],
  );
  const operations = useWorkflowExecutionOperations(state, selectedExecutionId(selection, state));

  /**
   * Focus moves into the overlay on open and back where it came from on close.
   *
   * "Back where it came from" is the Inspect toggle in practice, and reading it from the document
   * rather than being handed a ref is what keeps that true however the inspector was opened.
   */
  useEffect(() => {
    const opener = document.activeElement;
    closeRef.current?.focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    },
    [onClose],
  );

  const toggleExpanded = useCallback((key: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);

  const toggleTraceRow = useCallback((executionId: number) => {
    setCollapsedTraceRows((current) => {
      const next = new Set(current);
      if (!next.delete(executionId)) next.add(executionId);
      return next;
    });
  }, []);

  const clampDock = useCallback((height: number) => {
    setDockHeight(Math.min(dockMaxHeight, Math.max(dockMinHeight, height)));
  }, []);

  return (
    <>
      {/* The bar stays below the scrim and remains operable: the overlay hides the work surface, not
          the only place a person can answer a question or stop a run. */}
      <motion.div
        aria-hidden
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={surfaceTransition}
        className="absolute inset-x-0 top-0 z-20 bg-scrim/66 backdrop-blur-xs"
        style={{ bottom: bottomInset }}
        onClick={onClose}
      />
      <motion.div
        role="dialog"
        aria-modal="false"
        aria-label={`${inspectorCopy.title}: ${runSummary.title}`}
        initial={{ opacity: 0, scale: 0.985, y: 6 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.985, y: 6 }}
        transition={surfaceTransition}
        onKeyDown={onKeyDown}
        style={{ bottom: bottomInset + 8 }}
        className="absolute inset-x-4 top-4 z-30 flex flex-col overflow-hidden rounded-md border border-line/42 bg-elevated/97 shadow-lift backdrop-blur-xl"
      >
        <WorkflowInspectorHeader
          summary={runSummary}
          now={now}
          closeRef={closeRef}
          onClose={onClose}
        />

        <div className="flex flex-none items-center gap-3.5 border-b border-line/20 px-4.5 py-2">
          <div
            role="tablist"
            aria-label={inspectorCopy.title}
            className="flex gap-0.5 rounded-lg border border-line/28 bg-elevated/70 p-0.5"
          >
            <TabButton active={tab === 'declared'} onClick={() => setTab('declared')}>
              {inspectorCopy.declaredTab}
            </TabButton>
            <TabButton active={tab === 'trace'} onClick={() => setTab('trace')}>
              {inspectorCopy.traceTab}
            </TabButton>
          </div>
          <p className="font-mono text-[11px] text-fg-subtle opacity-70">
            {tab === 'declared' ? inspectorCopy.declaredHint : inspectorCopy.traceHint}
          </p>
        </div>

        <div className="flex min-h-0 flex-1 flex-col">
          {tab === 'declared' ? (
            stale || structure.isPending ? (
              // Nothing renders under the old pin, not even for a frame. The run has been asked to
              // catch up and this re-keys when it does; it is not an error and offers no retry.
              <div className="grid min-h-0 flex-1 place-items-center bg-canvas/55">
                <p className="font-mono text-[12px] text-fg-subtle">{inspectorCopy.catchingUp}</p>
              </div>
            ) : structure.error ? (
              <div className="grid min-h-0 flex-1 place-items-center bg-canvas/55">
                <div className="max-w-sm rounded-lg border border-error/40 bg-error/5 px-3 py-2.5 text-center">
                  <p className="text-[12.5px] text-fg-muted">{inspectorCopy.structureFailed}</p>
                  <button
                    type="button"
                    onClick={() => void structure.refetch()}
                    className="mt-1.5 rounded-md bg-white/6 px-2.5 py-1 font-mono text-[11px] text-fg-muted transition duration-micro ease-expo hover:bg-white/10"
                  >
                    {inspectorCopy.structureRetry}
                  </button>
                </div>
              </div>
            ) : topology ? (
              <WorkflowDeclaredCanvas
                topology={topology}
                artifactHash={structure.data.artifactHash}
                aggregation={aggregation}
                liveKey={liveKey}
                selection={selection}
                onSelect={setSelection}
                expanded={expanded}
                onToggleExpanded={toggleExpanded}
                engineFactory={engineFactory}
              />
            ) : null
          ) : traceModel ? (
            <WorkflowTraceWaterfall
              model={traceModel}
              now={now}
              selection={selection}
              liveExecutionId={runSummary.activeNode?.executionId ?? null}
              onSelect={setSelection}
              onToggleExpanded={toggleTraceRow}
            />
          ) : null}

          <WorkflowDock
            view={dockView}
            runId={runId}
            operations={operations}
            height={dockHeight}
            onHeightChange={clampDock}
            onSelect={setSelection}
          />
        </div>
      </motion.div>
    </>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  readonly active: boolean;
  readonly onClick: () => void;
  readonly children: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`rounded-md px-3.5 py-1 text-[12.5px] transition duration-micro ease-expo ${
        active ? 'bg-blue font-semibold text-scrim' : 'text-fg-subtle hover:text-fg'
      }`}
    >
      {children}
    </button>
  );
}
