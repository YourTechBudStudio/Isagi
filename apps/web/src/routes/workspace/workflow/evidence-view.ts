import type { WorkflowEvidenceDto } from '@isagi/contracts';

import type { WorkflowRunState } from '../../../lib/workspace/workflow/model.js';
import { executionAncestry } from './ancestry.js';

/**
 * Turning a flat listing into what the Evidence tab shows.
 *
 * The route returns records in capture order and nothing else: it knows no ancestry, so a review
 * loop's two rounds arrive as one undifferentiated run of rows. Grouping them is a view concern and
 * lives here, derived from `state.executions` / `state.frames` through `executionAncestry` — the
 * same walk Trace uses, so a record and its trace row can never disagree about where it ran.
 *
 * Order is preserved rather than re-sorted. Siblings are ordered by the first record captured
 * anywhere beneath them, which is what makes "in capture order, grouped by where it ran" true of
 * the result rather than merely claimed by the heading.
 */

export interface EvidenceGroup {
  /** The visit these records were captured in. */
  readonly executionId: number;
  readonly nodeId: string;
  readonly displayName: string | null;
  readonly isSubgraph: boolean;
  /** Nesting depth below the tree's root, for indentation. */
  readonly depth: number;
  /** Records captured by this visit itself. */
  readonly records: readonly WorkflowEvidenceDto[];
  /** Visits inside this subgraph's child frame that captured something. */
  readonly children: readonly EvidenceGroup[];
  /** Records here and everywhere beneath. Subtree-inclusive, like `evidenceCaptured`. */
  readonly total: number;
  /**
   * A visit that is on screen because it is live, not because it captured anything.
   *
   * It is a line, never an empty group: an empty group under a heading would read as "this visit
   * finished and kept nothing", which is a claim about a visit that has not finished.
   */
  readonly live: boolean;
}

export interface EvidenceTree {
  readonly groups: readonly EvidenceGroup[];
  /** Records placed in the tree. Equal to the input length unless ancestry could not be walked. */
  readonly placed: number;
  /**
   * Records whose execution is not in the projection yet, shown flat above the tree.
   *
   * Reachable only mid-hydration: the listing and the projection are two reads and the list can
   * win the race. Dropping them would silently understate what a run captured, which is the one
   * thing this surface may never do.
   */
  readonly unplaced: readonly WorkflowEvidenceDto[];
}

interface Building {
  executionId: number;
  nodeId: string;
  displayName: string | null;
  isSubgraph: boolean;
  records: WorkflowEvidenceDto[];
  children: Map<number, Building>;
  /** Index of the first record captured anywhere beneath this node, for sibling order. */
  order: number;
  live: boolean;
}

