import { useEffect, useMemo, useState } from 'react';

import type { WorkflowExecutionDetailDto, WorkflowOperationDto } from '@isagi/contracts';

import { inspectorCopy } from './copy.js';
import {
  statusTone,
  toneClass,
  type DockChildExecution,
  type DockDataTab,
  type DockRow,
  type DockView,
  type FieldTone,
} from './dock.js';
import { Fields } from './DockFields.js';
import { dockMaxHeight, dockMinHeight } from './format.js';
import { LabelSuffix } from './LabelSuffix.js';
import type { InspectorSelection } from './selection.js';
import { formatClock } from './timing.js';
import { WorkflowCheckpointColumn } from './WorkflowCheckpointColumn.js';
import { WorkflowCheckpointFiles } from './WorkflowCheckpointFiles.js';
import { TextValue, WorkflowPayloadValue } from './WorkflowPayloadValue.js';

/** The selected execution's full record, as the dock receives it. */
export interface DockDetailState {
  readonly detail: WorkflowExecutionDetailDto | null;
  readonly isLoading: boolean;
  readonly error: unknown;
  readonly retry: () => void;
}

/**
 * The shared detail surface, filled by whatever is selected in any of the three tabs.
 *
 * Dense columns that scroll horizontally rather than reflowing: this is reference material a person
 * scans, and a responsive stack would turn one glance into four. The resize is bounded and
 * keyboard-operable, because a panel you can only drag is a panel some people cannot move.
 *
 * Read-only throughout. Nothing here dispatches, answers, retries or cancels — the workflow bar is
 * the only place a run is acted on.
 */
