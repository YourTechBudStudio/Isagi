import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { elementAggregate, type ElementAggregate, type VisitAggregation } from './aggregate.js';
import { inspectorCopy } from './copy.js';
import {
  buildLayoutRequest,
  drawnOrder,
  layoutIdentity,
  type LayoutRequest,
  type LayoutResult,
} from './layout.js';
import type { InspectorSelection } from './selection.js';
import { formatDuration } from './timing.js';
import { ancestorKeys, type DeclaredElement, type DeclaredTopology } from './topology.js';
import { useGraphLayout, type LayoutEngineFactory } from './useGraphLayout.js';
import { CheckpointKindTag, CheckpointSubline } from './WorkflowCheckpointNode.js';

/**
 * The graph of the pin the run is on right now, with where it is now drawn on it.
 *
 * Declared answers one question — what does this workflow look like, and where has it got to — and
 * it always answers it about the *current* pin. After a Retry adopts new code it draws the new
 * graph: nodes the new definition added are unvisited, nodes it dropped are simply not here, and
 * their history lives in Trace under the pin that actually ran it. There is no version picker, and
 * old work is never redrawn as though it had run under the definition on screen.
 */
export function WorkflowDeclaredCanvas({
  topology,
  artifactHash,
  aggregation,
  liveKey,
  selection,
  onSelect,
  expanded,
  onToggleExpanded,
  engineFactory,
}: {
  readonly topology: DeclaredTopology;
  /**
   * The pin this topology came from, as the descriptor itself reported it.
   *
   * The identity a layout is keyed on, so a Retry that changes an edge or a node kind without
   * renaming anything still redraws.
   */
  readonly artifactHash: string;
  readonly aggregation: VisitAggregation;
  /** The element the run is positioned at, if the current pin still declares it. */
  readonly liveKey: string | null;
  readonly selection: InspectorSelection | null;
  readonly onSelect: (selection: InspectorSelection) => void;
  readonly expanded: ReadonlySet<string>;
  readonly onToggleExpanded: (key: string) => void;
  readonly engineFactory?: LayoutEngineFactory | undefined;
}) {
  const request: LayoutRequest = useMemo(() => {
    const identity = layoutIdentity({ artifactHash, expanded });
    return buildLayoutRequest({ topology, identity, expanded });
  }, [topology, artifactHash, expanded]);

  const layout = useGraphLayout(request, { factory: engineFactory });

  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-canvas/55">
      <Viewport
        topology={topology}
        aggregation={aggregation}
        result={layout.result}
        liveKey={liveKey}
        selection={selection}
        onSelect={onSelect}
        expanded={expanded}
        onToggleExpanded={onToggleExpanded}
      />
      {layout.pending && layout.result === null && layout.failure === null && (
        <p className="pointer-events-none absolute inset-0 grid place-items-center font-mono text-[12px] text-fg-subtle">
          {inspectorCopy.layoutFirst}
        </p>
      )}
      {/* A layout that failed is said plainly, whether or not a previous drawing is still up.
          Falling back to an empty canvas would read as a workflow with no nodes in it; keeping the
          old positions and saying nothing would show a shape nobody asked for. */}
      {layout.failure !== null &&
        (layout.result === null ? (
          <div className="pointer-events-none absolute inset-0 grid place-items-center">
            <p className="max-w-sm rounded-lg border border-error/40 bg-error/5 px-3 py-2 text-center text-[12.5px] text-fg-muted">
              {inspectorCopy.layoutFailed}
              <span className="mt-1 block font-mono text-[11px] text-fg-subtle">
                {layout.failure}
              </span>
            </p>
          </div>
        ) : (
          <p className="pointer-events-none absolute inset-x-0 bottom-3 mx-auto w-fit rounded-lg border border-error/40 bg-error/10 px-3 py-1.5 text-[12px] text-fg-muted backdrop-blur-sm">
            {inspectorCopy.layoutStale}
          </p>
        ))}
    </div>
  );
}

