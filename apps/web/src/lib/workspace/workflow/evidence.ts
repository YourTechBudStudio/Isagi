import type { ListWorkflowEvidenceQuery } from '@isagi/contracts';

import type { WorkflowRunState } from './model.js';

/**
 * Client-side rules for reading captured evidence.
 *
 * Everything here turns on one property of `operationSummary.evidenceCaptured`: it is
 * **subtree-inclusive**. An execution's value already counts the captures of every execution beneath
 * its child frame. So nothing may sum it across nesting levels — a nested capture would be counted
 * once for its own execution and again for every ancestor.
 *
 * That leaves exactly two correct readings, and both are here so no surface invents a third:
 *
 * - **A visit** reads one execution's value. It is precisely the set the list's subtree query
 *   returns, so a dock count and the list it opens agree by construction.
 * - **The run** sums over the executions of the *root frame only*. Their subtrees partition the run,
 *   so every capture is counted once.
 */

/** Which set of captures a surface is looking at. */
export type EvidenceScope =
  | { readonly kind: 'run' }
  | { readonly kind: 'visit'; readonly executionId: number; readonly subtree: boolean };

/** The captures of one visit and everything beneath it. What a trace row and a dock heading show. */
export function evidenceCountForVisit(state: WorkflowRunState, executionId: number): number {
  return state.executions.get(executionId)?.operationSummary.evidenceCaptured ?? 0;
}

/**
 * The number a list refetches on.
 *
 * It moves exactly when a capture commits — `evidenceCaptured` counts only *completed* capture
 * operations, and the ordinary retry path (`intended` → `abandoned` → `completed`) leaves the
 * execution's other counts untouched at the commit that writes the evidence row. So a signal that
 * has not changed means no new record exists, and a list keyed on it need not poll.
 */
export function evidenceRefreshSignal(
  state: WorkflowRunState | null,
  scope: EvidenceScope,
): number {
  if (state === null) return 0;
  if (scope.kind === 'visit') return evidenceCountForVisit(state, scope.executionId);
  let total = 0;
  for (const execution of state.executions.values()) {
    // Root-frame executions only. Their subtrees partition the run, so each capture counts once;
    // summing every execution would count a nested capture again for each ancestor.
    //
    // An execution whose frame has not arrived is skipped rather than guessed at. The projection
    // delivers a frame before any execution that names it, so this is only reachable mid-hydration,
    // and undercounting there costs one refetch once the frame lands — whereas assuming a missing
    // frame is a root frame would overcount and settle there.
    if (state.frames.get(execution.frameId)?.parentExecutionId === null) {
      total += execution.operationSummary.evidenceCaptured;
    }
  }
  return total;
}

/** The filter half of a listing, separate from its scope. Applies to both scopes alike. */
export interface EvidenceFilters {
  readonly role?: string | undefined;
  /** `key:value`, repeatable. Values compare as text, so `round:2` matches `2` and `"2"`. */
  readonly label?: readonly string[] | undefined;
}

/** The wire query for a scope and filter set. One place, so the tab and the dock cannot diverge. */
export function evidenceListQuery(
  scope: EvidenceScope,
  filters: EvidenceFilters,
  page: { readonly limit: number; readonly cursor: string | null },
): ListWorkflowEvidenceQuery {
  return {
    limit: page.limit,
    ...(page.cursor === null ? {} : { cursor: page.cursor }),
    ...(scope.kind === 'visit'
      ? { executionId: scope.executionId, ...(scope.subtree ? { subtree: 'true' as const } : {}) }
      : {}),
    ...(filters.role === undefined ? {} : { role: filters.role }),
    ...(filters.label === undefined || filters.label.length === 0 ? {} : { label: filters.label }),
  };
}

/** A stable identity for a scope and filter set, for the query key. Key order cannot change it. */
export function evidenceQueryIdentity(scope: EvidenceScope, filters: EvidenceFilters): string {
  const parts =
    scope.kind === 'run' ? ['run'] : ['visit', String(scope.executionId), String(scope.subtree)];
  return [
    ...parts,
    `role=${filters.role ?? ''}`,
    `labels=${[...(filters.label ?? [])].sort().join('|')}`,
  ].join(';');
}

/**
 * How a media type is shown.
 *
 * The decision is the media type's alone, because that is the only thing recorded about how the
 * bytes are meant to be read. `download` is the honest answer for anything else: offering a preview
 * that would render binary as mojibake is worse than offering the file.
 */
export type EvidencePresentation = 'text' | 'json' | 'image' | 'html' | 'download';

export function contentPresentation(mediaType: string): EvidencePresentation {
  const base = mediaType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (base === 'application/json' || base.endsWith('+json')) return 'json';
  if (base === 'text/html') return 'html';
  // SVG is an image that is also a document; it renders through the sandboxed HTML path rather than
  // as an `<img>`, because an `<img>` would run nothing but also show nothing a source view cannot.
  if (base === 'image/svg+xml') return 'html';
  if (base.startsWith('image/')) return 'image';
  if (base.startsWith('text/')) return 'text';
  return 'download';
}

/** Above this, a preview shows the first part and says so. The rest is a download. */
export const previewCapBytes = 256 * 1024;
