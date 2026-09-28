import ElkApiModule from 'elkjs/lib/elk-api.js';
import elkWorkerUrl from 'elkjs/lib/elk-worker.min.js?url';

import type {
  LaidOutEdge,
  LaidOutNode,
  LayoutNodeRequest,
  LayoutRequest,
  LayoutResult,
} from './layout.js';

/**
 * Compound graph layout, off the main thread, using ELK's own worker.
 *
 * ELK's layered algorithm is real CPU work — tens to hundreds of milliseconds once a few nested
 * registrations are open. On the main thread it would freeze the inspector for that long every time
 * the shape changed, which is exactly when somebody is trying to read it.
 *
 * The worker is ELK's published one, emitted as an asset by our own build rather than fetched from a
 * CDN. Wrapping it in a second worker of ours is what the bundled build does internally, and a
 * nested worker does not survive bundling — it fails with a constructor that is not one. So this
 * owns the boundary directly: the cheap translation between our topology and ELK's graph stays on
 * this side, and only the layout crosses.
 */

/**
 * The published files are UMD, so what a default import resolves to depends on the bundler's interop
 * — sometimes the constructor, sometimes a namespace carrying it, sometimes both nested. Unwrapping
 * until a function appears is the difference between a graph and a runtime type error.
 */
function constructorOf(candidate: unknown, name: string): new (...args: never[]) => unknown {
  let current = candidate;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current === 'function') return current as new (...args: never[]) => unknown;
    if (typeof current !== 'object' || current === null) break;
    current = (current as { default?: unknown }).default;
  }
  throw new TypeError(`${name} did not resolve to a constructor.`);
}

interface ElkNode {
  id: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  layoutOptions?: Record<string, string>;
  children?: ElkNode[];
  edges?: ElkEdge[];
}

interface ElkEdge {
  id: string;
  sources: string[];
  targets: string[];
  sections?: {
    startPoint: { x: number; y: number };
    endPoint: { x: number; y: number };
    bendPoints?: { x: number; y: number }[];
  }[];
}

const layoutOptions = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.layered.spacing.nodeNodeBetweenLayers': '74',
  'elk.spacing.nodeNode': '36',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.spacing.edgeNode': '22',
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
};

export interface LayoutEngine {
  readonly layout: (request: LayoutRequest) => Promise<LayoutResult>;
  readonly dispose: () => void;
}

export function createElkEngine(): LayoutEngine {
  const ElkApi = constructorOf(ElkApiModule, 'elkjs/lib/elk-api.js');
  let worker: Worker | null = null;
  const elk = new ElkApi({
    workerUrl: elkWorkerUrl,
    workerFactory: (url: string) => {
      // Kept so the engine can terminate it: ELK's API has no disposal of its own, and a worker per
      // inspector opening that nobody ends is a leak the user pays for.
      worker = new Worker(url);
      return worker;
    },
  } as never) as { layout: (graph: unknown) => Promise<unknown> };

  return {
    layout: async (request) => toResult(request, (await elk.layout(toElk(request))) as ElkNode),
    dispose: () => {
      worker?.terminate();
      worker = null;
    },
  };
}

/** Only ids, sizes and containment. Nothing that could carry a status or a timestamp. */
function toElk(request: LayoutRequest): ElkNode {
  const edgesByContainer = new Map<string | null, ElkEdge[]>();
  const containerOf = new Map<string, string | null>();

  const index = (nodes: readonly LayoutNodeRequest[], container: string | null) => {
    for (const node of nodes) {
      containerOf.set(node.id, container);
      if (node.children) index(node.children, node.id);
    }
  };
  index(request.nodes, null);

  for (const edge of request.edges) {
    // Both ends of an edge are registered in the same graph, so the source's container is it.
    const container = containerOf.get(edge.source) ?? null;
    let bucket = edgesByContainer.get(container);
    if (!bucket) edgesByContainer.set(container, (bucket = []));
    bucket.push({ id: edge.id, sources: [edge.source], targets: [edge.target] });
  }

  const node = (source: LayoutNodeRequest): ElkNode =>
    source.children
      ? {
          id: source.id,
          ...(source.padding === undefined
            ? {}
            : { layoutOptions: { 'elk.padding': source.padding } }),
          children: source.children.map(node),
          edges: edgesByContainer.get(source.id) ?? [],
        }
      : { id: source.id, width: source.width, height: source.height };

  return {
    id: 'root',
    layoutOptions,
    children: request.nodes.map(node),
    edges: edgesByContainer.get(null) ?? [],
  };
}

function toResult(request: LayoutRequest, laid: ElkNode): LayoutResult {
  const nodes: LaidOutNode[] = [];
  const edges: LaidOutEdge[] = [];

  const walk = (node: ElkNode, offsetX: number, offsetY: number, depth: number) => {
    for (const child of node.children ?? []) {
      const x = offsetX + (child.x ?? 0);
      const y = offsetY + (child.y ?? 0);
      nodes.push({
        id: child.id,
        x,
        y,
        width: child.width ?? 0,
        height: child.height ?? 0,
        depth,
        isBox: (child.children?.length ?? 0) > 0,
      });
      if (child.children?.length) walk(child, x, y, depth + 1);
    }
    for (const edge of node.edges ?? []) {
      for (const section of edge.sections ?? []) {
        edges.push({
          id: edge.id,
          points: [section.startPoint, ...(section.bendPoints ?? []), section.endPoint].map(
            (point) => ({ x: point.x + offsetX, y: point.y + offsetY }),
          ),
        });
      }
    }
  };
  walk(laid, 0, 0, 0);

  return {
    identity: request.identity,
    width: laid.width ?? 0,
    height: laid.height ?? 0,
    nodes,
    edges,
  };
}