function Viewport({
  topology,
  aggregation,
  result,
  liveKey,
  selection,
  onSelect,
  expanded,
  onToggleExpanded,
}: {
  readonly topology: DeclaredTopology;
  readonly aggregation: VisitAggregation;
  readonly result: LayoutResult | null;
  readonly liveKey: string | null;
  readonly selection: InspectorSelection | null;
  readonly onSelect: (selection: InspectorSelection) => void;
  readonly expanded: ReadonlySet<string>;
  readonly onToggleExpanded: (key: string) => void;
}) {
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState({ x: 40, y: 30, k: 1 });
  const [dragging, setDragging] = useState(false);
  const fittedRef = useRef<string | null>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });

  /**
   * Which element the keyboard is on, as a roving tab stop.
   *
   * One tab stop for the whole graph rather than one per node: tabbing through forty nodes to reach
   * the dock is not navigation, it is an obstacle. Arrows move within the graph, Tab leaves it.
   */
  const order = useMemo(() => {
    const drawn = new Set((result?.nodes ?? []).map((node) => node.id));
    return drawnOrder(topology, expanded).filter((key) => drawn.has(key));
  }, [topology, expanded, result]);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  /** Set only when the keyboard moved the tab stop, so a pointer focus does not steal it back. */
  const moveFocusRef = useRef(false);

  const tabStop =
    focusedKey !== null && order.includes(focusedKey) ? focusedKey : (order[0] ?? null);

  /**
   * A collapsed graph takes its contents off screen, and the tab stop with them.
   *
   * Focus goes to the nearest registration still drawn — the subgraph node that was just collapsed —
   * rather than to the top of the graph, because that is where the person was.
   */
  useEffect(() => {
    if (focusedKey === null || order.includes(focusedKey)) return;
    const surviving = ancestorKeys(topology, focusedKey)
      .filter((key) => order.includes(key))
      .at(-1);
    moveFocusRef.current = true;
    setFocusedKey(surviving ?? order[0] ?? null);
  }, [focusedKey, order, topology]);

  useEffect(() => {
    if (!moveFocusRef.current || tabStop === null) return;
    moveFocusRef.current = false;
    canvasRef.current
      ?.querySelector<HTMLElement>(`[data-node-key="${cssEscape(tabStop)}"]`)
      ?.focus();
  }, [tabStop]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() =>
      setCanvasSize({ width: canvas.clientWidth, height: canvas.clientHeight }),
    );
    observer.observe(canvas);
    setCanvasSize({ width: canvas.clientWidth, height: canvas.clientHeight });
    return () => observer.disconnect();
  }, []);

  const fit = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !result) return;
    const width = Math.max(result.width, 1);
    const height = Math.max(result.height, 1);
    const scale = Math.min(
      (canvas.clientWidth - 60) / width,
      (canvas.clientHeight - 60) / height,
      1.4,
    );
    const k = Number.isFinite(scale) && scale > 0 ? scale : 1;
    setView({
      k,
      x: (canvas.clientWidth - width * k) / 2,
      y: (canvas.clientHeight - height * k) / 2,
    });
  }, [result]);

  const focusLive = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !result || liveKey === null) return;
    const node = result.nodes.find((candidate) => candidate.id === liveKey);
    if (!node) return;
    setView((current) => ({
      ...current,
      x: canvas.clientWidth / 2 - (node.x + node.width / 2) * current.k,
      y: canvas.clientHeight / 2 - (node.y + node.height / 2) * current.k,
    }));
  }, [liveKey, result]);

  // Fit once per shape, never on a status change: a graph that re-centred itself every time a node
  // finished would move under the reader several times a minute.
  useEffect(() => {
    if (!result || fittedRef.current === result.identity) return;
    fittedRef.current = result.identity;
    fit();
  }, [fit, result]);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (event: PointerEvent) => {
      setView((current) => ({
        ...current,
        x: current.x + event.movementX,
        y: current.y + event.movementY,
      }));
    };
    const onUp = () => setDragging(false);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [dragging]);

  return (
    <>
      <div className="flex flex-none items-center gap-3.5 border-b border-line/20 px-4.5 py-2">
        <div className="ml-auto flex items-center gap-1.5">
          <ZoomButton
            label={inspectorCopy.zoomOut}
            onClick={() =>
              setView((current) => ({ ...current, k: Math.max(0.25, current.k / 1.2) }))
            }
          >
            −
          </ZoomButton>
          <span className="min-w-[2.6rem] text-center font-mono text-[11.5px] text-fg-subtle">
            {Math.round(view.k * 100)}%
          </span>
          <ZoomButton
            label={inspectorCopy.zoomIn}
            onClick={() =>
              setView((current) => ({ ...current, k: Math.min(2.5, current.k * 1.2) }))
            }
          >
            +
          </ZoomButton>
          <ZoomButton label={inspectorCopy.fit} onClick={fit} wide>
            Fit
          </ZoomButton>
          {liveKey !== null && (
            <ZoomButton label={inspectorCopy.focusLive} onClick={focusLive} wide>
              Live
            </ZoomButton>
          )}
        </div>
      </div>

      <div
        ref={canvasRef}
        data-testid="declared-canvas"
        className={`relative min-h-0 flex-1 touch-none overflow-hidden ${
          dragging ? 'cursor-grabbing' : 'cursor-grab'
        }`}
        onKeyDown={(event) => {
          if (order.length === 0) return;
          const index = tabStop === null ? 0 : Math.max(0, order.indexOf(tabStop));
          const move = (next: number) => {
            moveFocusRef.current = true;
            setFocusedKey(order[Math.min(order.length - 1, Math.max(0, next))]!);
          };
          if (event.key === 'ArrowDown' || event.key === 'ArrowRight') move(index + 1);
          else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') move(index - 1);
          else if (event.key === 'Home') move(0);
          else if (event.key === 'End') move(order.length - 1);
          else if (event.key === 'Enter') {
            const element = topology.elements.get(order[index]!);
            if (element) onSelect(selectionFor(element, aggregation));
          } else if (event.key === ' ' || event.key === 'Spacebar') {
            // The same path a double-click takes, so keyboard expansion and pointer expansion ask
            // for exactly one drawing rather than two that have to agree.
            const key = order[index]!;
            const element = topology.elements.get(key);
            if (element?.kind === 'node' && element.descriptor.kind === 'subgraph') {
              onToggleExpanded(key);
            }
          } else {
            return;
          }
          event.preventDefault();
        }}
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) setDragging(true);
        }}
        onWheel={(event) => {
          if (!event.ctrlKey && !event.metaKey && Math.abs(event.deltaY) < 1) return;
          setView((current) => ({
            ...current,
            k: Math.min(2.5, Math.max(0.25, current.k * (event.deltaY > 0 ? 0.92 : 1.08))),
          }));
        }}
      >
        <div
          className="absolute top-0 left-0 origin-top-left"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}
          data-testid="declared-viewport"
        >
          {result && (
            <svg
              width={result.width}
              height={result.height}
              className="pointer-events-none absolute top-0 left-0 overflow-visible"
              aria-hidden
            >
              <defs>
                <marker
                  id="workflow-arrow"
                  viewBox="0 0 8 8"
                  refX="7"
                  refY="4"
                  markerWidth="6.5"
                  markerHeight="6.5"
                  orient="auto"
                >
                  <path d="M0,0 L8,4 L0,8 z" fill="var(--color-blue)" />
                </marker>
                <marker
                  id="workflow-arrow-untaken"
                  viewBox="0 0 8 8"
                  refX="7"
                  refY="4"
                  markerWidth="6.5"
                  markerHeight="6.5"
                  orient="auto"
                >
                  <path d="M0,0 L8,4 L0,8 z" fill="var(--color-line)" />
                </marker>
              </defs>
              {result.edges.map((edge, index) => {
                const taken = aggregation.takenLinks.has(edge.id);
                return (
                  <path
                    key={`${edge.id}-${index}`}
                    d={roundedPath(edge.points)}
                    fill="none"
                    stroke={taken ? 'var(--color-blue)' : 'var(--color-line)'}
                    strokeWidth={taken ? 1.8 : 1.3}
                    strokeDasharray={taken ? undefined : '4 4'}
                    opacity={taken ? 1 : 0.55}
                    markerEnd={`url(#${taken ? 'workflow-arrow' : 'workflow-arrow-untaken'})`}
                  />
                );
              })}
            </svg>
          )}

          {result?.nodes.map((node) => {
            const element = topology.elements.get(node.id);
            if (!element) return null;
            return (
              <GraphNode
                key={node.id}
                element={element}
                aggregate={elementAggregate(aggregation, node.id)}
                now={aggregation.now}
                box={node}
                live={liveKey === node.id}
                selected={isSelected(selection, node.id, aggregation)}
                selection={selection}
                expanded={expanded.has(node.id)}
                focused={tabStop === node.id}
                onFocusKey={setFocusedKey}
                unresolved={topology.unresolvedGraphs.find((entry) => entry.nodeKey === node.id)}
                onSelect={onSelect}
                onToggleExpanded={onToggleExpanded}
              />
            );
          })}
        </div>

        <PinnedBoxNames
          topology={topology}
          result={result}
          view={view}
          canvas={canvasSize}
          onSelect={onSelect}
        />

        {result && result.nodes.length === 0 && (
          <p className="absolute inset-0 grid place-items-center font-mono text-[12px] text-fg-subtle">
            {inspectorCopy.graphEmpty}
          </p>
        )}
      </div>
    </>
  );
}

