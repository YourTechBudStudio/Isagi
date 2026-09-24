import { useEffect, useMemo, useState } from 'react';

import type { WorkflowEvidenceDto, WorkflowOperationDto } from '@isagi/contracts';

import type { WorkflowOperationsView } from '../../../lib/workspace/workflow/queries.js';
import { inspectorCopy } from './copy.js';
import {
  evidenceDataTabs,
  evidenceTabKey,
  operationDataTabs,
  operationTabKey,
  shortHash,
  toneClass,
  type DockChildExecution,
  type DockDataTab,
  type DockRow,
  type DockView,
  type FieldTone,
} from './dock.js';
import { Fields } from './DockFields.js';
import { dockMaxHeight, dockMinHeight, formatBytes } from './format.js';
import type { InspectorSelection, InspectorTab } from './selection.js';
import { formatClock } from './timing.js';
import { WorkflowCheckpointColumn } from './WorkflowCheckpointColumn.js';
import { WorkflowCheckpointFiles } from './WorkflowCheckpointFiles.js';
import { WorkflowEvidenceContent } from './WorkflowContentViewer.js';
import { WorkflowEvidenceCard } from './WorkflowEvidenceCard.js';
import { WorkflowOperationProvenance } from './WorkflowOperationProvenance.js';
import { WorkflowPayloadValue } from './WorkflowPayloadValue.js';

/**
 * What the selected visit captured, as the dock receives it.
 *
 * `no_visit` is a state, not an absence. A declared node nobody has visited and a frame's own setup
 * segment are both legitimate selections with a full dock view — and neither is a visit, so neither
 * has an evidence question. Substituting the run's listing there would put other nodes' records
 * under a heading reading "this visit and below", which is the one thing this column may never do.
 */
export type DockEvidenceRows =
  | { readonly kind: 'no_visit' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'ready'; readonly records: readonly WorkflowEvidenceDto[] };

export interface DockEvidenceView {
  readonly rows: DockEvidenceRows;
  readonly selectedKey: string | null;
  readonly onSelect: (record: WorkflowEvidenceDto) => void;
  /** Opens the Evidence tab in visit scope. Null when there is no visit to open it on. */
  readonly onOpenAll: (() => void) | null;
}

/**
 * The shared detail surface, filled by whatever is selected in any of the three tabs.
 *
 * Five dense columns that scroll horizontally rather than reflowing: this is reference material a
 * person scans, and a responsive stack would turn one glance into five. The resize is bounded and
 * keyboard-operable, because a panel you can only drag is a panel some people cannot move.
 *
 * Read-only throughout. Nothing here dispatches, answers, retries or cancels — the workflow bar is
 * the only place a run is acted on, and putting even one action here would make that untrue.
 */
