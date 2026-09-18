import type {
  WorkflowEdgeDescriptorDto,
  WorkflowGraphDescriptorDto,
  WorkflowNodeDescriptorDto,
  WorkflowOutcomeDescriptorDto,
  WorkflowStructureDescriptorDto,
} from '@isagi/contracts';

/**
 * The current pin's structure, addressed by where each element is *registered* rather than by which
 * graph defines it.
 *
 * This is the distinction story #43 exists to protect at the structural end. A graph is reusable:
 * one `review` graph invoked by two different subgraph nodes is two places in the structure, with
 * two independent sets of visits, and collapsing them onto the graph key would merge two unrelated
 * histories under one drawing. So an element's identity here is the chain of subgraph *node ids*
 * that reaches it, plus its own id — never the graph key.
 *
 * The tree is finite by construction: the verifier rejects recursive containment and bounds
 * containment depth, so expanding every registration terminates.
 */

export type DeclaredKind = 'node' | 'edge' | 'outcome';

export interface DeclaredAddress {
  /** Subgraph node ids from the root graph inwards. Empty at the root. */
  readonly path: readonly string[];
  readonly kind: DeclaredKind;
  readonly id: string;
}

/**
 * A stable string for one address.
 *
 * `/` separates registration steps and `::` separates the path from the element, so an element id
 * containing a slash cannot be mistaken for a deeper registration. Node ids are verified identifiers
 * and cannot contain `::` at all, which is what makes the split unambiguous.
 */
export function addressKey(address: DeclaredAddress): string {
  return `${address.path.join('/')}::${address.kind}:${address.id}`;
}

export function parseAddressKey(key: string): DeclaredAddress {
  const separator = key.indexOf('::');
  if (separator === -1) throw new Error(`Not a declared address: ${key}`);
  const path = key.slice(0, separator);
  const element = key.slice(separator + 2);
  const colon = element.indexOf(':');
  const kind = element.slice(0, colon) as DeclaredKind;
  return {
    path: path === '' ? [] : path.split('/'),
    kind,
    id: element.slice(colon + 1),
  };
}

export type DeclaredElement =
  | {
      readonly key: string;
      readonly address: DeclaredAddress;
      readonly kind: 'node';
      readonly graphKey: string;
      /** The enclosing subgraph element, or null at the root. */
      readonly containerKey: string | null;
      readonly depth: number;
      readonly descriptor: WorkflowNodeDescriptorDto;
      /** Set only on a subgraph node: the graph it invokes. */
      readonly invokesGraphKey: string | null;
    }
  | {
      readonly key: string;
      readonly address: DeclaredAddress;
      readonly kind: 'edge';
      readonly graphKey: string;
      readonly containerKey: string | null;
      readonly depth: number;
      readonly descriptor: WorkflowEdgeDescriptorDto;
    }
  | {
      readonly key: string;
      readonly address: DeclaredAddress;
      readonly kind: 'outcome';
      readonly graphKey: string;
      readonly containerKey: string | null;
      readonly depth: number;
      readonly descriptor: WorkflowOutcomeDescriptorDto;
    };

/** One arrow. Edges are drawn as their own element, so every link has an edge element at one end. */
export interface DeclaredLink {
  readonly id: string;
  readonly fromKey: string;
  readonly toKey: string;
  /** The registration whose graph both ends belong to. Null for the root graph. */
  readonly containerKey: string | null;
  /** The declared destination this link carries, for a link out of an edge element. */
  readonly destinationId: string | null;
  readonly edgeKey: string;
}

export interface DeclaredTopology {
  readonly rootGraphKey: string;
  readonly elements: ReadonlyMap<string, DeclaredElement>;
  readonly links: readonly DeclaredLink[];
  /** Element keys registered directly inside a container, in declared order. */
  readonly childrenOf: ReadonlyMap<string | null, readonly string[]>;
  /** The entry node of each registration, so "where does this graph start" is answerable. */
  readonly entryOf: ReadonlyMap<string | null, string>;
  /** Registration paths that could not be expanded, because the descriptor omits their graph. */
  readonly unresolvedGraphs: readonly { readonly nodeKey: string; readonly graphKey: string }[];
}

