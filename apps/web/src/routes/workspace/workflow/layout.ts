import type { DeclaredElement, DeclaredTopology } from './topology.js';

/**
 * What goes to the layout worker, and what may cause a relayout.
 *
 * Positions depend on the shape alone: which elements exist under the current pin, how they are
 * connected, and which subgraph boxes are open. Status, timers, selection, visit pips and operation
 * settlement change with every transition and move nothing — a live run that relayouts on every step
 * visibly twitches, and a person loses their place several times a minute.
 *
 * So the identity below is deliberately narrow, and the request sent to the worker is *only*
 * topology. Anything serialized into it becomes a relayout trigger by construction, which is why
 * nothing time-dependent is allowed near it.
 */

export interface LayoutNodeRequest {
  readonly id: string;
  readonly width: number;
  readonly height: number;
  readonly children?: readonly LayoutNodeRequest[];
  readonly padding?: string | undefined;
}

export interface LayoutEdgeRequest {
  readonly id: string;
  readonly source: string;
  readonly target: string;
}

export interface LayoutRequest {
  /** Identifies the shape this request describes; a stale reply is one whose identity has moved. */
  readonly identity: string;
  readonly nodes: readonly LayoutNodeRequest[];
  readonly edges: readonly LayoutEdgeRequest[];
}

export interface LaidOutNode {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly depth: number;
  readonly isBox: boolean;
}

export interface LaidOutEdge {
  readonly id: string;
  readonly points: readonly { readonly x: number; readonly y: number }[];
}

export interface LayoutResult {
  readonly identity: string;
  readonly width: number;
  readonly height: number;
  readonly nodes: readonly LaidOutNode[];
  readonly edges: readonly LaidOutEdge[];
}

/**
 * Reserved sizes, so a node's box never changes with its contents.
 *
 * This is what keeps the "no relayout on a status change" rule true rather than merely intended: if
 * a node grew when its second visit added a pip, the graph would have to be laid out again to stay
 * correct, and every promise above would quietly become false. Dense contents scroll or clip inside
 * a fixed frame instead.
 */
export const nodeSize = {
  /**
   * One size, with the visit strip reserved whether or not there are pips in it yet.
   *
   * A node that grew when its second visit arrived would have to be laid out again to stay correct,
   * and "a new visit moves nothing" would quietly stop being true — on a looping graph, several
   * times a minute. The strip is reserved from the first layout and its contents scroll inside it.
   */
  operation: { width: 256, height: 122 },
  edge: { width: 272, height: 104 },
  outcome: { width: 168, height: 56 },
  /** Taller than a step: a closed graph reserves the same header strip an open one has. */
  collapsedSubgraph: { width: 272, height: 112 },
  checkpoint: { width: 256, height: 88 },
} as const;

/** The header strip a box reserves for its own name, above its children. */
export const boxPadding = '[top=54,left=20,bottom=20,right=20]';

/**
 * The identity of a drawing.
 *
 * The pin decides the topology and the open set decides which registrations are drawn expanded.
 * Nothing else appears here, and nothing else may: adding a field is the same as asking for a
 * relayout every time that field changes.
 */
export function layoutIdentity(input: {
  /**
   * The pin's own artifact hash, not a summary of the topology.
   *
   * A descriptor is immutable under one pin, so the hash identifies the shape exactly. Deriving an
   * identity from the element keys instead looked equivalent and was not: a Retry that changed an
   * edge's destinations, a node's kind or a title without renaming anything produced the identical
   * summary, the relayout never happened, and the new pin was drawn with the old pin's geometry.
   */
  readonly artifactHash: string;
  readonly expanded: ReadonlySet<string>;
}): string {
  return `${input.artifactHash}|${[...input.expanded].sort().join(',')}`;
}

/**
 * Builds the worker request for the current pin and open set.
 *
 * Only serializable topology crosses the boundary: ids, sizes and containment. The worker never
 * learns what any of it means.
 */
export function buildLayoutRequest(input: {
  readonly topology: DeclaredTopology;
  readonly identity: string;
  readonly expanded: ReadonlySet<string>;
}): LayoutRequest {
  const { topology, expanded } = input;
  const edges: LayoutEdgeRequest[] = [];

  const build = (containerKey: string | null): LayoutNodeRequest[] => {
    const children = topology.childrenOf.get(containerKey) ?? [];
    const nodes: LayoutNodeRequest[] = [];
    for (const key of children) {
      const element = topology.elements.get(key);
      if (!element) continue;
      const isExpandedBox =
        element.kind === 'node' &&
        element.descriptor.kind === 'subgraph' &&
        expanded.has(key) &&
        topology.childrenOf.has(key);
      if (isExpandedBox) {
        nodes.push({
          id: key,
          width: 0,
          height: 0,
          padding: boxPadding,
          children: build(key),
        });
      } else {
        const size = reservedSize(element);
        nodes.push({ id: key, width: size.width, height: size.height });
      }
    }
    for (const link of topology.links) {
      if (link.containerKey !== containerKey) continue;
      edges.push({ id: link.id, source: link.fromKey, target: link.toKey });
    }
    return nodes;
  };

  return { identity: input.identity, nodes: build(null), edges };
}

/** Reserved from the descriptor alone, so nothing a run records can change a node's box. */
export function reservedSize(element: DeclaredElement): {
  readonly width: number;
  readonly height: number;
} {
  if (element.kind === 'edge') return nodeSize.edge;
  if (element.kind === 'outcome') return nodeSize.outcome;
  if (element.descriptor.kind === 'subgraph') return nodeSize.collapsedSubgraph;
  if (element.descriptor.kind === 'checkpoint') return nodeSize.checkpoint;
  return nodeSize.operation;
}

/**
 * The drawn elements, in the order the graph is built.
 *
 * Depth-first through each registration's declared order, the same walk `buildLayoutRequest` makes,
 * so document order, tab order and arrow-key order are one order rather than three that happen to
 * agree. A collapsed box contributes itself and not its contents, because its contents are not on
 * screen to move to.
 */
export function drawnOrder(
  topology: DeclaredTopology,
  expanded: ReadonlySet<string>,
): readonly string[] {
  const order: string[] = [];
  const walk = (containerKey: string | null) => {
    for (const key of topology.childrenOf.get(containerKey) ?? []) {
      const element = topology.elements.get(key);
      if (!element) continue;
      order.push(key);
      const isOpenBox =
        element.kind === 'node' &&
        element.descriptor.kind === 'subgraph' &&
        expanded.has(key) &&
        topology.childrenOf.has(key);
      if (isOpenBox) walk(key);
    }
  };
  walk(null);
  return order;
}