export function WorkflowDock({
  view,
  runId,
  operations,
  evidence,
  tab,
  height,
  onHeightChange,
  onSelect,
}: {
  readonly view: DockView | null;
  readonly runId: number;
  readonly operations: WorkflowOperationsView;
  readonly evidence: DockEvidenceView;
  /** Which inspector tab is above. Only the provenance disclosure's default depends on it. */
  readonly tab: InspectorTab;
  readonly height: number;
  readonly onHeightChange: (height: number) => void;
  /** The inspector's own selection, so the dock can move it without owning it. */
  readonly onSelect: (selection: InspectorSelection) => void;
}) {
  const [dataTab, setDataTab] = useState<string | null>(null);
  // Data tabs and the `capture_evidence` card's back-link read the same set the column shows, so a
  // selection with no visit contributes neither rather than borrowing another visit's records.
  const records = evidence.rows.kind === 'ready' ? evidence.rows.records : empty;

  // The selection's own payloads, then whatever its operations recorded, then what it captured.
  // Operations and evidence arrive after the view does, so their tabs are composed here rather than
  // baked into it.
  const tabs = useMemo(
    () => [
      ...(view?.data ?? []),
      ...operationDataTabs(operations.operations),
      ...evidenceDataTabs(records),
    ],
    [view?.data, operations.operations, records],
  );
  const activeTab = tabs.find((entry) => entry.key === dataTab) ?? tabs[0] ?? null;

  useEffect(() => {
    setDataTab(null);
  }, [view?.executionId, view?.kindChip, view?.statusChip]);

  return (
    <section
      /**
       * Sized, but allowed to shrink.
       *
       * A fixed height wins a flex fight it should lose: in a short window — a tall bar with a
       * question form open, a small screen — it took every pixel and left the graph none, which is
       * the one thing the overlay exists to show. It keeps its height where there is room and gives
       * way where there is not.
       */
      className="relative flex min-h-0 flex-col border-t border-line/30 bg-elevated/96"
      style={{ height, flex: `0 1 ${height}px`, maxHeight: '62%' }}
      aria-label="Selection details"
    >
      <DockGrip height={height} onHeightChange={onHeightChange} />
      {view === null ? (
        <p className="px-4.5 py-4 font-mono text-[11.5px] text-fg-subtle">
          Select a node, a visit or a row to see what it recorded.
        </p>
      ) : (
        <>
          <header className="flex flex-none items-center gap-2.5 border-b border-line/20 px-4.5 pt-2.5 pb-2">
            <nav className="min-w-0 truncate font-mono text-[12.5px] text-fg" aria-label="Path">
              {view.breadcrumb.map((crumb, index) => (
                <span key={`${crumb.label}-${index}`}>
                  {index > 0 && <span className="text-fg-subtle"> ▸ </span>}
                  <span
                    className={index === view.breadcrumb.length - 1 ? 'text-fg' : 'text-fg-subtle'}
                  >
                    {crumb.label}
                  </span>
                </span>
              ))}
            </nav>
            {view.displayName && (
              <span className="truncate text-[12.5px] text-fg-muted">· {view.displayName}</span>
            )}
            {/* Cyan for a checkpoint, as its canvas tag is: the colour the inspector gives kept things. */}
            <Chip tone={view.checkpoint === null ? 'kind' : 'kept'}>{view.kindChip}</Chip>
            <Chip tone={view.statusTone}>{view.statusChip}</Chip>
          </header>

          <div data-testid="dock-columns" className="flex min-h-0 flex-1 overflow-x-auto">
            <Column
              title={inspectorCopy.columnDeclared}
              rule="bg-violet/70"
              width="flex-[0_0_15rem]"
            >
              <Fields rows={view.declared} onOpenTab={setDataTab} />
            </Column>
            <Column title={inspectorCopy.columnRecorded} rule="bg-blue/70" width="flex-[0_0_18rem]">
              <Fields rows={view.recorded} onOpenTab={setDataTab} />
            </Column>
            {view.checkpoint !== null ? (
              // A checkpoint never calls a capability or captures evidence, so the two columns that
              // would always be empty give way to the one that says what it saved.
              <Column
                title={inspectorCopy.columnCheckpoint}
                subtitle={inspectorCopy.checkpointColumnSubtitle}
                rule="bg-cyan/70"
                width="flex-[0_0_24rem]"
              >
                <WorkflowCheckpointColumn
                  runId={runId}
                  checkpoint={view.checkpoint}
                  onOpenTab={setDataTab}
                  onSelect={onSelect}
                />
              </Column>
            ) : (
              <>
                <Column
                  title={
                    view.operations.kind === 'wait_and_operations'
                      ? `${inspectorCopy.columnWait} · ${inspectorCopy.columnOperations}`
                      : inspectorCopy.columnOperations
                  }
                  rule="bg-amber/70"
                  width="flex-[0_0_24rem]"
                >
                  <OperationsColumn
                    view={view}
                    operations={operations}
                    tab={tab}
                    records={records}
                    onSelectEvidence={evidence.onSelect}
                    onOpenTab={setDataTab}
                    onSelect={onSelect}
                  />
                </Column>
                <Column
                  title={inspectorCopy.columnEvidence}
                  subtitle={records.length === 0 ? null : inspectorCopy.evidenceColumnSubtitle}
                  rule="bg-cyan/70"
                  width="flex-[0_0_22rem]"
                >
                  <EvidenceColumn evidence={evidence} onOpenTab={setDataTab} />
                </Column>
              </>
            )}
            <Column title={inspectorCopy.columnData} rule="bg-cyan/70" width="flex-1 min-w-[26rem]">
              {tabs.length === 0 ? (
                <p className="py-1.5 font-mono text-[11.5px] text-fg-subtle">
                  {inspectorCopy.dataEmpty}
                </p>
              ) : (
                <>
                  <div className="mb-1.5 flex flex-wrap gap-0.5">
                    {tabs.map((entry) => {
                      const absent = entry.kind === 'payload' && entry.slot === null;
                      const size = tabSize(entry);
                      return (
                        <button
                          key={entry.key}
                          type="button"
                          aria-pressed={entry === activeTab}
                          data-tab={entry.key}
                          onClick={() => setDataTab(entry.key)}
                          className={`rounded-md border px-2 py-0.5 font-mono text-[11px] transition duration-micro ease-expo ${
                            entry === activeTab
                              ? 'border-cyan/50 bg-cyan/8 text-fg'
                              : 'border-line/30 bg-canvas/60 text-fg-subtle hover:text-fg'
                          } ${absent ? 'opacity-50' : ''}`}
                        >
                          {entry.name}
                          {size !== null && <span className="ml-1.5 opacity-55">{size}</span>}
                        </button>
                      );
                    })}
                  </div>
                  {activeTab &&
                    (activeTab.kind === 'payload' ? (
                      <WorkflowPayloadValue
                        key={`${view.executionId}-${activeTab.key}`}
                        runId={runId}
                        slot={activeTab.slot}
                      />
                    ) : activeTab.kind === 'evidence' ? (
                      <EvidenceTabBody
                        key={activeTab.key}
                        runId={runId}
                        evidenceKey={activeTab.evidenceKey}
                        records={records}
                      />
                    ) : view.checkpoint?.summary ? (
                      <WorkflowCheckpointFiles
                        key={activeTab.checkpointId}
                        runId={runId}
                        checkpointId={activeTab.checkpointId}
                        base={view.checkpoint.summary.base}
                        counts={view.checkpoint.summary.counts}
                        layout="compact"
                      />
                    ) : null)}
                </>
              )}
            </Column>
          </div>
        </>
      )}
    </section>
  );
}

