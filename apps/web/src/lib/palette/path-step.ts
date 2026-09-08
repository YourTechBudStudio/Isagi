import { moveIndex } from '../keyboard-selection.js';

/**
 * The path argument's interaction policy: what a highlight means, where it moves,
 * and what Enter or a row click does next. Every rule the palette applies to a
 * path step lives here, so the reducer's behavior and the rendered hint can never
 * disagree about what the next action is.
 *
 * These are pure rules, not a state owner: the palette machine holds the state and
 * calls in. Nothing here touches React, Effect, IO, or the client's filesystem —
 * suggestion strings are runtime-owned text and are compared, never resolved.
 */

export interface PathSuggestionLike {
  readonly label: string;
  readonly path: string;
  readonly hidden?: boolean | undefined;
}

/** The path step's slice of `StepData`. `highlightedIndex` is set only by explicit navigation. */
export interface PathStepData {
  readonly kind: 'path';
  readonly suggestions: readonly PathSuggestionLike[];
  readonly suggestionsQuery: string;
  readonly loading: boolean;
  readonly error: string | null;
  readonly attemptId: number;
  readonly highlightedIndex: number | null;
}

/** The two facts every path rule reads: the buffer and the current result. */
export interface PathStepView {
  readonly query: string;
  readonly stepData: PathStepData;
}

export type PathIntent =
  | { readonly kind: 'accept'; readonly path: string }
  | { readonly kind: 'submit'; readonly value: string }
  | { readonly kind: 'none' };

export const PATH_SEPARATOR = '/';

/**
 * The buffer as the user sees it and as the runtime receives it. The header input
 * already renders `query.trim()`, so the trimmed value *is* the path; nothing
 * downstream re-trims. A directory whose real name has leading or trailing
 * whitespace is therefore not representable in this flow — a pre-existing limit of
 * the input flow, unchanged here.
 */
export function pathBufferValue(query: string): string {
  return query.trim();
}

/**
 * Whether the visible rows belong to an older buffer. Compared on the raw query,
 * which is the identity the request was issued under — trimming is a display and
 * submission rule, not a freshness one.
 */
export function pathSuggestionsAreStale(view: PathStepView): boolean {
  return view.stepData.suggestionsQuery !== view.query;
}

/**
 * The rows a keystroke or click may act on. Stale rows stay visible but inert.
 * `hidden` is presentation metadata: hidden-name eligibility is decided by the
 * runtime listing, and filtering again here would be a second policy owner.
 */
export function selectablePathSuggestions(view: PathStepView): readonly PathSuggestionLike[] {
  return pathSuggestionsAreStale(view) ? [] : view.stepData.suggestions;
}

/**
 * The explicitly navigated suggestion, if one resolves. The out-of-range fallback is
 * defensive — the reducer clears the highlight whenever the query or the result
 * changes — and deliberately reads the same as a stale result.
 */
export function highlightedPathSuggestion(view: PathStepView): PathSuggestionLike | null {
  const { highlightedIndex } = view.stepData;
  if (highlightedIndex === null) return null;
  return selectablePathSuggestions(view)[highlightedIndex] ?? null;
}

/**
 * Where an explicit navigation lands. From no highlight, forward enters at the first
 * row and backward at the last; movement wraps; an empty or stale list stays inert.
 */
export function movedPathHighlight(view: PathStepView, delta: number): number | null {
  return moveIndex(view.stepData.highlightedIndex, delta, selectablePathSuggestions(view).length);
}

/**
 * What the next Enter does. A resolved highlight is accepted — even when its path
 * already equals the buffer, because the user navigated to it deliberately. With no
 * resolved highlight, Enter submits the buffer the user can actually see; an empty
 * buffer does nothing.
 */
export function nextPathIntent(view: PathStepView): PathIntent {
  const highlighted = highlightedPathSuggestion(view);
  if (highlighted !== null) {
    return { kind: 'accept', path: highlighted.path };
  }
  const value = pathBufferValue(view.query);
  return value === '' ? { kind: 'none' } : { kind: 'submit', value };
}

/**
 * What a click on row `index` does. A fresh row whose path already equals the buffer
 * submits it; any other fresh row is accepted into the buffer. This is deliberately
 * not the Enter rule: pointing at a row that says what the buffer says is a decision,
 * whereas navigating onto it is still browsing.
 *
 * Equality is between path strings, never row indices, object identity, or result
 * generation, so a row that reappears after a refresh behaves exactly as it did.
 */
export function pathPickIntent(view: PathStepView, index: number): PathIntent {
  const suggestion = selectablePathSuggestions(view)[index];
  if (suggestion === undefined) {
    return { kind: 'none' };
  }
  if (suggestion.path === pathBufferValue(view.query)) {
    return { kind: 'submit', value: suggestion.path };
  }
  return { kind: 'accept', path: suggestion.path };
}

/**
 * The buffer for descending into `path`: exactly one terminal separator. `/` stays
 * `/`. The separator is the runtime's, not the client platform's — these strings are
 * runtime-owned and its parser splits on `/`.
 */
export function withPathSeparator(path: string): string {
  return path.endsWith(PATH_SEPARATOR) ? path : `${path}${PATH_SEPARATOR}`;
}
