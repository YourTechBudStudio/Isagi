import { motion } from 'motion/react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import type { WorkflowCheckpointSummaryDto, WorkflowRunSummary } from '@isagi/contracts';

import { surfaceTransition } from '../../../lib/motion.js';
import {
  useWorkflowExecutionQuery,
  useWorkflowRunView,
  useWorkflowStructureQuery,
} from '../../../lib/workspace/workflow/queries.js';
import { aggregateVisits, emptyAggregation } from './aggregate.js';
import { executionAddressKey } from './ancestry.js';
import { inspectorCopy } from './copy.js';
import { buildDockView } from './dock.js';
import { dockMaxHeight, dockMinHeight } from './format.js';
import { tabStep } from './list-navigation.js';
import {
  selectionResolves,
  selectedExecutionId,
  type InspectorSelection,
  type InspectorTab,
} from './selection.js';
import { buildTopology } from './topology.js';
import { buildTraceModel } from './trace.js';
import type { LayoutEngineFactory } from './useGraphLayout.js';
import { useRunClock } from './useRunClock.js';
import { WorkflowCheckpointsPanel } from './WorkflowCheckpointsPanel.js';
import { WorkflowDeclaredCanvas } from './WorkflowDeclaredCanvas.js';
import { WorkflowDock } from './WorkflowDock.js';
import { WorkflowInspectorHeader } from './WorkflowInspectorHeader.js';
import { WorkflowTraceWaterfall } from './WorkflowTraceWaterfall.js';

/**
 * The read-only inspector, opened from the workflow bar and closed with Escape.
 *
 * Three tabs answering three different questions — Declared is the build the run is on now, Trace
 * is the record of what actually ran, and Checkpoints is what an export of each saved checkpoint
 * would contain — over one shared dock. Mounting this is what reads the run's tree and event log,
 * so inspection costs nothing until somebody looks.
 *
 * It drives nothing. There is no Pause, Resume, Retry, Cancel, Dismiss or Advance here; the bar
 * stays reachable behind the overlay and remains the only place a person acts on a run.
 */