/**
 * The resize handle, which is a slider.
 *
 * A bare drag target is unreachable without a mouse, so the same affordance is a real range control:
 * arrows move it, Home and End take it to its bounds, and the pointer drag is layered on top rather
 * than being the only way in.
 */
function DockGrip({
  height,
  onHeightChange,
}: {
  readonly height: number;
  readonly onHeightChange: (height: number) => void;
}) {
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (event: PointerEvent) => {
      onHeightChange(window.innerHeight - event.clientY);
    };
    const onUp = () => setDragging(false);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [dragging, onHeightChange]);

  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label={inspectorCopy.dockResize}
      aria-valuemin={dockMinHeight}
      aria-valuemax={dockMaxHeight}
      aria-valuenow={Math.round(height)}
      aria-orientation="vertical"
      onPointerDown={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 64 : 16;
        if (event.key === 'ArrowUp') onHeightChange(height + step);
        else if (event.key === 'ArrowDown') onHeightChange(height - step);
        else if (event.key === 'Home') onHeightChange(dockMaxHeight);
        else if (event.key === 'End') onHeightChange(dockMinHeight);
        else return;
        event.preventDefault();
      }}
      className="absolute -top-1 right-0 left-0 z-10 h-2 cursor-row-resize focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue"
    >
      <span
        aria-hidden
        className="absolute top-0.75 left-1/2 h-0.5 w-11 -translate-x-1/2 rounded-full bg-line/50"
      />
    </div>
  );
}

function Column({
  title,
  subtitle = null,
  rule,
  width,
  children,
}: {
  readonly title: string;
  /** A qualifier on the heading, lower-case and unshouted, for a column whose scope is not obvious. */
  readonly subtitle?: string | null;
  readonly rule: string;
  readonly width: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div
      data-dock-column={title}
      className={`flex min-w-0 flex-col overflow-hidden border-l border-line/22 ${width}`}
    >
      <h3 className="flex flex-none items-center gap-2 px-4 pt-2 pb-1.5 text-[10.5px] font-semibold tracking-[0.09em] text-fg-subtle uppercase">
        <span aria-hidden className={`h-0.5 w-3.5 rounded-full ${rule}`} />
        {title}
        {subtitle !== null && (
          <span className="font-normal tracking-normal normal-case opacity-70">· {subtitle}</span>
        )}
      </h3>
      <div data-dock-column-scroll className="min-h-0 flex-1 overflow-auto px-4 pt-0.5 pb-3.5">
        {children}
      </div>
    </div>
  );
}