export function buildTopology(descriptor: WorkflowStructureDescriptorDto): DeclaredTopology {
  const graphs = new Map<string, WorkflowGraphDescriptorDto>(
    descriptor.graphs.map((graph) => [graph.key, graph]),
  );
  const elements = new Map<string, DeclaredElement>();
  const links: DeclaredLink[] = [];
  const childrenOf = new Map<string | null, string[]>();
  const entryOf = new Map<string | null, string>();
  const unresolvedGraphs: { nodeKey: string; graphKey: string }[] = [];

  const expand = (graphKey: string, path: readonly string[], containerKey: string | null) => {
    const graph = graphs.get(graphKey);
    if (!graph) return;
    const children: string[] = [];
    childrenOf.set(containerKey, children);
    const depth = path.length;

    const keyOf = (kind: DeclaredKind, id: string) => addressKey({ path, kind, id });

    for (const node of graph.nodes) {
      const key = keyOf('node', node.id);
      elements.set(key, {
        key,
        address: { path, kind: 'node', id: node.id },
        kind: 'node',
        graphKey,
        containerKey,
        depth,
        descriptor: node,
        invokesGraphKey: node.kind === 'subgraph' ? node.graphKey : null,
      });
      children.push(key);
    }
    for (const outcome of graph.outcomes) {
      const key = keyOf('outcome', outcome.id);
      elements.set(key, {
        key,
        address: { path, kind: 'outcome', id: outcome.id },
        kind: 'outcome',
        graphKey,
        containerKey,
        depth,
        descriptor: outcome,
      });
      children.push(key);
    }
    for (const edge of graph.edges) {
      const key = keyOf('edge', edge.id);
      elements.set(key, {
        key,
        address: { path, kind: 'edge', id: edge.id },
        kind: 'edge',
        graphKey,
        containerKey,
        depth,
        descriptor: edge,
      });
      children.push(key);

      const sourceKey = keyOf('node', edge.from);
      if (elements.has(sourceKey)) {
        links.push({
          id: `${sourceKey}->${key}`,
          fromKey: sourceKey,
          toKey: key,
          containerKey,
          destinationId: null,
          edgeKey: key,
        });
      }
      for (const destination of edge.to) {
        // A destination names a node or an outcome in the same graph; the verifier has already
        // refused anything else, so a lookup that misses here means the descriptor disagrees with
        // itself and the arrow is simply not drawn rather than invented.
        const nodeKey = keyOf('node', destination);
        const outcomeKey = keyOf('outcome', destination);
        const toKey = elements.has(nodeKey)
          ? nodeKey
          : elements.has(outcomeKey)
            ? outcomeKey
            : null;
        if (toKey === null) continue;
        links.push({
          id: `${key}->${toKey}`,
          fromKey: key,
          toKey,
          containerKey,
          destinationId: destination,
          edgeKey: key,
        });
      }
    }

    const entryKey = keyOf('node', graph.entry);
    if (elements.has(entryKey)) entryOf.set(containerKey, entryKey);

    for (const node of graph.nodes) {
      if (node.kind !== 'subgraph') continue;
      const key = keyOf('node', node.id);
      if (!graphs.has(node.graphKey)) {
        unresolvedGraphs.push({ nodeKey: key, graphKey: node.graphKey });
        continue;
      }
      expand(node.graphKey, [...path, node.id], key);
    }
  };

  expand(descriptor.rootGraphKey, [], null);

  return {
    rootGraphKey: descriptor.rootGraphKey,
    elements,
    links,
    childrenOf,
    entryOf,
    unresolvedGraphs,
  };
}

/** The registration chain of an element, outermost first — what the dock breadcrumb walks. */
export function ancestorKeys(topology: DeclaredTopology, key: string): readonly string[] {
  const chain: string[] = [];
  let current = topology.elements.get(key)?.containerKey ?? null;
  while (current !== null) {
    chain.unshift(current);
    current = topology.elements.get(current)?.containerKey ?? null;
  }
  return chain;
}

/** The element a declared address points at under this pin, if the pin still declares it. */
export function elementAt(
  topology: DeclaredTopology,
  address: DeclaredAddress,
): DeclaredElement | undefined {
  return topology.elements.get(addressKey(address));
}
