import { useEffect, useMemo, useRef, useState } from 'react';

import { inspectorCopy } from './copy.js';
import { selectionEquals, type InspectorSelection } from './selection.js';
import { formatDuration } from './timing.js';
import type { TraceExecutionRow, TraceFrameRow, TraceModel } from './trace.js';

type Fraction = (at: number) => number;
type BandOf = (interval: { readonly start: number; readonly end: number | null }) => {
  readonly left: number;
  readonly width: number;
};

/**
 * How long a row has been going, given the clock.
 *
 * `null` where no honest number exists: an unknown end is not a duration, and stretching it to now
 * would turn something nobody observed into a measurement.
 */
function elapsedOf(
  row: {
    readonly startedAt: number;
    readonly endedAt: number | null;
    readonly endUnknown: boolean;
  },
  now: number,
): number | null {
  if (row.endUnknown) return null;
  return Math.max(0, (row.endedAt ?? now) - row.startedAt);
}

const rowHeight = 32;
/** Rows rendered above and below the viewport, so scrolling never reveals a blank band. */
const overscan = 8;

/**
 * What actually ran, in order, on one run clock.
 *
 * Every visit is a row, including every revisit of the same node and every visit of a node the
 * current definition no longer declares. A repaired execution stays *one* row with its attempts
 * summarized, because it is one visit that was tried twice — not two visits.
 *
 * Callback time and wait time are drawn as separate bars rather than summed. A node that thought for
 * two seconds and then waited nine minutes for a person is not a nine-minute-two-second step, and
 * one bar would say that it was.
 *
 * Rows are windowed, because history is retained indefinitely and a run with thousands of visits
 * would otherwise mount thousands of nodes. The scroll geometry is the full list, keyboard
 * navigation walks the full list, and selecting an offscreen row scrolls it into view — windowing is
 * a rendering decision and never a reachability one.
 */
