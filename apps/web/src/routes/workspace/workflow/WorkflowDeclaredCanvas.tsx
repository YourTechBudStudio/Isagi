import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';

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
import { CheckpointKindTag } from './WorkflowCheckpointNode.js';

/**
 * The graph of the build the run is on right now, with where it is now drawn on it.
 *
 * Declared answers one question — what does this workflow look like, and where has it got to — and
 * it always answers it about the *current* build. After a Resume or Retry reloads newer code it draws the new
 * graph: nodes the new definition added are unvisited, nodes it dropped are simply not here, and
 * their history lives in Trace under the build that actually ran it. There is no version picker, and
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
   * The build this topology came from, as the descriptor itself reported it.
   *
   * The identity a layout is keyed on, so a Retry that changes an edge or a node kind without
   * renaming anything still redraws.
   */
  readonly artifactHash: string;
  readonly aggregation: VisitAggregation;
  /** The element the run is positioned at, if the current build still declares it. */
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

  /**
   * Hands keyboard focus to a drawn node, which makes it the tab stop through its own `onFocus`.
   *
   * A knob is not a stop of its own, so a click on one gives focus to its node: Enter and Space then
   * act on the node whose router was just clicked, not on whichever node had focus before.
   */
  const focusNode = useCallback((key: string) => {
    canvasRef.current
      ?.querySelector<HTMLElement>(`[data-node-key="${cssEscape(key)}"]`)
      ?.focus({ preventScroll: true });
  }, []);

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
          {result && <ArrowLayers edges={result.edges} takenLinks={aggregation.takenLinks} />}

          {result?.nodes.map((node) => {
            const element = topology.elements.get(node.id);
            if (!element) return null;
            const routerKey = topology.routerOf.get(node.id);
            const nodeAggregate = elementAggregate(aggregation, node.id);
            return (
              <Fragment key={node.id}>
                <GraphNode
                  element={element}
                  aggregate={nodeAggregate}
                  box={node}
                  live={liveKey === node.id}
                  selected={isSelected(selection, node.id, aggregation)}
                  expanded={expanded.has(node.id)}
                  focused={tabStop === node.id}
                  onFocusKey={setFocusedKey}
                  unresolved={topology.unresolvedGraphs.find((entry) => entry.nodeKey === node.id)}
                  onSelect={onSelect}
                  onToggleExpanded={onToggleExpanded}
                />
                {routerKey !== undefined && node.out && (
                  <RouterKnob
                    edgeKey={routerKey}
                    aggregate={elementAggregate(aggregation, routerKey)}
                    failedHere={nodeAggregate.visits.at(-1)?.error?.stage === 'edge'}
                    at={node.out}
                    zIndex={nodeLayer(node.depth) + 1}
                    onSelect={onSelect}
                    onFocusNode={() => focusNode(node.id)}
                  />
                )}
              </Fragment>
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
            className="pointer-events-auto absolute rounded-lg border border-violet/45 bg-canvas/92 px-2.5 py-1 font-mono text-[12.5px] whitespace-nowrap text-fg shadow-soft backdrop-blur-sm"
          >
            {element.address.id}
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
  if (selection.kind === 'execution') {
    const aggregate = aggregation.byElement.get(key);
    return aggregate?.visits.some((visit) => visit.executionId === selection.executionId) === true;
  }
  return false;
}

/**
 * The paint order of one depth's cards: a box at depth `d`, its children one step above it.
 *
 * Arrows sit one below the cards of their own graph, so a graph's arrows are drawn above its own
 * box's background and below every card in it, however deep the box is nested.
 */
function nodeLayer(depth: number): number {
  return 10 + 2 * depth;
}

/**
 * Every arrow, one layer per graph depth.
 *
 * One layer under every card used to put each open box's translucent background over the arrows
 * inside it, so a graph two levels deep had its arrows behind two veils. Each depth's arrows now sit
 * directly above the box they belong to.
 */
function ArrowLayers({
  edges,
  takenLinks,
}: {
  readonly edges: LayoutResult['edges'];
  readonly takenLinks: ReadonlySet<string>;
}) {
  const depths = [...new Set(edges.map((edge) => edge.depth))];
  return (
    <>
      <svg width={0} height={0} className="absolute" aria-hidden>
        <defs>
          <ArrowMarker id="workflow-arrow-taken" opacity={1} />
          <ArrowMarker id="workflow-arrow-untaken" opacity={0.42} />
        </defs>
      </svg>
      {depths.map((depth) => (
        <svg
          key={depth}
          width={1}
          height={1}
          style={{ zIndex: nodeLayer(depth) - 1 }}
          className="pointer-events-none absolute top-0 left-0 overflow-visible"
          aria-hidden
        >
          {edges.map((edge, index) => {
            if (edge.depth !== depth) return null;
            const taken = takenLinks.has(edge.id);
            return (
              <path
                key={`${edge.id}-${index}`}
                d={roundedPath(edge.points)}
                data-taken={taken}
                fill="none"
                stroke="var(--color-blue)"
                strokeWidth={taken ? 2 : 1.4}
                strokeOpacity={taken ? 1 : 0.42}
                markerEnd={`url(#${taken ? 'workflow-arrow-taken' : 'workflow-arrow-untaken'})`}
              />
            );
          })}
        </svg>
      ))}
    </>
  );
}

function ArrowMarker({ id, opacity }: { readonly id: string; readonly opacity: number }) {
  return (
    <marker
      id={id}
      viewBox="0 0 8 8"
      refX="7"
      refY="4"
      markerWidth="6.5"
      markerHeight="6.5"
      orient="auto"
    >
      <path d="M0,0 L8,4 L0,8 z" fill="var(--color-blue)" fillOpacity={opacity} />
    </marker>
  );
}

/**
 * A node's router, drawn as part of its node.
 *
 * The verifier guarantees exactly one router per node, so the router is a knob on the node's output
 * port rather than a card competing with it. Every arrow out of the node starts here. It is not a
 * keyboard stop: the node is, and its dock links to the routing decision. A click hands focus to the
 * node, so the keyboard carries on from where the pointer was.
 */
function RouterKnob({
  edgeKey,
  aggregate,
  failedHere,
  at,
  zIndex,
  onSelect,
  onFocusNode,
}: {
  readonly edgeKey: string;
  readonly aggregate: ElementAggregate;
  /** The node's latest visit failed inside its router. */
  readonly failedHere: boolean;
  readonly at: { readonly x: number; readonly y: number };
  readonly zIndex: number;
  readonly onSelect: (selection: InspectorSelection) => void;
  readonly onFocusNode: () => void;
}) {
  const tone = failedHere
    ? 'border-error bg-error'
    : aggregate.routedBy.length > 0
      ? 'border-blue bg-blue'
      : 'border-blue bg-elevated';
  return (
    <button
      type="button"
      tabIndex={-1}
      data-router={edgeKey}
      title={inspectorCopy.routerKnob}
      aria-label={inspectorCopy.routerKnob}
      onClick={() => {
        onSelect(latestRoutingSelection(aggregate) ?? { kind: 'element', key: edgeKey });
        onFocusNode();
      }}
      onDoubleClick={(event) => event.stopPropagation()}
      style={{ left: at.x - 10, top: at.y - 10, zIndex }}
      className={`absolute size-5 cursor-pointer rounded-full border-[1.5px] transition-transform duration-micro ease-expo hover:scale-130 ${tone}`}
    />
  );
}

function GraphNode({
  element,
  aggregate,
  box,
  live,
  selected,
  expanded,
  focused,
  onFocusKey,
  unresolved,
  onSelect,
  onToggleExpanded,
}: {
  readonly element: DeclaredElement;
  readonly aggregate: ElementAggregate;
  readonly box: LayoutResult['nodes'][number];
  readonly live: boolean;
  readonly selected: boolean;
  readonly expanded: boolean;
  readonly focused: boolean;
  readonly onFocusKey: (key: string) => void;
  readonly unresolved: { readonly graphKey: string } | undefined;
  readonly onSelect: (selection: InspectorSelection) => void;
  readonly onToggleExpanded: (key: string) => void;
}) {
  const isSubgraph = element.kind === 'node' && element.descriptor.kind === 'subgraph';
  const visited = aggregate.visits.length > 0 || aggregate.status !== 'unvisited';

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
      zIndex: nodeLayer(box.depth),
    },
    'data-element': element.key,
    'data-live': live || undefined,
    'data-status': visited ? aggregate.status : 'unvisited',
  } as const;

  // The whole graph opens and closes, not just its name. A nested graph is a sibling in the DOM
  // painted above its parent, so a double-click inside one reaches that graph and stops there.
  const toggleOnDoubleClick = isSubgraph
    ? {
        onDoubleClick: (event: React.MouseEvent) => {
          event.stopPropagation();
          onToggleExpanded(element.key);
        },
      }
    : {};

  if (box.isBox) {
    return (
      <div
        {...commonProps}
        {...toggleOnDoubleClick}
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
          <span className="truncate font-mono text-[14px] text-fg">{element.address.id}</span>
          <span
            className="ml-auto flex-none rounded-md border border-line/35 px-1.5 font-mono text-[10.5px] text-fg-subtle"
            aria-label={inspectorCopy.collapse}
          >
            ▾
          </span>
        </button>
      </div>
    );
  }

  const ring = live
    ? 'border-amber bg-amber/11 shadow-[0_0_0_4px_color-mix(in_srgb,var(--color-amber)_14%,transparent)]'
    : selected
      ? 'border-blue shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-blue)_22%,transparent)]'
      : !visited
        ? `border-dashed ${isSubgraph ? 'border-violet/45' : 'border-line/35'}`
        : isSubgraph
          ? 'border-violet/60'
          : statusBorder(aggregate.status);
  const fill = visited ? 'bg-elevated' : 'bg-elevated/40';

  if (element.kind === 'outcome') {
    return (
      <div {...commonProps} className="absolute">
        <button
          type="button"
          {...stop}
          onClick={() => onSelect({ kind: 'element', key: element.key })}
          className={`flex size-full items-center gap-2 rounded-3xl border px-4 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue ${fill} ${ring}`}
        >
          <span
            aria-hidden
            className={`size-1.75 flex-none rounded-full ${
              element.descriptor.kind === 'failure' ? 'bg-error' : 'bg-green'
            }`}
          />
          <CardName id={element.address.id} dim={false} />
        </button>
      </div>
    );
  }

  return (
    <div {...commonProps} {...toggleOnDoubleClick} className="absolute">
      <button
        type="button"
        {...stop}
        onClick={() => onSelect(latestVisitSelection(aggregate, element.key))}
        aria-expanded={isSubgraph ? expanded : undefined}
        className={`relative z-1 flex size-full flex-col justify-center gap-1 overflow-hidden rounded-md border px-4 py-2.5 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue ${fill} ${ring}`}
      >
        <span className="flex items-start gap-2">
          <span
            aria-hidden
            className={`mt-1.5 size-1.75 flex-none rounded-full ${statusDot(
              visited ? aggregate.status : 'unvisited',
            )}`}
          />
          <CardName id={element.address.id} dim={!visited} />
          {isSubgraph && (
            <span aria-hidden className="flex-none font-mono text-[12px] text-violet">
              ▸
            </span>
          )}
        </span>
        <span className="flex min-h-4 items-baseline gap-2 pl-3.75 font-mono text-[11.5px] text-fg-subtle">
          {aggregate.visits.length > 0 && (
            <span className={aggregate.open ? 'text-amber' : 'text-fg-muted'}>
              {formatDuration(aggregate.durationMs)}
              {aggregate.open ? ' · open' : ''}
            </span>
          )}
          {aggregate.visits.length > 1 && <span>×{aggregate.visits.length}</span>}
          {unresolved && (
            <span
              className="text-amber"
              title={inspectorCopy.subgraphUnresolved(unresolved.graphKey)}
            >
              {inspectorCopy.subgraphMissing}
            </span>
          )}
          {element.kind === 'node' && element.descriptor.kind === 'checkpoint' && (
            <span className="ml-auto">
              <CheckpointKindTag />
            </span>
          )}
        </span>
      </button>
      {/* A closed graph is a card with another behind it: there is more in here than one step. It
          comes after the card so the card stays the first child: opening the graph then reuses the
          same button, and keyboard focus survives the toggle. */}
      {isSubgraph && (
        <span
          aria-hidden
          className="absolute inset-0 translate-x-1 translate-y-1 rounded-md border border-violet/30 bg-subtle"
        />
      )}
    </div>
  );
}

/**
 * A node's id, whole.
 *
 * Ids are camelCase, so the break opportunities a browser would find in prose are not there and a
 * long id either overflows or gets cut to a single letter. Offering a break before each capital lets
 * it wrap onto a second line at its own word boundaries; a single token too long even for that
 * breaks anywhere rather than spilling out of the card.
 */
function CardName({ id, dim }: { readonly id: string; readonly dim: boolean }) {
  const words = id.split(/(?<=[a-z0-9])(?=[A-Z])/);
  return (
    <span
      className={`line-clamp-2 min-w-0 flex-1 font-mono text-[14px] leading-4.5 wrap-anywhere ${
        dim ? 'text-fg-subtle' : 'text-fg'
      }`}
    >
      {words.map((word, index) => (
        <Fragment key={index}>
          {index > 0 && <wbr />}
          {word}
        </Fragment>
      ))}
    </span>
  );
}

/** What selecting an element means, wherever the selection came from. */
function selectionFor(element: DeclaredElement, aggregation: VisitAggregation): InspectorSelection {
  if (element.kind === 'node') {
    return latestVisitSelection(elementAggregate(aggregation, element.key), element.key);
  }
  return { kind: 'element', key: element.key };
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

/** A router selects the latest execution that routed through it, whose dock shows the decision. */
function latestRoutingSelection(aggregate: ElementAggregate): InspectorSelection | null {
  const latest = aggregate.routedBy.at(-1);
  return latest ? { kind: 'execution', executionId: latest.executionId } : null;
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
    case 'waiting':
      return 'border-waiting/45';
    case 'interrupted':
      return 'border-amber/45';
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
    case 'waiting':
      return 'bg-waiting';
    case 'interrupted':
      return 'bg-amber';
    case 'running':
      return 'bg-working';
    default:
      return 'bg-fg-subtle';
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
