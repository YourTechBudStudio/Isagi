import process from 'node:process';

import { Effect } from 'effect';

import { CliAccess } from '../cli-access/index.js';
import { EditorProvisioning } from '../editor/index.js';
import { SurfaceService } from '../environment/index.js';
import { HarnessControlPlane } from '../harnesses/index.js';

const readyPrefix = 'ISAGI_RUNTIME_READY ';

/**
 * The runtime's cross-module startup, in order, once the server listens on `url`. Each module's own convergence (PTY
 * reconciliation, command convergence, workflow recovery, the observer baseline) already ran while its layer was
 * built; this owns only the steps that need the URL or must follow every module.
 *
 * The ready line is the last step: the desktop host waits for it (and treats a 15-second deadline as fatal), so
 * nothing slow may sit before it.
 */
export const startup = Effect.fn('Runtime.startup')(function* (url: string) {
  // 1. Before anything can launch a PTY (the control plane and restored sessions below), so every terminal and agent
  //    session gets `ISAGI_RUNTIME_URL`.
  yield* CliAccess.use((cliAccess) => cliAccess.publishRuntimeUrl(url));
  // 2. Forks into the control plane's own layer scope.
  yield* HarnessControlPlane.use((controlPlane) => controlPlane.start);
  // 3. Forks into the provisioning layer's scope and returns immediately: the pinned Code Server artifacts are
  //    200–235 MB, so a first-run download must never sit between this point and the ready line.
  yield* EditorProvisioning.use((provisioning) => provisioning.start);
  // 4. Pane-bound sessions come back with new process incarnations.
  yield* SurfaceService.use((surfaces) => surfaces.restorePaneBoundSessions);
  // 5. A protocol line for the host, not a log entry, so it never passes through the logger's format.
  yield* Effect.sync(() => process.stdout.write(`${formatReadyLine(url)}\n`));
});

/** The line the desktop host waits for on stdout (`ISAGI_RUNTIME_READY {"url":"…"}`). */
export function formatReadyLine(url: string) {
  return `${readyPrefix}${JSON.stringify({ url })}`;
}