export function WorkflowTraceWaterfall({
  model,
  now,
  selection,
  liveExecutionId,
  onSelect,
  onToggleExpanded,
}: {
  readonly model: TraceModel;
  /**
   * The display clock.
   *
   * It reaches only this far: the model is built from recorded instants alone, and the clock is
   * applied to the handful of rows actually mounted. A tick therefore costs what is on screen, not
   * what the run has accumulated.
   */
  readonly now: number;
  readonly selection: InspectorSelection | null;
  readonly liveExecutionId: number | null;
  readonly onSelect: (selection: InspectorSelection) => void;
  readonly onToggleExpanded: (executionId: number) => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  /**
   * Zero until measured, deliberately.
   *
   * A guessed height mounts a screenful of rows and then unmounts half of them once the real size
   * arrives — visible churn, and rows that detach from under a pointer mid-click. One frame with no
   * rows is cheaper than a frame with the wrong ones.
   */
  const [viewportHeight, setViewportHeight] = useState(0);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setViewportHeight(element.clientHeight));
    observer.observe(element);
    setViewportHeight(element.clientHeight);
    return () => observer.disconnect();
  }, []);

  const clockEnd = model.endedAt ?? now;
  // A little headroom, so a bar reaching the end of the clock stays distinguishable from the marker.
  const span = Math.max(clockEnd - model.startedAt, 1) * 1.08;
  const fraction = (at: number) => clamp01((at - model.startedAt) / span);
  const bandOf = (interval: { readonly start: number; readonly end: number | null }) => {
    const start = fraction(interval.start);
    return { left: start, width: Math.max(fraction(interval.end ?? clockEnd) - start, 0.002) };
  };

  const rows = model.visible;
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const last = Math.min(
    rows.length,
    Math.ceil((scrollTop + viewportHeight) / rowHeight) + overscan,
  );
  const windowed = rows.slice(first, last);

  const selectedIndex = useMemo(
    () => rows.findIndex((row) => selectionEquals(row.selection, selection)),
    [rows, selection],
  );

  // A selection made anywhere else — a pip on Declared, a keyboard move — must be visible here, even
  // when its row is outside the window that is currently mounted.
  useEffect(() => {
    if (selectedIndex < 0) return;
    const element = scrollRef.current;
    if (!element) return;
    const top = selectedIndex * rowHeight;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (top + rowHeight > element.scrollTop + element.clientHeight) {
      element.scrollTop = top + rowHeight - element.clientHeight;
    }
  }, [selectedIndex]);

  if (model.rows.length === 0) {
    return (
      <div className="grid min-h-0 flex-1 place-items-center bg-canvas/55">
        <p className="font-mono text-[12px] text-fg-subtle">{inspectorCopy.traceEmpty}</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-canvas/55">
      <div className="relative flex h-7.5 flex-none items-center border-b border-line/25">
        {/* In the label gutter, not out on the clock: on the right it sat under the now marker, and
            two things in the same place is one of them unreadable. */}
        <span className="flex w-85 flex-none items-center gap-3 pl-3 font-mono text-[10.5px] text-fg-subtle">
          <Legend className="bg-green/80">{inspectorCopy.traceLegendRun}</Legend>
          <Legend className="bg-green/28">{inspectorCopy.traceLegendWait}</Legend>
          <Legend className="bg-violet/28">{inspectorCopy.traceLegendSubgraph}</Legend>
        </span>
        <span className="relative h-full flex-1">
          {model.pauses.map((pause, index) => {
            const band = bandOf(pause);
            return (
              <span
                key={index}
                aria-hidden
                className="absolute top-0 bottom-0 bg-idle/15"
                style={{ left: `${band.left * 100}%`, width: `${band.width * 100}%` }}
              />
            );
          })}
          <span
            className="absolute top-0 bottom-0 border-l border-amber/55"
            style={{ left: `${fraction(clockEnd) * 100}%` }}
          >
            <span className="absolute top-2 -left-3 font-mono text-[10.5px] text-amber">
              {model.ended ? inspectorCopy.traceEnded : inspectorCopy.traceNow}
            </span>
          </span>
        </span>
      </div>

      <div
        ref={scrollRef}
        className="relative min-h-0 flex-1 overflow-y-auto"
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        role="tree"
        aria-label="Executions"
        tabIndex={0}
        onKeyDown={(event) => {
          if (rows.length === 0) return;
          const index = selectedIndex < 0 ? 0 : selectedIndex;
          if (event.key === 'ArrowDown') {
            onSelect(rows[Math.min(rows.length - 1, index + 1)]!.selection);
          } else if (event.key === 'ArrowUp') {
            onSelect(rows[Math.max(0, index - 1)]!.selection);
          } else if (event.key === 'Home') {
            onSelect(rows[0]!.selection);
          } else if (event.key === 'End') {
            onSelect(rows[rows.length - 1]!.selection);
          } else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
            const row = rows[index];
            if (
              row?.kind === 'execution' &&
              row.expandable &&
              row.expanded === (event.key === 'ArrowLeft')
            ) {
              onToggleExpanded(row.executionId);
            }
          } else {
            return;
          }
          event.preventDefault();
        }}
      >
        <div style={{ height: rows.length * rowHeight }} className="relative">
          {windowed.map((row, offset) =>
            row.kind === 'frame' ? (
              <FrameRow
                key={`frame-${row.frameId}`}
                row={row}
                top={(first + offset) * rowHeight}
                selected={selectionEquals(row.selection, selection)}
                pauses={model.pauses}
                now={now}
                fraction={fraction}
                bandOf={bandOf}
                onSelect={onSelect}
              />
            ) : (
              <Row
                key={`execution-${row.executionId}`}
                row={row}
                top={(first + offset) * rowHeight}
                selected={selectionEquals(row.selection, selection)}
                live={row.executionId === liveExecutionId}
                pauses={model.pauses}
                now={now}
                fraction={fraction}
                bandOf={bandOf}
                onSelect={onSelect}
                onToggleExpanded={onToggleExpanded}
              />
            ),
          )}
        </div>
      </div>
    </div>
  );
}