const empty: readonly WorkflowEvidenceDto[] = [];

/** What a tab's chip says beside its name: a payload's size, or how many files a checkpoint kept. */
function tabSize(tab: DockDataTab): string | null {
  if (tab.kind === 'checkpoint_files') return String(tab.fileCount);
  if (tab.kind === 'evidence') return formatBytes(tab.byteSize);
  return tab.slot !== null && 'byteSize' in tab.slot ? formatBytes(tab.slot.byteSize) : null;
}

/**
 * What the selected visit kept, and everything beneath it.
 *
 * The column is here rather than only on the Evidence tab because a person inspecting a node or a
 * trace row wants its evidence where they already are; a count alone would send them to another
 * surface for every look. It lists the same set `evidenceCaptured` counts, through the same query
 * the Evidence tab makes in visit scope, so the two cannot disagree about what a visit captured.
 */
function EvidenceColumn({
  evidence,
  onOpenTab,
}: {
  readonly evidence: DockEvidenceView;
  readonly onOpenTab: (tab: string) => void;
}) {
  const { rows } = evidence;
  if (rows.kind === 'no_visit') {
    return (
      <p className="py-1.5 font-mono text-[11.5px] text-fg-subtle">
        {inspectorCopy.evidenceColumnNoVisit}
      </p>
    );
  }
  if (rows.kind === 'failed') {
    return (
      <p className="py-1.5 font-mono text-[11.5px] text-amber">
        {inspectorCopy.evidenceListFailed}
      </p>
    );
  }
  if (rows.kind === 'loading') {
    return (
      <p className="py-1.5 font-mono text-[11.5px] text-fg-subtle">
        {inspectorCopy.evidenceListLoading}
      </p>
    );
  }
  if (rows.records.length === 0) {
    return (
      <p className="py-1.5 font-mono text-[11.5px] text-fg-subtle">
        {inspectorCopy.evidenceColumnEmpty}
      </p>
    );
  }
  return (
    <>
      {rows.records.map((record) => (
        <WorkflowEvidenceCard
          key={record.evidenceKey}
          record={record}
          selected={record.evidenceKey === evidence.selectedKey}
          onSelect={() => {
            evidence.onSelect(record);
            onOpenTab(evidenceTabKey(record.evidenceKey));
          }}
        />
      ))}
      {evidence.onOpenAll !== null && (
        <button
          type="button"
          data-evidence-open-all
          onClick={evidence.onOpenAll}
          className="font-mono text-[11.5px] text-cyan underline decoration-dotted underline-offset-[3px] transition duration-micro ease-expo hover:text-fg"
        >
          {inspectorCopy.evidenceOpenAll}
        </button>
      )}
    </>
  );
}

/**
 * A capture's bytes in the Data column, through the same component the detail pane uses.
 *
 * Keyed off the record rather than the tab so the viewer is handed the metadata it needs to be
 * honest — a media type, a size and a reference to name if the bytes turn out to be gone. A card
 * that looked perfectly ordinary in the column beside this one is exactly where that happens.
 */
function EvidenceTabBody({
  runId,
  evidenceKey,
  records,
}: {
  readonly runId: number;
  readonly evidenceKey: string;
  readonly records: readonly WorkflowEvidenceDto[];
}) {
  const record = records.find((item) => item.evidenceKey === evidenceKey) ?? null;
  if (record === null) return null;
  return (
    <>
      <Fields
        rows={[
          { label: 'role', value: record.role },
          { label: 'title', value: record.title },
        ]}
      />
      <div className="mt-2">
        <WorkflowEvidenceContent runId={runId} record={record} compact />
      </div>
    </>
  );
}