/**
 * A graph's name, kept on screen while any of it still is.
 *
 * Panning into a deep graph scrolls its header off the top, and without this the boxes around you
 * become unlabelled rectangles — exactly when knowing which graph you are inside matters most. Each
 * pinned name sits at its own box's left edge and is offset by depth, so nested graphs read as
 * nested rather than as a stack of identical chips.
 *
 * Derived entirely from the layout already on screen and the current pan/zoom, so it costs no
 * relayout: it is a different reading of positions ELK has already given.
 */
function PinnedBoxNames({
  topology,
  result,
  view,
  canvas,
  onSelect,
}: {
  readonly topology: DeclaredTopology;
  readonly result: LayoutResult | null;
  readonly view: { readonly x: number; readonly y: number; readonly k: number };
  readonly canvas: { readonly width: number; readonly height: number };
  readonly onSelect: (selection: InspectorSelection) => void;
}) {
  if (result === null || canvas.width === 0) return null;

  const headerHeight = 42 * view.k;
  const pinned = result.nodes
    .filter((node) => {
      if (!node.isBox) return false;
      const left = view.x + node.x * view.k;
      const top = view.y + node.y * view.k;
      const width = node.width * view.k;
      const height = node.height * view.k;
      const onScreen =
        left < canvas.width && left + width > 0 && top < canvas.height && top + height > 0;
      // Only once its own header has gone: a visible header needs no stand-in.
      return onScreen && top + headerHeight < 0;
    })
    .sort((left, right) => left.depth - right.depth);

  if (pinned.length === 0) return null;

  return (
    <div className="pointer-events-none absolute inset-0 z-20">
      {pinned.map((node) => {
        const element = topology.elements.get(node.id);
        if (!element) return null;
        const left = Math.min(
          Math.max(view.x + node.x * view.k, 8),
          Math.max(canvas.width - 220, 8),
        );
        return (
          <button
            key={node.id}
            type="button"
            data-pinned-graph={node.id}
            onClick={() => onSelect({ kind: 'element', key: node.id })}
            style={{ left, top: 8 + node.depth * 26 }}
            className="pointer-events-auto absolute flex items-baseline gap-2 rounded-lg border border-violet/45 bg-canvas/92 px-2.5 py-1 whitespace-nowrap shadow-soft backdrop-blur-sm"
          >
            <span className="font-mono text-[12.5px] text-fg">{element.address.id}</span>
            <span className="font-mono text-[10px] tracking-[0.07em] text-violet uppercase opacity-90">
              {element.kind === 'node' && element.descriptor.kind === 'subgraph'
                ? element.descriptor.graphKey
                : element.graphKey}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function isSelected(
  selection: InspectorSelection | null,
  key: string,
  aggregation: VisitAggregation,
): boolean {
  if (selection === null) return false;
  if (selection.kind === 'element') return selection.key === key;
  if (selection.kind === 'execution' || selection.kind === 'routing') {
    return (
      aggregation.byElement
        .get(key)
        ?.visits.some((visit) => visit.executionId === selection.executionId) === true
    );
  }
  return false;
}

function GraphNode({
  element,
  aggregate,
  now,
  box,
  live,
  selected,
  selection,
  expanded,
  focused,
  onFocusKey,
  unresolved,
  onSelect,
  onToggleExpanded,
}: {
  readonly element: DeclaredElement;
  readonly aggregate: ElementAggregate;
  readonly now: number;
  readonly box: LayoutResult['nodes'][number];
  readonly live: boolean;
  readonly selected: boolean;
  readonly selection: InspectorSelection | null;
  readonly expanded: boolean;
  readonly focused: boolean;
  readonly onFocusKey: (key: string) => void;
  readonly unresolved: { readonly graphKey: string } | undefined;
  readonly onSelect: (selection: InspectorSelection) => void;
  readonly onToggleExpanded: (key: string) => void;
}) {
  const isSubgraph = element.kind === 'node' && element.descriptor.kind === 'subgraph';
  const visited = aggregate.visits.length > 0 || aggregate.status !== 'unvisited';
  const latest = aggregate.visits.at(-1);

  const statusRing = live
    ? 'border-amber bg-amber/11 shadow-[0_0_0_4px_color-mix(in_srgb,var(--color-amber)_14%,transparent)]'
    : selected
      ? 'border-blue shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-blue)_22%,transparent)]'
      : visited
        ? statusBorder(aggregate.status)
        : 'border-dashed border-line/35';

  const stop = {
    'data-node-key': element.key,
    tabIndex: focused ? 0 : -1,
    onFocus: () => onFocusKey(element.key),
  } as const;

  const commonProps = {
    style: {
      left: box.x,
      top: box.y,
      width: box.width,
      height: box.height,
      zIndex: 10 + box.depth * 2,
    },
    'data-element': element.key,
    'data-live': live || undefined,
    'data-status': visited ? aggregate.status : 'unvisited',
  } as const;

  if (box.isBox) {
    return (
      <div
        {...commonProps}
        // The whole graph opens and closes, not just the strip along its top. A nested graph is a
        // sibling in the DOM painted above its parent, so a double-click inside one reaches that
        // graph and stops there; this only ever catches the parent's own surface.
        onDoubleClick={(event) => {
          event.stopPropagation();
          onToggleExpanded(element.key);
        }}
        className={`absolute flex flex-col items-stretch rounded-md border bg-canvas/55 ${
          live ? 'border-amber/55 bg-amber/4' : selected ? 'border-blue' : 'border-violet/34'
        }`}
      >
        <button
          type="button"
          {...stop}
          onClick={() => onSelect({ kind: 'element', key: element.key })}
          aria-expanded={expanded}
          className="flex h-10.5 flex-none items-center gap-2 border-b border-line/22 px-3.5 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-blue"
        >
          <span className="truncate font-mono text-[13.5px] text-fg">{element.address.id}</span>
          {latest?.displayName && (
            <span className="min-w-0 truncate text-[12px] text-fg-muted">{latest.displayName}</span>
          )}
          <span className="ml-auto flex-none font-mono text-[10px] tracking-[0.07em] text-violet uppercase opacity-85">
            {element.kind === 'node' && element.descriptor.kind === 'subgraph'
              ? element.descriptor.graphKey
              : element.graphKey}
          </span>
          <span
            className="flex-none rounded-md border border-line/35 px-1.5 font-mono text-[10.5px] text-fg-subtle"
            aria-label={inspectorCopy.collapse}
          >
            ▾
          </span>
        </button>
      </div>
    );
  }

  if (element.kind === 'edge') {
    // An arrow, not a card. The shell carries the outline colour and the face sits a pixel inside
    // it; a clipped shape cannot take a border, so the gap between the two polygons is the border.
    const shellTone = live
      ? 'bg-amber'
      : selected
        ? 'bg-blue'
        : aggregate.status === 'failed'
          ? 'bg-error/70'
          : aggregate.status === 'unvisited'
            ? 'bg-line/45'
            : 'bg-blue/55';
    return (
      <button
        {...commonProps}
        {...stop}
        type="button"
        onClick={() =>
          onSelect(latestRoutingSelection(aggregate) ?? { kind: 'element', key: element.key })
        }
        className="absolute text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue"
      >
        <span aria-hidden className={`workflow-edge-shell ${shellTone}`} />
        <span
          className={`workflow-edge-face flex flex-col justify-center py-2 pr-7 pl-3.5 ${
            live ? 'bg-amber/12' : 'bg-elevated'
          }`}
        >
          <span className="font-mono text-[9.5px] tracking-widest text-blue uppercase opacity-90">
            edge fn
          </span>
          <span className="mt-0.5 flex items-baseline gap-2 font-mono text-[12.5px] text-fg">
            <span className="truncate">{element.address.id}</span>
            <TimeBadge aggregate={aggregate} now={now} />
          </span>
          <span className="mt-2 flex flex-wrap gap-1">
            {element.descriptor.to.map((destination) => {
              const chosen = aggregate.chosenDestinations.includes(destination);
              return (
                <span
                  key={destination}
                  className={`rounded px-1.5 font-mono text-[10px] whitespace-nowrap ${
                    chosen
                      ? 'border border-green/50 bg-green/10 text-green'
                      : 'border border-dashed border-line/55 text-fg-subtle'
                  }`}
                >
                  {chosen ? '→ ' : ''}
                  {destination}
                </span>
              );
            })}
          </span>
        </span>
      </button>
    );
  }

  if (element.kind === 'outcome') {
    return (
      <button
        {...commonProps}
        {...stop}
        type="button"
        onClick={() => onSelect({ kind: 'element', key: element.key })}
        className={`absolute flex items-center justify-center rounded-3xl border bg-elevated/97 px-3.5 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue ${statusRing}`}
      >
        <span className="flex w-full items-baseline gap-2">
          <span
            aria-hidden
            className={`size-1.75 flex-none rounded-full ${
              element.descriptor.kind === 'failure' ? 'bg-error' : 'bg-green'
            }`}
          />
          <span className="truncate font-mono text-[13.5px] text-fg">{element.address.id}</span>
        </span>
      </button>
    );
  }

  /**
   * A closed graph keeps the grammar of an open one.
   *
   * A subgraph and an operation were two rounded rectangles that differed only in what their
   * sub-line happened to say, which is not a distinction anyone reads at a glance. An open graph
   * already announces itself with a violet header strip carrying its graph key; a closed one now
   * wears the same strip with the caret turned. The rule is legible without reading a word: a header
   * strip means a graph, and no strip means a step.
   */
  if (isSubgraph) {
    return (
      <div
        {...commonProps}
        // Opening is the same gesture on the same surface as closing: the whole card, not the strip.
        onDoubleClick={(event) => {
          event.stopPropagation();
          onToggleExpanded(element.key);
        }}
        className={`absolute flex flex-col overflow-hidden rounded-md border bg-canvas/55 ${
          live ? 'border-amber/55 bg-amber/4' : selected ? 'border-blue' : 'border-violet/34'
        }`}
      >
        <button
          type="button"
          {...stop}
          onClick={() => onSelect(latestVisitSelection(aggregate, element.key))}
          aria-expanded={expanded}
          className="flex h-8 flex-none items-center gap-2 border-b border-violet/22 px-3 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-blue"
        >
          <span className="truncate font-mono text-[12.5px] text-fg">{element.address.id}</span>
          {latest?.displayName && (
            <span className="min-w-0 truncate text-[11.5px] text-fg-muted">
              {latest.displayName}
            </span>
          )}
          <span className="ml-auto flex-none font-mono text-[10px] tracking-[0.07em] text-violet uppercase opacity-85">
            {element.descriptor.kind === 'subgraph'
              ? element.descriptor.graphKey
              : element.graphKey}
          </span>
          <span
            aria-hidden
            className="flex-none rounded-md border border-line/35 px-1.5 font-mono text-[10.5px] text-fg-subtle"
          >
            ▸
          </span>
        </button>
        <div className="flex min-h-0 flex-1 flex-col justify-center px-3 py-1.5">
          <span className="flex items-baseline gap-2">
            <span
              aria-hidden
              className={`size-1.75 flex-none self-center rounded-full ${statusDot(
                visited ? aggregate.status : 'unvisited',
              )}`}
            />
            <span className="truncate font-mono text-[10.5px] text-fg-subtle">
              <NodeSubline
                element={element}
                aggregate={aggregate}
                unresolvedGraphKey={unresolved?.graphKey ?? null}
              />
            </span>
            <EvidenceCount element={element} aggregate={aggregate} />
            <TimeBadge aggregate={aggregate} now={now} />
          </span>
          <VisitPips aggregate={aggregate} selection={selection} onSelect={onSelect} />
        </div>
      </div>
    );
  }

  return (
    <div
      {...commonProps}
      className={`absolute flex flex-col justify-center overflow-hidden rounded-md border bg-elevated/97 px-3 py-2.5 ${statusRing} ${
        visited ? '' : 'bg-elevated/40'
      }`}
    >
      <button
        type="button"
        {...stop}
        onClick={() => onSelect(latestVisitSelection(aggregate, element.key))}
        className="text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue"
      >
        <span className="flex items-baseline gap-2">
          <span
            aria-hidden
            className={`size-1.75 flex-none self-center rounded-full ${statusDot(
              visited ? aggregate.status : 'unvisited',
            )}`}
          />
          <span
            className={`truncate font-mono text-[13.5px] ${visited ? 'text-fg' : 'text-fg-subtle'}`}
          >
            {element.address.id}
          </span>
          {element.kind === 'node' && element.descriptor.kind === 'checkpoint' ? (
            // The slot a subgraph's violet tag takes, in the cyan the canvas uses for kept things.
            <span className="ml-auto flex flex-none items-baseline gap-2">
              <CheckpointKindTag />
              <TimeBadge aggregate={aggregate} now={now} />
            </span>
          ) : (
            <TimeBadge aggregate={aggregate} now={now} />
          )}
        </span>
        <span className="mt-1.5 flex items-center gap-2 font-mono text-[10.5px] text-fg-subtle">
          <span className="min-w-0 truncate">
            <NodeSubline
              element={element}
              aggregate={aggregate}
              unresolvedGraphKey={unresolved?.graphKey ?? null}
            />
          </span>
          <EvidenceCount element={element} aggregate={aggregate} />
        </span>
      </button>
      <VisitPips aggregate={aggregate} selection={selection} onSelect={onSelect} />
    </div>
  );
}

/**
 * One pip per visit, in the strip every node reserves whether or not it has any.
 *
 * The strip is reserved from the first layout, so a second visit fills space that was already there
 * rather than growing the node and forcing the graph to be laid out again. Dense contents scroll
 * inside it for the same reason.
 */
function VisitPips({
  aggregate,
  selection,
  onSelect,
}: {
  readonly aggregate: ElementAggregate;
  readonly selection: InspectorSelection | null;
  readonly onSelect: (selection: InspectorSelection) => void;
}) {
  if (aggregate.visits.length <= 1) return null;
  return (
    <span className="mt-2 flex gap-1 overflow-x-auto">
      {aggregate.visits.map((visit) => {
        const active =
          (selection?.kind === 'execution' || selection?.kind === 'routing') &&
          selection.executionId === visit.executionId;
        return (
          <button
            key={visit.executionId}
            type="button"
            title={`execution ${visit.executionId}`}
            aria-label={`Visit ${visit.visitIndex + 1}, execution ${visit.executionId}`}
            onClick={(event) => {
              event.stopPropagation();
              onSelect({ kind: 'execution', executionId: visit.executionId });
            }}
            onDoubleClick={(event) => event.stopPropagation()}
            className={`flex-none rounded-full border px-1.5 font-mono text-[10.5px] ${pipTone(
              visit.status,
            )} ${active ? 'ring-2 ring-blue/45' : ''}`}
          >
            {visit.visitIndex + 1}
          </button>
        );
      })}
    </span>
  );
}

/**
 * How much this element's visits kept, as a count rather than a control.
 *
 * Its own component because a collapsed subgraph card and an operation card are two renderers in
 * this file, and a badge added to one of them is a badge a subgraph silently never shows.
 *
 * The number is `ElementAggregate.evidenceCaptured`: the sum over this element's visits, which is
 * safe only because visits of one element are disjoint executions whose subtrees do not overlap.
 * Summing the same field across *elements* is forbidden — a nested capture would be counted once
 * for its own node and again for every subgraph containing it. A subgraph therefore spells it
 * `n inside`, matching its trace row, so nobody adds two figures that already contain each other.
 *
 * Clicking the node still selects its latest visit; this changes nothing.
 */
function EvidenceCount({
  element,
  aggregate,
}: {
  readonly element: DeclaredElement;
  readonly aggregate: ElementAggregate;
}) {
  if (aggregate.evidenceCaptured === 0) return null;
  const inside = element.kind === 'node' && element.descriptor.kind === 'subgraph';
  return (
    <span className="ml-auto flex-none rounded-full border border-cyan/35 px-1.5 font-mono text-[10px] leading-4 text-cyan">
      {inside
        ? inspectorCopy.evidenceInside(aggregate.evidenceCaptured)
        : aggregate.evidenceCaptured}
    </span>
  );
}

function NodeSubline({
  element,
  aggregate,
  unresolvedGraphKey,
}: {
  readonly element: DeclaredElement;
  readonly aggregate: ElementAggregate;
  readonly unresolvedGraphKey: string | null;
}) {
  if (unresolvedGraphKey !== null) {
    return (
      <span className="text-amber">{inspectorCopy.subgraphUnresolved(unresolvedGraphKey)}</span>
    );
  }
  if (element.kind === 'node' && element.descriptor.kind === 'subgraph') {
    // The graph key is already in the header strip above this line; repeating it here would spend
    // the one line the body has on something already on screen.
    if (aggregate.visits.length === 0) return <>{inspectorCopy.notVisited}</>;
    const executions = aggregate.nestedExecutionCount;
    return <>{`${executions} execution${executions === 1 ? '' : 's'} inside`}</>;
  }
  if (element.kind === 'node' && element.descriptor.kind === 'checkpoint') {
    return <CheckpointSubline title={element.descriptor.title} aggregate={aggregate} />;
  }
  if (aggregate.visits.length === 0) return <>{inspectorCopy.notVisited}</>;

  const latest = aggregate.visits.at(-1);
  if (latest?.wait) {
    return (
      <>
        {latest.wait.status === 'armed' ? inspectorCopy.waitOpen : 'answered'} ·{' '}
        {latest.wait.kind === 'user_continue'
          ? 'continue'
          : `${latest.wait.questions?.length ?? 0} questions`}
      </>
    );
  }
  return (
    <>{aggregate.capabilities.length > 0 ? aggregate.capabilities.join(' · ') : 'no operations'}</>
  );
}

function TimeBadge({
  aggregate,
  now: _now,
}: {
  readonly aggregate: ElementAggregate;
  readonly now: number;
}) {
  if (aggregate.visits.length === 0 && aggregate.callbackMs === 0) {
    return (
      <span className="ml-auto flex-none font-mono text-[12px] text-fg-subtle opacity-45">—</span>
    );
  }
  const total = aggregate.callbackMs + aggregate.waitMs;
  const open = aggregate.callbackOpen || aggregate.waitOpen;
  return (
    <span
      className={`ml-auto flex-none font-mono text-[12px] ${open ? 'text-amber' : 'text-fg-muted'}`}
    >
      {aggregate.hasUnknownEnd && !open ? '≥ ' : ''}
      {formatDuration(total)}
      {open ? ' · open' : ''}
    </span>
  );
}

/** What selecting an element means, wherever the selection came from. */
function selectionFor(element: DeclaredElement, aggregation: VisitAggregation): InspectorSelection {
  const aggregate = elementAggregate(aggregation, element.key);
  if (element.kind === 'edge') {
    return latestRoutingSelection(aggregate) ?? { kind: 'element', key: element.key };
  }
  if (element.kind === 'outcome') return { kind: 'element', key: element.key };
  return latestVisitSelection(aggregate, element.key);
}

/**
 * A CSS attribute-selector-safe form of an element key.
 *
 * Keys carry `/` and `:` from registration paths, which are legal in an attribute value and not in
 * an unescaped selector.
 */
function cssEscape(value: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(value)
    : value.replace(/["\\]/g, '\\$&');
}

function latestVisitSelection(aggregate: ElementAggregate, key: string): InspectorSelection {
  const latest = aggregate.visits.at(-1);
  return latest ? { kind: 'execution', executionId: latest.executionId } : { kind: 'element', key };
}

function latestRoutingSelection(aggregate: ElementAggregate): InspectorSelection | null {
  const latest = aggregate.visits.at(-1);
  return latest ? { kind: 'routing', executionId: latest.executionId } : null;
}

function ZoomButton({
  label,
  onClick,
  wide,
  children,
}: {
  readonly label: string;
  readonly onClick: () => void;
  readonly wide?: boolean | undefined;
  readonly children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={`h-6.5 rounded-md border border-line/30 bg-elevated/70 font-mono text-[12px] text-fg-muted transition duration-micro ease-expo hover:border-line/70 hover:text-fg ${
        wide ? 'px-2.5' : 'w-[26px]'
      }`}
    >
      {children}
    </button>
  );
}

function statusBorder(status: ElementAggregate['status']): string {
  switch (status) {
    case 'failed':
      return 'border-error/45 bg-error/7';
    case 'completed':
      return 'border-green/26';
    case 'awaiting':
      return 'border-waiting/45';
    default:
      return 'border-line/45';
  }
}

function statusDot(status: ElementAggregate['status'] | 'unvisited'): string {
  switch (status) {
    case 'failed':
      return 'bg-error';
    case 'completed':
      return 'bg-green';
    case 'awaiting':
      return 'bg-waiting';
    case 'running':
    case 'routing':
    case 'mapping':
      return 'bg-working';
    default:
      return 'bg-fg-subtle';
  }
}

function pipTone(status: string): string {
  switch (status) {
    case 'failed':
      return 'border-error/50 text-error';
    case 'completed':
      return 'border-green/35 text-green';
    case 'awaiting':
      return 'border-waiting bg-waiting/14 text-waiting';
    default:
      return 'border-line/40 bg-canvas/70 text-fg-subtle';
  }
}

/** Orthogonal routing with softened corners, so a dense graph stays readable at a glance. */
function roundedPath(points: readonly { readonly x: number; readonly y: number }[]): string {
  if (points.length < 2) return '';
  let path = `M${points[0]!.x},${points[0]!.y}`;
  for (let index = 1; index < points.length - 1; index += 1) {
    const point = points[index]!;
    const previous = points[index - 1]!;
    const next = points[index + 1]!;
    const radius = 8;
    const inX = Math.sign(point.x - previous.x);
    const inY = Math.sign(point.y - previous.y);
    const outX = Math.sign(next.x - point.x);
    const outY = Math.sign(next.y - point.y);
    path += ` L${point.x - inX * radius},${point.y - inY * radius} Q${point.x},${point.y} ${
      point.x + outX * radius
    },${point.y + outY * radius}`;
  }
  const last = points.at(-1)!;
  return `${path} L${last.x},${last.y}`;
}