function Row({
  row,
  top,
  selected,
  live,
  pauses,
  now,
  fraction,
  bandOf,
  onSelect,
  onToggleExpanded,
}: {
  readonly row: TraceExecutionRow;
  readonly top: number;
  readonly selected: boolean;
  readonly live: boolean;
  readonly pauses: TraceModel['pauses'];
  readonly now: number;
  readonly fraction: Fraction;
  readonly bandOf: BandOf;
  readonly onSelect: (selection: InspectorSelection) => void;
  readonly onToggleExpanded: (executionId: number) => void;
}) {
  return (
    <div
      role="treeitem"
      aria-selected={selected}
      aria-level={row.depth + 1}
      {...(row.expandable ? { 'aria-expanded': row.expanded } : {})}
      data-execution={row.executionId}
      data-live={live || undefined}
      className={`absolute right-0 left-0 flex cursor-pointer items-center border-l-2 ${
        selected
          ? 'border-l-blue bg-blue/12'
          : live
            ? 'border-l-transparent bg-amber/9'
            : 'border-l-transparent hover:bg-line/12'
      }`}
      style={{ top, height: rowHeight }}
      onClick={() => onSelect(row.selection)}
      onDoubleClick={() => row.expandable && onToggleExpanded(row.executionId)}
    >
      <span
        className="flex w-85 min-w-0 flex-none items-center gap-1.5 pr-3.5"
        style={{ paddingLeft: 10 + row.depth * 17 }}
      >
        <span className="w-3.5 flex-none text-center text-[9px] text-fg-subtle">
          {row.expandable ? (row.expanded ? '▾' : '▸') : ''}
        </span>
        <span aria-hidden className={`size-1.5 flex-none rounded-full ${dotTone(row.status)}`} />
        <span
          className={`truncate font-mono text-[12px] ${row.isSubgraph ? 'text-violet' : 'text-fg'}`}
        >
          {row.nodeId}
        </span>
        {row.repeated && (
          <span className="flex-none font-mono text-[11px] text-fg-subtle">
            #{row.visitIndex + 1}
          </span>
        )}
        {row.displayName && (
          <span className="min-w-0 truncate text-[11.5px] text-fg-muted">{row.displayName}</span>
        )}
        {row.labelDiagnostic && (
          <span
            className="flex-none font-mono text-[10.5px] text-amber"
            title={row.labelDiagnostic}
          >
            label?
          </span>
        )}
        <span
          className={`ml-auto flex-none font-mono text-[11.5px] ${
            elapsedOf(row, now) === null ? 'text-amber' : 'text-fg-muted'
          }`}
        >
          {elapsedOf(row, now) === null
            ? inspectorCopy.durationUnknown
            : formatDuration(elapsedOf(row, now)!)}
        </span>
      </span>

      <span className="relative h-full flex-1 border-l border-line/18">
        {pauses.map((pause, index) => (
          <span
            key={index}
            aria-hidden
            className="absolute top-0 bottom-0 bg-idle/12"
            style={{ left: `${bandOf(pause).left * 100}%`, width: `${bandOf(pause).width * 100}%` }}
          />
        ))}
        {row.bars.map((bar, index) => {
          const band = bandOf(bar);
          return (
            <span
              key={index}
              aria-hidden
              data-bar={bar.kind}
              className={`absolute rounded-[4px] ${barTone(bar.kind, row.status, bar.open)}`}
              style={{
                left: `${band.left * 100}%`,
                width: `${Math.max(band.width * 100, 0.25)}%`,
                top: bar.kind === 'span' ? 12 : 10,
                height: bar.kind === 'span' ? 8 : 12,
              }}
            />
          );
        })}
        {row.routing && (
          <button
            type="button"
            aria-label={`Routing for ${row.nodeId}`}
            onClick={(event) => {
              event.stopPropagation();
              onSelect(row.routing!.selection);
            }}
            className={`absolute top-2.75 size-2.5 rotate-45 rounded-[1px] border ${
              row.routing.failed ? 'border-error bg-error/40' : 'border-blue bg-blue/28'
            }`}
            style={{ left: `calc(${fraction(row.routing.at) * 100}% - 5px)` }}
          />
        )}
        {row.outcome && (
          <button
            type="button"
            aria-label={`Outcome ${row.outcome.outcomeId}`}
            onClick={(event) => {
              event.stopPropagation();
              onSelect(row.outcome!.selection);
            }}
            className={`absolute top-2.5 rounded-full border px-1.5 font-mono text-[9.5px] leading-3 ${
              row.outcome.kind === 'failure'
                ? 'border-error/50 bg-error/12 text-error'
                : 'border-green/50 bg-green/12 text-green'
            }`}
            style={{ left: `calc(${fraction(row.outcome.at) * 100}% + 6px)` }}
          >
            {row.outcome.outcomeId}
          </button>
        )}
      </span>
    </div>
  );
}

function Legend({
  className,
  children,
}: {
  readonly className: string;
  readonly children: string;
}) {
  return (
    <span className="flex items-center gap-1.5">
      <span aria-hidden className={`inline-block h-2 w-3.5 rounded-sm ${className}`} />
      {children}
    </span>
  );
}

/**
 * A graph's own lifecycle, drawn as a lifecycle and not as a step.
 *
 * Visually distinct on purpose: it is the frame, not a visit to a node, and the two must never be
 * read as the same kind of thing. Its markers are the only way to reach a graph's setup and result
 * code, which is what a run whose init threw has instead of executions.
 */
