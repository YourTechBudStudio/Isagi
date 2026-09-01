import type { PtyProcessRow } from './types.js';

/**
 * How a finished PTY process is phrased for a person.
 *
 * Pure, and owned here because it reads only this domain's row and this
 * domain's status vocabulary. Every reader that turns a dead process into a
 * user-facing sentence imports it from here rather than from whichever domain
 * happened to need it first, so the phrasing cannot drift between them.
 *
 * Unrelated to the redacting classifier in `diagnostics/operational-cause.ts`:
 * every value below is a column this runtime wrote itself.
 */
export function exitDetail(process: PtyProcessRow) {
  if (process.exitCode !== null) return `PTY process exited with code ${process.exitCode}.`;
  if (process.signal) return `PTY process stopped by ${process.signal}.`;
  if (process.statusReason) return `PTY process status reason: ${process.statusReason}.`;
  return null;
}