export function WorkflowInspector({
  summary,
  bottomInset,
  onClose,
  engineFactory,
}: {
  readonly summary: WorkflowRunSummary;
  /**
   * How much room to leave at the bottom for the workflow bar, so a person can answer a question,
   * pause or cancel while looking at the graph.
   */
  readonly bottomInset: number;
  readonly onClose: () => void;
  /** Swappable so a test can drive the layout protocol without a real engine. */
  readonly engineFactory?: LayoutEngineFactory | undefined;
}) {
  const runId = summary.runId;
  const runRead = useWorkflowRunView(runId);
  const view = runRead.view;
  const [tab, setTab] = useState<InspectorTab>('declared');
  /** The Checkpoints tab's choice, held here so it survives the tab being closed. */
  const [chosenCheckpointId, setChosenCheckpointId] = useState<number | null>(null);
  const [selection, setSelection] = useState<InspectorSelection | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [collapsedTraceRows, setCollapsedTraceRows] = useState<ReadonlySet<number>>(
    () => new Set(),
  );
  const [dockHeight, setDockHeight] = useState(340);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  /**
   * The bar's summary and the run detail's describe the same run and are both written by the latest
   * push or refetch, so either may be a moment ahead. The detail's is used once it is here, so the
   * header and the graph name the same build.
   */
  const runSummary = view?.run ?? summary;
  const live = runSummary.endedAt === null;
  const now = useRunClock(live);

  const structure = useWorkflowStructureQuery(runId, runSummary.artifactHash);
  const topology = useMemo(
    () => (structure.data ? buildTopology(structure.data.descriptor) : null),
    [structure.data],
  );

  const aggregation = useMemo(
    () => (view === null ? emptyAggregation(now) : aggregateVisits({ view, topology, now })),
    [view, topology, now],
  );

  const traceModel = useMemo(
    // Not keyed on the clock: the model is recorded history.
    () => (view === null ? null : buildTraceModel({ view, collapsed: collapsedTraceRows })),
    [view, collapsedTraceRows],
  );

  const liveExecutionId = runSummary.current?.executionId ?? null;
  const liveKey = useMemo(() => {
    if (!view || liveExecutionId === null) return null;
    const execution = view.executions.get(liveExecutionId);
    return execution ? executionAddressKey(view, execution) : null;
  }, [view, liveExecutionId]);

  // A selection that no longer resolves would describe one run's execution under another's heading.
  useEffect(() => {
    if (!selectionResolves(selection, view)) setSelection(null);
  }, [selection, view]);

  /**
   * The inspector opens on something rather than on an empty dock: the live execution if there is
   * one, otherwise the last thing that ran, otherwise the root graph.
   */
  useEffect(() => {
    if (selection !== null || view === null) return;
    const seed =
      liveExecutionId !== null && view.executions.has(liveExecutionId)
        ? liveExecutionId
        : view.executionOrder.at(-1);
    if (seed !== undefined) {
      setSelection({ kind: 'execution', executionId: seed });
      return;
    }
    if (view.rootInvocationId !== null) {
      setSelection({ kind: 'invocation', invocationId: view.rootInvocationId });
    }
  }, [selection, view, liveExecutionId]);

  // Transient inspector state belongs to the run it was made against.
  useEffect(() => {
    setSelection(null);
    setExpanded(new Set());
    setCollapsedTraceRows(new Set());
    setChosenCheckpointId(null);
  }, [runId]);

  const execution = useWorkflowExecutionQuery(selectedExecutionId(selection, view));
  const detail = execution.data ?? null;

  const dockView = useMemo(
    () => (view === null ? null : buildDockView({ selection, view, topology, detail, now })),
    [selection, view, topology, detail, now],
  );

  const selectCheckpoint = useCallback((checkpoint: WorkflowCheckpointSummaryDto) => {
    setChosenCheckpointId(checkpoint.checkpointId);
    // The dock follows the checkpoint to the execution that saved it.
    setSelection({ kind: 'execution', executionId: checkpoint.executionId });
  }, []);

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

  /** A tab chosen from the strip, by click or by key: the two are one activation. */
  const activateTab = useCallback((next: InspectorTab) => {
    setTab(next);
  }, []);

  const tabIds = useId();
  const panelId = `${tabIds}-panel`;
  const tabId = (value: InspectorTab) => `${tabIds}-${value}`;

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
          <InspectorTabList tab={tab} tabId={tabId} panelId={panelId} onActivate={activateTab} />
          <p className="font-mono text-[11px] text-fg-subtle opacity-70">
            {tab === 'declared'
              ? inspectorCopy.declaredHint
              : tab === 'trace'
                ? inspectorCopy.traceHint
                : inspectorCopy.checkpointsHint}
          </p>
        </div>

        {/* One panel, relabelled by whichever tab is active: only the active tab's content is ever
            mounted, and the dock below it is part of what that tab shows. */}
        <div
          id={panelId}
          role="tabpanel"
          aria-labelledby={tabId(tab)}
          className="flex min-h-0 flex-1 flex-col"
        >
          {view === null ? (
            // Nothing to draw until the run itself is read. A failed read says so rather than
            // leaving the tabs to present an empty run as a complete record.
            <RunReadState failed={runRead.runError != null} onRetry={runRead.retry} />
          ) : (
            <>
              <ReadWarnings
                runStale={runRead.runError != null}
                eventsMissing={runRead.eventsError != null}
                onRetry={runRead.retry}
              />
              {tab === 'declared' ? (
                structure.isPending ? (
                  <div className="grid min-h-0 flex-1 place-items-center bg-canvas/55">
                    <p className="font-mono text-[12px] text-fg-subtle">
                      {inspectorCopy.readingStructure}
                    </p>
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
              ) : tab === 'checkpoints' ? (
                <WorkflowCheckpointsPanel
                  runId={runId}
                  view={view}
                  chosenId={chosenCheckpointId}
                  dockCheckpointId={dockView?.checkpoint?.checkpointId ?? null}
                  onSeed={setChosenCheckpointId}
                  onSelect={selectCheckpoint}
                />
              ) : traceModel ? (
                <WorkflowTraceWaterfall
                  model={traceModel}
                  now={now}
                  selection={selection}
                  liveExecutionId={liveExecutionId}
                  onSelect={setSelection}
                  onToggleExpanded={toggleTraceRow}
                />
              ) : null}

              <WorkflowDock
                view={dockView}
                execution={{
                  detail,
                  isLoading: execution.isLoading,
                  error: execution.error,
                  retry: () => void execution.refetch(),
                }}
                height={dockHeight}
                onHeightChange={clampDock}
                onSelect={setSelection}
              />
            </>
          )}
        </div>
      </motion.div>
    </>
  );
}

const tabOrder: readonly { readonly value: InspectorTab; readonly label: string }[] = [
  { value: 'declared', label: inspectorCopy.declaredTab },
  { value: 'trace', label: inspectorCopy.traceTab },
  { value: 'checkpoints', label: inspectorCopy.checkpointsTab },
];

