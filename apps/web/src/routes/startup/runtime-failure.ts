// The permanent, presentational shape of a terminal runtime failure. The web app
// owns only how these facts are displayed; Electron (Phase 04) owns lifecycle
// stage, reason, provenance, and the managed-vs-external distinction, and maps
// its own model down to this flat diagnostic. Nothing here interprets *why* the
// runtime is gone — it only renders the facts that were supplied.

export type RuntimeFailureDiagnostic = {
  message?: string;
  exitCode?: number | null;
  signal?: string | null;
};

export type DiagnosticFactKey = 'message' | 'exitCode' | 'signal';

export type RuntimeFailureRow = { key: DiagnosticFactKey; value: string };

/**
 * The diagnostic facts to show, in a stable order (message, exit code, signal),
 * with every *present* fact included — these can legitimately co-occur, so none
 * is allowed to hide another. Presence is deliberate:
 *
 * - `exitCode` is kept whenever it is a number, so a clean `0` is never dropped.
 * - `message`/`signal` are kept when non-empty after trimming surrounding
 *   whitespace; the trimmed message still preserves its internal multiline
 *   formatting (e.g. a stack trace) for display.
 *
 * An empty result means there were no usable facts; the caller renders the
 * "no detail" line instead of an empty chip.
 */
export function runtimeFailureRows(diagnostic: RuntimeFailureDiagnostic): RuntimeFailureRow[] {
  const rows: RuntimeFailureRow[] = [];

  const message = diagnostic.message?.trim();
  if (message) rows.push({ key: 'message', value: message });

  if (typeof diagnostic.exitCode === 'number') {
    rows.push({ key: 'exitCode', value: String(diagnostic.exitCode) });
  }

  const signal = diagnostic.signal?.trim();
  if (signal) rows.push({ key: 'signal', value: signal });

  return rows;
}