export function buildEvidenceTree(input: {
  readonly state: WorkflowRunState;
  readonly records: readonly WorkflowEvidenceDto[];
  /**
   * The visit the tree is rooted at, or `null` for the whole run.
   *
   * In visit scope the root is always present even with nothing captured, because the person chose
   * it; in run scope only paths that lead to a record exist.
   */
  readonly rootExecutionId: number | null;
  /** The visit the run is in now, so it can show its empty line. */
  readonly liveExecutionId: number | null;
}): EvidenceTree {
  const { state, records, rootExecutionId, liveExecutionId } = input;
  const roots = new Map<number, Building>();
  const unplaced: WorkflowEvidenceDto[] = [];
  let placed = 0;

  /**
   * Two different failures, kept apart.
   *
   * `'unknown'` means the projection has not delivered that execution — a record that exists and
   * has nowhere to sit, which is shown flat rather than dropped. `'out_of_scope'` means the record
   * belongs to a branch this tree is not rooted at, which is not a gap in anything: the route
   * already scoped the listing, so nothing is being hidden by leaving it out.
   */
  const node = (executionId: number, order: number): Building | 'unknown' | 'out_of_scope' => {
    const execution = state.executions.get(executionId);
    if (!execution) return 'unknown';
    const ancestry = executionAncestry(state, execution);
    const chain = [...ancestry.ancestorExecutionIds, executionId];
    if (rootExecutionId !== null) {
      const at = chain.indexOf(rootExecutionId);
      if (at < 0) return 'out_of_scope';
      chain.splice(0, at);
    }
    let level = roots;
    let current: Building | null = null;
    for (const id of chain) {
      const visit = state.executions.get(id);
      if (!visit) return 'unknown';
      let entry = level.get(id);
      if (entry === undefined) {
        entry = {
          executionId: id,
          nodeId: visit.nodeId,
          displayName: visit.displayName,
          isSubgraph: visit.nodeKind === 'subgraph',
          records: [],
          children: new Map(),
          order,
          live: false,
        };
        level.set(id, entry);
      }
      current = entry;
      level = entry.children;
    }
    return current ?? 'unknown';
  };

  records.forEach((record, index) => {
    const target = node(record.executionId, index);
    if (target === 'out_of_scope') return;
    if (target === 'unknown') {
      unplaced.push(record);
      return;
    }
    target.records.push(record);
    placed += 1;
  });

  // The root of a visit-scope tree exists because the person selected it, not because it captured
  // anything. Creating it after the records means an empty selection still shows its own heading.
  if (rootExecutionId !== null) node(rootExecutionId, Number.MAX_SAFE_INTEGER);

  if (liveExecutionId !== null) {
    const live = node(liveExecutionId, Number.MAX_SAFE_INTEGER);
    // Only when it captured nothing. A live visit that has captured something is an ordinary group,
    // and marking it would replace its records with a line saying it has none.
    if (typeof live === 'object' && live.records.length === 0 && live.children.size === 0) {
      live.live = true;
    }
  }

  return { groups: freeze(roots, 0), placed, unplaced };
}

function freeze(level: ReadonlyMap<number, Building>, depth: number): readonly EvidenceGroup[] {
  return [...level.values()]
    .sort((left, right) => left.order - right.order || left.executionId - right.executionId)
    .map((entry) => {
      const children = freeze(entry.children, depth + 1);
      return {
        executionId: entry.executionId,
        nodeId: entry.nodeId,
        displayName: entry.displayName,
        isSubgraph: entry.isSubgraph,
        depth,
        records: entry.records,
        children,
        total: entry.records.length + children.reduce((sum, child) => sum + child.total, 0),
        live: entry.live,
      };
    });
}

/**
 * The role and label filters, derived from the records in hand rather than fetched.
 *
 * Deliberately not the route's `role` / `label` query parameters. The panel already pages the whole
 * listing, so filtering it is a view concern; sending a filter would change the query key and split
 * the dock column off the panel's visit scope, which is the one thing those two surfaces may never
 * do. The route's filters remain for API consumers reading the listing directly.
 */
export interface EvidenceFacets {
  readonly roles: readonly string[];
  /** `key:value`, the same spelling the route's filter uses, in first-seen order. */
  readonly labels: readonly string[];
}

export function evidenceFacets(records: readonly WorkflowEvidenceDto[]): EvidenceFacets {
  const roles = new Set<string>();
  const labels = new Set<string>();
  for (const record of records) {
    roles.add(record.role);
    for (const [key, value] of Object.entries(record.labels)) labels.add(`${key}:${value}`);
  }
  return { roles: [...roles], labels: [...labels] };
}

export interface EvidenceSelectedFilters {
  readonly role: string | null;
  readonly labels: ReadonlySet<string>;
}

export const noEvidenceFilters: EvidenceSelectedFilters = { role: null, labels: new Set() };

export function evidenceFiltersActive(filters: EvidenceSelectedFilters): boolean {
  return filters.role !== null || filters.labels.size > 0;
}

/** Every selected label must match, because chips narrow rather than widen. */
export function filterEvidence(
  records: readonly WorkflowEvidenceDto[],
  filters: EvidenceSelectedFilters,
): readonly WorkflowEvidenceDto[] {
  if (!evidenceFiltersActive(filters)) return records;
  return records.filter((record) => {
    if (filters.role !== null && record.role !== filters.role) return false;
    const own = new Set(Object.entries(record.labels).map(([key, value]) => `${key}:${value}`));
    for (const label of filters.labels) if (!own.has(label)) return false;
    return true;
  });
}