export function WorkflowDock({
  view,
  execution,
  height,
  onHeightChange,
  onSelect,
}: {
  readonly view: DockView | null;
  readonly execution: DockDetailState;
  readonly height: number;
  readonly onHeightChange: (height: number) => void;
  /** The inspector's own selection, so the dock can move it without owning it. */
  readonly onSelect: (selection: InspectorSelection) => void;
}) {
  const [dataTab, setDataTab] = useState<string | null>(null);
  const operations =
    execution.detail !== null && execution.detail.executionId === view?.executionId
      ? execution.detail.operations
      : empty;

  // The selection's own values, then each operation's request and result.
  const tabs = useMemo(
    () => [...(view?.data ?? []), ...operationDataTabs(operations)],
    [view?.data, operations],
  );
  const activeTab = tabs.find((entry) => entry.key === dataTab) ?? tabs[0] ?? null;

  useEffect(() => {
    setDataTab(null);
  }, [view?.executionId, view?.kindChip, view?.statusChip]);

  return (
    <section
      /**
       * Sized, but allowed to shrink: in a short window a fixed height took every pixel and left the
       * graph none, which is the one thing the overlay exists to show.
       */
      className="relative flex min-h-0 flex-col border-t border-line/30 bg-elevated/96"
      style={{ height, flex: `0 1 ${height}px`, maxHeight: '62%' }}
      aria-label="Selection details"
    >
      <DockGrip height={height} onHeightChange={onHeightChange} />
      {view === null ? (
        <p className="px-4.5 py-4 font-mono text-[11.5px] text-fg-subtle">
          {inspectorCopy.dockEmpty}
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
              <Fields rows={view.recorded} onOpenTab={setDataTab} onSelect={onSelect} />
            </Column>
            {view.checkpoint !== null ? (
              // A checkpoint never performs a side effect, so the column that would always be empty
              // gives way to the one that says what it saved.
              <Column
                title={inspectorCopy.columnCheckpoint}
                rule="bg-cyan/70"
                width="flex-[0_0_24rem]"
              >
                <WorkflowCheckpointColumn checkpoint={view.checkpoint} onOpenTab={setDataTab} />
              </Column>
            ) : (
              <Column
                title={
                  view.operations.kind === 'wait_and_operations'
                    ? `${inspectorCopy.columnWait} · ${inspectorCopy.columnOperations}`
                    : inspectorCopy.columnOperations
                }
                rule="bg-amber/70"
                width="flex-[0_0_26rem]"
              >
                <OperationsColumn
                  view={view}
                  execution={execution}
                  operations={operations}
                  onOpenTab={setDataTab}
                  onSelect={onSelect}
                />
              </Column>
            )}
            <Column title={inspectorCopy.columnData} rule="bg-cyan/70" width="flex-1 min-w-[26rem]">
              {tabs.length === 0 ? (
                <p className="py-1.5 font-mono text-[11.5px] text-fg-subtle">
                  {inspectorCopy.dataEmpty}
                </p>
              ) : (
                <>
                  <div className="mb-1.5 flex flex-wrap gap-0.5">
                    {tabs.map((entry) => (
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
                        } ${entry.kind === 'value' && entry.value === undefined ? 'opacity-50' : ''}`}
                      >
                        {entry.name}
                      </button>
                    ))}
                  </div>
                  {activeTab &&
                    (activeTab.kind === 'value' ? (
                      activeTab.value === undefined && view.executionId !== null ? (
                        <p className="py-1.5 font-mono text-[11.5px] text-fg-subtle">
                          {execution.error
                            ? inspectorCopy.detailFailed
                            : inspectorCopy.detailLoading}
                        </p>
                      ) : (
                        <WorkflowPayloadValue
                          key={`${view.executionId}-${activeTab.key}`}
                          value={activeTab.value}
                        />
                      )
                    ) : (
                      <WorkflowCheckpointFiles
                        key={activeTab.checkpointId}
                        checkpointId={activeTab.checkpointId}
                        layout="compact"
                      />
                    ))}
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
  rule,
  width,
  children,
}: {
  readonly title: string;
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
      </h3>
      <div data-dock-column-scroll className="min-h-0 flex-1 overflow-auto px-4 pt-0.5 pb-3.5">
        {children}
      </div>
    </div>
  );
}

const empty: readonly WorkflowOperationDto[] = [];

/** Each operation's request and, once it has one, its structured result. */
function operationDataTabs(operations: readonly WorkflowOperationDto[]): readonly DockDataTab[] {
  const tabs: DockDataTab[] = [];
  for (const operation of operations) {
    const ordinal = operation.seq + 1;
    tabs.push({
      kind: 'value',
      key: operationTabKey(operation.operationId, 'request'),
      name: `op${ordinal}.request`,
      value: operation.request,
    });
    if (operation.result !== null && operation.result !== undefined) {
      tabs.push({
        kind: 'value',
        key: operationTabKey(operation.operationId, 'result'),
        name: `op${ordinal}.result`,
        value: operation.result,
      });
    }
  }
  return tabs;
}

function operationTabKey(operationId: number, slot: string): string {
  return `op-${operationId}::${slot}`;
}

function OperationsColumn({
  view,
  execution,
  operations,
  onOpenTab,
  onSelect,
}: {
  readonly view: DockView;
  readonly execution: DockDetailState;
  readonly operations: readonly WorkflowOperationDto[];
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
      <OperationCards execution={execution} operations={operations} onOpenTab={onOpenTab} />
    </>
  );
}

/**
 * A subgraph's or a graph's executions, as a way in rather than a count. Direct children only, each
 * selecting that execution — a nested subgraph among them opens its own list in turn.
 */
function NestedChildren({
  nested,
  onSelect,
}: {
  readonly nested: NonNullable<DockView['nested']>;
  readonly onSelect: (selection: InspectorSelection) => void;
}) {
  if (!nested.entered) {
    return (
      <p className="font-mono text-[11.5px] text-fg-subtle">{inspectorCopy.subgraphNotEntered}</p>
    );
  }
  return (
    <ul className="mt-2 flex flex-col gap-1" aria-label={inspectorCopy.childExecutions}>
      {nested.children.map((child) => (
        <li key={child.executionId}>
          <ChildExecutionButton child={child} onSelect={onSelect} />
        </li>
      ))}
    </ul>
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
      <LabelSuffix label={child.label} />
      <span
        className={`ml-auto flex-none font-mono text-[10.5px] ${toneClass(statusTone(child.status))}`}
      >
        {child.status}
      </span>
    </button>
  );
}

/** Every side effect this execution performed, in order: the prompts it sent and what came back. */
function OperationCards({
  execution,
  operations,
  onOpenTab,
}: {
  readonly execution: DockDetailState;
  readonly operations: readonly WorkflowOperationDto[];
  readonly onOpenTab: (tab: string) => void;
}) {
  if (execution.error) {
    return (
      <div className="rounded-lg border border-error/40 bg-error/5 px-2.5 py-2">
        <p className="text-[12.5px] text-fg-muted">{inspectorCopy.operationsFailed}</p>
        <button
          type="button"
          onClick={execution.retry}
          className="mt-1.5 rounded-md bg-white/6 px-2.5 py-1 font-mono text-[11px] text-fg-muted transition duration-micro ease-expo hover:bg-white/10"
        >
          {inspectorCopy.operationsRetry}
        </button>
      </div>
    );
  }
  if (execution.detail === null) {
    return (
      <p className="py-1.5 font-mono text-[11.5px] text-fg-subtle">
        {inspectorCopy.operationsLoading}
      </p>
    );
  }
  if (operations.length === 0) {
    return (
      <p className="py-1.5 font-mono text-[11.5px] text-fg-subtle">{inspectorCopy.noOperations}</p>
    );
  }
  return (
    <>
      {operations.map((operation) => (
        <OperationCard
          key={operation.operationId}
          operation={operation}
          // A prompt completes when it is sent; its reply is recorded when the agent's turn ends,
          // so while the execution is still going a missing reply is not back yet.
          executionLive={
            execution.detail?.status === 'running' || execution.detail?.status === 'waiting'
          }
          onOpenTab={onOpenTab}
        />
      ))}
    </>
  );
}

function OperationCard({
  operation,
  executionLive,
  onOpenTab,
}: {
  readonly operation: WorkflowOperationDto;
  readonly executionLive: boolean;
  readonly onOpenTab: (tab: string) => void;
}) {
  const prompt = promptOf(operation.request);
  const rows: DockRow[] = [];
  const agent = [operation.harness, operation.model, operation.effort].filter(Boolean).join(' · ');
  if (agent) rows.push({ label: 'agent', value: agent });
  if (operation.agentSessionId !== null) {
    rows.push({ label: 'session', value: String(operation.agentSessionId) });
  }
  if (operation.paneId !== null) rows.push({ label: 'pane', value: String(operation.paneId) });
  if (operation.harnessSessionId !== null) {
    rows.push({ label: 'harness id', value: operation.harnessSessionId, tone: 'dim' });
  }
  rows.push({
    label: 'request',
    value: inspectorCopy.operationRecorded,
    dataTab: operationTabKey(operation.operationId, 'request'),
  });
  if (operation.result !== null && operation.result !== undefined) {
    rows.push({
      label: 'result',
      value: inspectorCopy.operationRecorded,
      dataTab: operationTabKey(operation.operationId, 'result'),
    });
  }
  if (operation.usage !== null) rows.push({ label: 'usage', value: usageLine(operation.usage) });
  rows.push({ label: 'started', value: formatClock(operation.startedAt) });
  if (operation.endedAt !== null)
    rows.push({ label: 'ended', value: formatClock(operation.endedAt) });

  return (
    <article
      data-operation={operation.operationId}
      className={`mb-2 rounded-lg border border-l-[3px] border-line/30 bg-canvas/50 px-2.5 py-2 ${operationAccent(
        operation.status,
      )}`}
    >
      <header className="mb-1.5 flex items-baseline gap-2 font-mono text-[12px]">
        <span className="text-fg-subtle">{operation.seq + 1}</span>
        <span className="text-fg">{operation.kind}</span>
        <span
          className={`ml-auto text-[10px] font-semibold tracking-[0.06em] uppercase ${toneClass(
            operationTone(operation.status),
          )}`}
        >
          {operation.status}
        </span>
      </header>
      <Fields rows={rows} onOpenTab={onOpenTab} />
      {prompt !== null && (
        <Exchange label={inspectorCopy.operationPrompt} text={prompt} testId="operation-prompt" />
      )}
      {operation.kind === 'send_prompt' || operation.kind === 'spawn_agent' ? (
        <Exchange
          label={inspectorCopy.operationReply}
          text={operation.responseText}
          empty={
            executionLive || operation.status === 'running' || operation.endedAt === null
              ? inspectorCopy.replyPending
              : inspectorCopy.replyNotRecorded
          }
          testId="operation-reply"
        />
      ) : operation.kind === 'run_headless' ? (
        <Exchange
          label={inspectorCopy.operationOutput}
          text={operation.responseText}
          empty={
            operation.status === 'running'
              ? inspectorCopy.replyPending
              : inspectorCopy.outputNotRecorded
          }
          testId="operation-reply"
        />
      ) : null}
    </article>
  );
}

/** One side of the dialogue: the prompt as sent, or what came back. */
function Exchange({
  label,
  text,
  empty: emptyText = null,
  testId,
}: {
  readonly label: string;
  readonly text: string | null;
  readonly empty?: string | null;
  readonly testId: string;
}) {
  return (
    <details
      open
      className="mt-1.5 border-t border-dashed border-line/25 pt-1.5"
      data-testid={testId}
    >
      <summary className="cursor-pointer font-mono text-[11px] text-fg-subtle marker:content-none">
        {label}
      </summary>
      <div className="mt-1 max-h-56 overflow-auto">
        {text === null ? (
          <p className="font-mono text-[11.5px] text-fg-subtle">{emptyText}</p>
        ) : (
          <TextValue text={text} />
        )}
      </div>
    </details>
  );
}

function promptOf(request: unknown): string | null {
  if (typeof request !== 'object' || request === null) return null;
  const prompt = (request as Record<string, unknown>)['prompt'];
  return typeof prompt === 'string' ? prompt : null;
}

/** The provider's own numbers, verbatim. No total is computed, because none was reported. */
function usageLine(usage: NonNullable<WorkflowOperationDto['usage']>): string {
  const parts: string[] = [];
  if (usage.inputTokens !== null) parts.push(`in ${usage.inputTokens}`);
  if (usage.cacheReadInputTokens !== null) parts.push(`cache read ${usage.cacheReadInputTokens}`);
  if (usage.cacheCreationInputTokens !== null) {
    parts.push(`cache write ${usage.cacheCreationInputTokens}`);
  }
  if (usage.outputTokens !== null) parts.push(`out ${usage.outputTokens}`);
  if (usage.costUsd !== null) parts.push(`$${usage.costUsd.toFixed(4)}`);
  return parts.length === 0 ? inspectorCopy.usageUnknown : parts.join(' · ');
}

function operationTone(status: WorkflowOperationDto['status']): FieldTone {
  switch (status) {
    case 'completed':
      return 'ok';
    case 'failed':
      return 'bad';
    case 'interrupted':
      return 'warn';
    default:
      return 'default';
  }
}

function operationAccent(status: WorkflowOperationDto['status']): string {
  switch (status) {
    case 'completed':
      return 'border-l-green';
    case 'failed':
      return 'border-l-error';
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