/**
 * The tab strip, as a WAI-ARIA tablist.
 *
 * One tab stop: only the active tab is in the tab order. Left and Right wrap, Home and End go to the
 * ends, and focus and activation move together, so an arrow press both focuses and opens a tab.
 */
function InspectorTabList({
  tab,
  tabId,
  panelId,
  onActivate,
}: {
  readonly tab: InspectorTab;
  readonly tabId: (value: InspectorTab) => string;
  readonly panelId: string;
  readonly onActivate: (value: InspectorTab) => void;
}) {
  const buttons = useRef(new Map<InspectorTab, HTMLButtonElement>());
  const index = tabOrder.findIndex((entry) => entry.value === tab);

  return (
    <div
      role="tablist"
      aria-label={inspectorCopy.title}
      className="flex gap-0.5 rounded-lg border border-line/28 bg-elevated/70 p-0.5"
      onKeyDown={(event) => {
        const next = tabStep(event.key, index, tabOrder.length);
        if (next === null) return;
        event.preventDefault();
        const value = tabOrder[next]!.value;
        onActivate(value);
        buttons.current.get(value)?.focus();
      }}
    >
      {tabOrder.map((entry) => (
        <TabButton
          key={entry.value}
          ref={(element) => {
            if (element) buttons.current.set(entry.value, element);
            else buttons.current.delete(entry.value);
          }}
          id={tabId(entry.value)}
          panelId={panelId}
          active={entry.value === tab}
          onClick={() => onActivate(entry.value)}
        >
          {entry.label}
        </TabButton>
      ))}
    </div>
  );
}

function TabButton({
  ref,
  id,
  panelId,
  active,
  onClick,
  children,
}: {
  readonly ref: React.Ref<HTMLButtonElement>;
  readonly id: string;
  readonly panelId: string;
  readonly active: boolean;
  readonly onClick: () => void;
  readonly children: string;
}) {
  return (
    <button
      ref={ref}
      type="button"
      id={id}
      role="tab"
      aria-selected={active}
      aria-controls={active ? panelId : undefined}
      tabIndex={active ? 0 : -1}
      onClick={onClick}
      className={`rounded-md px-3.5 py-1 text-[12.5px] transition duration-micro ease-expo ${
        active ? 'bg-blue font-semibold text-scrim' : 'text-fg-subtle hover:text-fg'
      }`}
    >
      {children}
    </button>
  );
}

/** The run could not be read, or has not been yet. */
function RunReadState({
  failed,
  onRetry,
}: {
  readonly failed: boolean;
  readonly onRetry: () => void;
}) {
  return (
    <div className="grid min-h-0 flex-1 place-items-center bg-canvas/55">
      {failed ? (
        <div
          role="alert"
          data-run-read="failed"
          className="max-w-sm rounded-lg border border-error/40 bg-error/5 px-3 py-2.5 text-center"
        >
          <p className="text-[12.5px] text-fg-muted">{inspectorCopy.runReadFailed}</p>
          <RetryButton onClick={onRetry} />
        </div>
      ) : (
        <p data-run-read="loading" className="font-mono text-[12px] text-fg-subtle">
          {inspectorCopy.readingRun}
        </p>
      )}
    </div>
  );
}

/**
 * A partial or possibly stale record, said out loud above whatever tab is showing it.
 *
 * Without the event log Trace has no pauses, reloads, wait timing or environment steps, and a run
 * whose refresh failed may have moved on. Either one drawn silently would read as a complete record.
 */
function ReadWarnings({
  runStale,
  eventsMissing,
  onRetry,
}: {
  readonly runStale: boolean;
  readonly eventsMissing: boolean;
  readonly onRetry: () => void;
}) {
  if (!runStale && !eventsMissing) return null;
  return (
    <div
      role="status"
      data-run-read="partial"
      className="flex flex-none flex-wrap items-center gap-2 border-b border-amber/25 bg-amber/6 px-4.5 py-1.5"
    >
      <p className="m-0 text-[12px] text-amber">
        {[
          runStale ? inspectorCopy.runRefreshFailed : null,
          eventsMissing ? inspectorCopy.eventsReadFailed : null,
        ]
          .filter(Boolean)
          .join(' ')}
      </p>
      <RetryButton onClick={onRetry} />
    </div>
  );
}

function RetryButton({ onClick }: { readonly onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mt-1.5 rounded-md bg-white/6 px-2.5 py-1 font-mono text-[11px] text-fg-muted transition duration-micro ease-expo hover:bg-white/10"
    >
      {inspectorCopy.readRetry}
    </button>
  );
}