function OperationsColumn({
  view,
  operations,
  tab,
  records,
  onSelectEvidence,
  onOpenTab,
  onSelect,
}: {
  readonly view: DockView;
  readonly operations: WorkflowOperationsView;
  readonly tab: InspectorTab;
  readonly records: readonly WorkflowEvidenceDto[];
  readonly onSelectEvidence: (record: WorkflowEvidenceDto) => void;
  readonly onOpenTab: (tab: string) => void;
  readonly onSelect: (selection: InspectorSelection) => void;
}) {
  if (view.operations.kind === 'none') {
    return (
      <>
        <p className="py-1.5 font-mono text-[11.5px] text-fg-subtle">{view.operations.reason}</p>
        {view.nested && <NestedChildren nested={view.nested} onSelect={onSelect} />}
      </>
    );
  }

  return (
    <>
      {view.operations.kind === 'wait_and_operations' && (
        <div className="mb-3 rounded-lg border border-waiting/28 bg-waiting/6 px-2.5 py-2">
          <Fields rows={view.operations.waitFields} onOpenTab={onOpenTab} />
        </div>
      )}
      <OperationCards
        operations={operations}
        tab={tab}
        records={records}
        onSelectEvidence={onSelectEvidence}
        onOpenTab={onOpenTab}
      />
    </>
  );
}

/**
 * A subgraph's children, as a way in rather than a count.
 *
 * Direct children only, each selecting that visit — a nested subgraph among them opens its own list
 * in turn. Flattening every descendant here would present a subgraph as one step that did a great
 * deal, which is the conflation the whole inspector is built to avoid.
 */
function NestedChildren({
  nested,
  onSelect,
}: {
  readonly nested: NonNullable<DockView['nested']>;
  readonly onSelect: (selection: InspectorSelection) => void;
}) {
  if (!nested.entered) {
    // Not the same as a frame that ran and did nothing, and an empty list would claim the second.
    return (
      <p className="font-mono text-[11.5px] text-fg-subtle">{inspectorCopy.subgraphNotEntered}</p>
    );
  }

  return (
    <>
      <p className="font-mono text-[11.5px] text-fg-subtle">
        {inspectorCopy.nestedOperations(nested.operations, nested.executions)}
      </p>
      <ul className="mt-2 flex flex-col gap-1" aria-label={inspectorCopy.childExecutions}>
        {nested.children.map((child) => (
          <li key={child.executionId}>
            <ChildExecutionButton child={child} onSelect={onSelect} />
          </li>
        ))}
      </ul>
    </>
  );
}

function ChildExecutionButton({
  child,
  onSelect,
}: {
  readonly child: DockChildExecution;
  readonly onSelect: (selection: InspectorSelection) => void;
}) {
  return (
    <button
      type="button"
      data-child-execution={child.executionId}
      onClick={() => onSelect(child.selection)}
      className="flex w-full items-baseline gap-2 rounded-md border border-line/25 bg-canvas/50 px-2 py-1 text-left transition duration-micro ease-expo hover:border-line/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue"
    >
      <span className="flex-none font-mono text-[11px] text-fg-subtle">{child.executionId}</span>
      <span
        className={`truncate font-mono text-[12px] ${child.isSubgraph ? 'text-violet' : 'text-fg'}`}
      >
        {child.nodeId}
      </span>
      {child.displayName && (
        <span className="min-w-0 truncate text-[11.5px] text-fg-muted">{child.displayName}</span>
      )}
      <span
        className={`ml-auto flex-none font-mono text-[10.5px] ${toneClass(statusTone(child.status))}`}
      >
        {child.status}
      </span>
    </button>
  );
}

function statusTone(status: DockChildExecution['status']): FieldTone {
  switch (status) {
    case 'failed':
      return 'bad';
    case 'completed':
      return 'ok';
    default:
      return 'warn';
  }
}

/**
 * Every operation this visit made, across every attempt.
 *
 * Completeness is stated, never implied. Until the read has finished it says so, and a failed read
 * says that rather than showing a short list that looks whole — the count on the execution is a fact
 * about the step, not evidence that the cards beside it are all of them.
 */