function FrameRow({
  row,
  top,
  selected,
  pauses,
  now,
  fraction,
  bandOf,
  onSelect,
}: {
  readonly row: TraceFrameRow;
  readonly top: number;
  readonly selected: boolean;
  readonly pauses: TraceModel['pauses'];
  readonly now: number;
  readonly fraction: Fraction;
  readonly bandOf: BandOf;
  readonly onSelect: (selection: InspectorSelection) => void;
}) {
  return (
    <div
      role="treeitem"
      aria-selected={selected}
      aria-level={row.depth + 1}
      data-frame={row.frameId}
      className={`absolute right-0 left-0 flex cursor-pointer items-center border-l-2 ${
        selected ? 'border-l-blue bg-blue/12' : 'border-l-transparent hover:bg-line/12'
      }`}
      style={{ top, height: rowHeight }}
      onClick={() => onSelect(row.selection)}
    >
      <span
        className="flex w-85 min-w-0 flex-none items-center gap-1.5 pr-3.5"
        style={{ paddingLeft: 10 + row.depth * 17 }}
      >
        <span aria-hidden className="w-3.5 flex-none" />
        <span
          aria-hidden
          className={`size-1.5 flex-none rotate-45 ${
            row.status === 'failed'
              ? 'bg-error'
              : row.status === 'completed'
                ? 'bg-green'
                : 'bg-violet'
          }`}
        />
        <span className="truncate font-mono text-[12px] text-violet">{row.graphKey}</span>
        <span className="flex-none font-mono text-[10.5px] tracking-[0.06em] text-fg-subtle uppercase">
          graph
        </span>
        {row.displayName && (
          <span className="min-w-0 truncate text-[11.5px] text-fg-muted">{row.displayName}</span>
        )}
        <span
          className={`ml-auto flex-none font-mono text-[11.5px] ${
            elapsedOf(row, now) === null ? 'text-amber' : 'text-fg-muted'
          }`}
        >
          {elapsedOf(row, now) === null
            ? inspectorCopy.durationUnknown
            : formatDuration(elapsedOf(row, now)!)}
        </span>
      </span>

      <span className="relative h-full flex-1 border-l border-line/18">
        {pauses.map((pause, index) => {
          const band = bandOf(pause);
          return (
            <span
              key={index}
              aria-hidden
              className="absolute top-0 bottom-0 bg-idle/12"
              style={{ left: `${band.left * 100}%`, width: `${band.width * 100}%` }}
            />
          );
        })}
        {row.bars.map((bar, index) => {
          const band = bandOf(bar);
          return (
            <span
              key={index}
              aria-hidden
              data-bar={bar.kind}
              className={`absolute top-3.5 h-1 rounded-xs ${
                row.status === 'failed' ? 'bg-error/40' : 'bg-violet/35'
              }`}
              style={{ left: `${band.left * 100}%`, width: `${Math.max(band.width * 100, 0.25)}%` }}
            />
          );
        })}
        {row.entry && (
          <button
            type="button"
            aria-label={`Graph entry for ${row.graphKey}`}
            data-marker="entry"
            onClick={(event) => {
              event.stopPropagation();
              onSelect(row.entry!.selection);
            }}
            className={`absolute top-2.75 size-2.5 rounded-xs border ${
              row.entry.failed ? 'border-error bg-error/40' : 'border-violet bg-violet/28'
            }`}
            style={{ left: `calc(${fraction(row.entry.at) * 100}% - 5px)` }}
          />
        )}
        {row.output && (
          <button
            type="button"
            aria-label={`Graph output for ${row.graphKey}`}
            data-marker="output"
            onClick={(event) => {
              event.stopPropagation();
              onSelect(row.output!.selection);
            }}
            className={`absolute top-2.5 rounded-full border px-1.5 font-mono text-[9.5px] leading-3 ${
              row.output.kind === 'failure'
                ? 'border-error/50 bg-error/12 text-error'
                : row.output.kind === 'unresolved'
                  ? 'border-amber/50 bg-amber/12 text-amber'
                  : 'border-green/50 bg-green/12 text-green'
            }`}
            style={{ left: `calc(${fraction(row.output.at) * 100}% + 6px)` }}
          >
            {row.output.label}
          </button>
        )}
      </span>
    </div>
  );
}

function dotTone(status: TraceExecutionRow['status']): string {
  switch (status) {
    case 'failed':
      return 'bg-error';
    case 'completed':
      return 'bg-green';
    case 'awaiting':
      return 'bg-waiting';
    default:
      return 'bg-working';
  }
}

function barTone(
  kind: 'callback' | 'wait' | 'span',
  status: TraceExecutionRow['status'],
  open: boolean,
): string {
  if (kind === 'span') return status === 'failed' ? 'bg-error/30' : 'bg-violet/28';
  if (kind === 'wait') {
    return open ? 'bg-gradient-to-r from-amber/55 to-amber/10' : 'bg-green/28';
  }
  if (status === 'failed') return 'bg-error/85';
  return open ? 'bg-working/80' : 'bg-green/80';
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