function OperationCards({
  operations,
  tab,
  records,
  onSelectEvidence,
  onOpenTab,
}: {
  readonly operations: WorkflowOperationsView;
  readonly tab: InspectorTab;
  readonly records: readonly WorkflowEvidenceDto[];
  readonly onSelectEvidence: (record: WorkflowEvidenceDto) => void;
  readonly onOpenTab: (tab: string) => void;
}) {
  if (operations.error) {
    return (
      <div className="rounded-lg border border-error/40 bg-error/5 px-2.5 py-2">
        <p className="text-[12.5px] text-fg-muted">{inspectorCopy.operationsFailed}</p>
        <button
          type="button"
          onClick={operations.retry}
          className="mt-1.5 rounded-md bg-white/6 px-2.5 py-1 font-mono text-[11px] text-fg-muted transition duration-micro ease-expo hover:bg-white/10"
        >
          {inspectorCopy.operationsRetry}
        </button>
      </div>
    );
  }

  if (operations.isLoading && operations.operations.length === 0) {
    return (
      <p className="py-1.5 font-mono text-[11.5px] text-fg-subtle">
        {inspectorCopy.operationsLoading}
      </p>
    );
  }

  if (operations.operations.length === 0) {
    return (
      <p className="py-1.5 font-mono text-[11.5px] text-fg-subtle">
        {operations.complete ? inspectorCopy.noOperations : inspectorCopy.operationsLoading}
      </p>
    );
  }

  return (
    <>
      {operations.operations.map((operation, index) => (
        <OperationCard
          key={operation.operationKey}
          operation={operation}
          index={index}
          tab={tab}
          captured={
            records.find((record) => record.operationKey === operation.operationKey) ?? null
          }
          onSelectEvidence={onSelectEvidence}
          onOpenTab={onOpenTab}
        />
      ))}
      {!operations.complete && (
        <p className="pt-1 font-mono text-[11px] text-waiting">{inspectorCopy.operationsPartial}</p>
      )}
    </>
  );
}

function OperationCard({
  operation,
  index,
  tab,
  captured,
  onSelectEvidence,
  onOpenTab,
}: {
  readonly operation: WorkflowOperationDto;
  readonly index: number;
  readonly tab: InspectorTab;
  /** The record this call produced, when it was a capture and the listing has reached it. */
  readonly captured: WorkflowEvidenceDto | null;
  readonly onSelectEvidence: (record: WorkflowEvidenceDto) => void;
  readonly onOpenTab: (tab: string) => void;
}) {
  const rows: DockRow[] = [
    { label: 'key', value: operation.operationKey },
    { label: 'call', value: `#${operation.callIndex}` },
    { label: 'state', value: operation.state, tone: operationTone(operation.state) },
  ];
  if (operation.stage) rows.push({ label: 'stage', value: operation.stage, tone: 'warn' });
  rows.push({ label: 'target', value: formatTarget(operation) });
  rows.push({
    label: 'request',
    value: shortHash(operation.requestHash),
    dataTab: operationTabKey(operation.operationKey, 'request'),
  });
  rows.push(
    operation.receiptRef === null
      ? { label: 'receipt', value: 'none', tone: operation.state === 'completed' ? 'warn' : 'dim' }
      : {
          label: 'receipt',
          value: 'recorded',
          tone: 'ok',
          dataTab: operationTabKey(operation.operationKey, 'receipt'),
        },
  );
  if (operation.resultRef !== null) {
    rows.push({
      label: 'result',
      value: 'recorded',
      tone: 'ok',
      dataTab: operationTabKey(operation.operationKey, 'result'),
    });
  }
  if (operation.uncertaintyDetail) {
    rows.push({ label: 'uncertain', value: operation.uncertaintyDetail, tone: 'warn' });
  }
  if (operation.stop.state !== 'not_requested') {
    rows.push({
      label: 'stop',
      value: `${operation.stop.state}${operation.stop.detail ? ` · ${operation.stop.detail}` : ''}`,
      tone: operation.stop.state === 'confirmed' ? 'ok' : 'warn',
    });
  }
  if (operation.lateEvidenceRef !== null) {
    // Retained, never applied. A receipt that landed after settlement is evidence about the past,
    // not a reason to revive a settled operation.
    rows.push({
      label: 'late evidence',
      value: 'recorded after settlement',
      tone: 'warn',
      dataTab: operationTabKey(operation.operationKey, 'lateEvidence'),
    });
  }
  if (captured !== null) {
    // The record itself, not a second rendering of it: the row is a way back to the card in the
    // column beside this one, which is where a capture actually reads.
    rows.push({
      label: 'evidence',
      value: captured.evidenceKey,
      tone: 'ok',
      dataTab: evidenceTabKey(captured.evidenceKey),
    });
  }
  rows.push({ label: 'created', value: formatClock(operation.createdAt) });
  if (operation.dispatchedAt) {
    rows.push({ label: 'dispatched', value: formatClock(operation.dispatchedAt) });
  }
  if (operation.settledAt) rows.push({ label: 'settled', value: formatClock(operation.settledAt) });

  return (
    <article
      className={`mb-2 rounded-lg border border-l-[3px] border-line/30 bg-canvas/50 px-2.5 py-2 ${operationAccent(
        operation.state,
      )}`}
    >
      <header className="mb-1.5 flex items-baseline gap-2 font-mono text-[12px]">
        <span className="text-fg-subtle">{index + 1}</span>
        <span className="text-fg">{operation.capability}</span>
        <span
          className={`ml-auto text-[10px] font-semibold tracking-[0.06em] uppercase ${toneClass(
            operationTone(operation.state),
          )}`}
        >
          {operation.state}
        </span>
      </header>
      <Fields
        rows={rows}
        onOpenTab={(target) => {
          if (captured !== null && target === evidenceTabKey(captured.evidenceKey)) {
            onSelectEvidence(captured);
          }
          onOpenTab(target);
        }}
      />
      {/*
        On every card, in every tab. Only whether it starts open varies.

        It is ten rows, so opening it on each card of a visit that made three calls is thirty rows in
        a twenty-four-character column — unreadable, which defeats the point of showing provenance at
        all. The first card starts open because the common case is a single call, where a disclosure
        would be pure ceremony.

        Under Evidence it starts closed, because the detail pane above is already showing this block
        for the record in question. It is *not* removed there: the pane shows provenance for that
        record's **source** operation alone, so withholding the disclosure would leave every other
        operation of the visit with no provenance anywhere in the product.
      */}
      <details
        open={index === 0 && tab !== 'evidence'}
        className="mt-1.5 border-t border-dashed border-line/25 pt-1.5"
      >
        <summary className="cursor-pointer font-mono text-[11px] text-fg-subtle marker:content-none">
          {inspectorCopy.provenanceLabel}
        </summary>
        <div className="mt-1.5">
          <WorkflowOperationProvenance operation={operation} />
        </div>
      </details>
    </article>
  );
}

/** The identifiers the operation actually recorded. Friendly composed targets are a later story. */
function formatTarget(operation: WorkflowOperationDto): string {
  const parts: string[] = [];
  const { agentSessionId, paneId, ptyProcessId, turnId } = operation.target;
  if (agentSessionId !== null) parts.push(`agent_session ${agentSessionId}`);
  if (paneId !== null) parts.push(`pane ${paneId}`);
  if (ptyProcessId !== null) parts.push(`pty_process ${ptyProcessId}`);
  if (turnId !== null) parts.push(`turn ${turnId}`);
  return parts.length === 0 ? '—' : parts.join(' · ');
}

function operationTone(state: WorkflowOperationDto['state']): FieldTone {
  switch (state) {
    case 'completed':
      return 'ok';
    case 'failed':
      return 'bad';
    case 'uncertain':
    case 'interrupted':
      return 'warn';
    case 'abandoned':
      return 'dim';
    default:
      return 'default';
  }
}

function operationAccent(state: WorkflowOperationDto['state']): string {
  switch (state) {
    case 'completed':
      return 'border-l-green';
    case 'failed':
      return 'border-l-error';
    case 'uncertain':
    case 'interrupted':
      return 'border-l-amber bg-amber/6';
    default:
      return 'border-l-blue';
  }
}

function Chip({
  tone,
  children,
}: {
  readonly tone: FieldTone | 'kind' | 'kept';
  readonly children: string;
}) {
  const styles =
    tone === 'kind'
      ? 'border-violet/28 bg-violet/12 text-violet'
      : tone === 'kept'
        ? 'border-cyan/30 bg-cyan/10 text-cyan'
        : tone === 'ok'
          ? 'border-green/28 bg-green/13 text-green'
          : tone === 'bad'
            ? 'border-error/30 bg-error/13 text-error'
            : tone === 'warn'
              ? 'border-amber/30 bg-amber/16 text-amber'
              : 'border-line/35 bg-line/18 text-fg-subtle';
  return (
    <span
      className={`flex-none rounded-full border px-2 py-0.5 text-[11px] font-semibold tracking-wider uppercase ${styles}`}
    >
      {children}
    </span>
  );
}
