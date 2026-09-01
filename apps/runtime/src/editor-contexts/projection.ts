import type { EditorProcessDiagnostic } from '@isagi/contracts';

import { exitDetail, type PtyProcessRow } from '../pty-processes/index.js';
import { editorOrigin } from './launch-spec.js';
import type { EditorContextFacts, EditorContextRow, EditorReadinessObservation } from './types.js';

/**
 * The editor context's own facts, composed from the durable row and this
 * runtime's in-memory readiness observation. Pure, and placement-free: `paneId`
 * belongs to whoever is composing surface detail, which is the only layer that
 * knows it.
 *
 * The rule that matters most is the one about `ready`. It is projected only when
 * the observation keys the *current* pointer and the process row is still live,
 * so a stale observation, a superseded incarnation, or a missed terminal event
 * can never frame a dead workbench. That makes safety a property of this
 * function rather than of event delivery.
 *
 * The attempt record composes *alongside* the process facts, never in place of
 * them: a refused replacement has both a live incarnation and a failed attempt,
 * and the pane needs to say both things at once.
 */
export function deriveEditorContextFacts(
  row: EditorContextRow,
  observation: EditorReadinessObservation | undefined,
): EditorContextFacts {
  const base = {
    id: row.id,
    worktreeId: row.worktreeId,
    // Echoed as-is: the pane keys its incarnation-scoped reads on it, so it must
    // be the same identity the diagnostics check compares against.
    activePtyProcessId: row.activePtyProcessId,
    attempt: row.attempt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };

  if (row.activePtyProcessId === null) {
    return {
      ...base,
      // Null rather than `starting`: there is no process, and defaulting to a
      // process status would make an idle context look like a launching one.
      processStatus: null,
      processDiagnostic: null,
      processDiagnosticDetail: null,
      workbenchReadiness: null,
      readinessDetail: null,
      endpoint: null,
      hasDiagnostics: false,
    };
  }

  const endpoint =
    row.endpointHost === null || row.endpointPort === null
      ? null
      : {
          host: row.endpointHost,
          port: row.endpointPort,
          url: editorOrigin(row.endpointHost, row.endpointPort),
        };

  const process = row.activePtyProcess;
  if (process === null) {
    // A durable pointer whose process row was collected. The pointer is the
    // truth about what this context owned; the missing row is the truth about
    // what became of it.
    return {
      ...base,
      processStatus: 'failed',
      processDiagnostic: 'process_missing',
      processDiagnosticDetail: null,
      workbenchReadiness: null,
      readinessDetail: null,
      endpoint,
      hasDiagnostics: false,
    };
  }

  const live = process.status === 'running' || process.status === 'starting';
  const current = observation?.ptyProcessId === row.activePtyProcessId ? observation : undefined;
  const diagnostic = editorProcessDiagnostic(process);

  return {
    ...base,
    processStatus: process.status,
    processDiagnostic: diagnostic,
    processDiagnosticDetail: diagnostic === null ? null : exitDetail(process),
    // `unknown` is the honest answer for a live process this runtime has no
    // observation for: it did not launch it, or it launched it before a restart.
    workbenchReadiness: !live ? null : (current?.state ?? 'unknown'),
    readinessDetail: !live ? null : (current?.detail ?? null),
    endpoint,
    // A pure read of the row's own log fields, so the pane can offer the
    // disclosure without a speculative fetch and this function never touches the
    // filesystem.
    hasDiagnostics: process.logMode === 'backend_file' && process.logPath !== null,
  };
}

/**
 * The incarnation's process row as the editor's own small diagnostic union.
 *
 * Deliberately not `sessionDiagnosticCodeSchema`, which is harness-shaped and
 * would drag harness vocabulary onto an editor that has none.
 */
export function editorProcessDiagnostic(process: PtyProcessRow): EditorProcessDiagnostic | null {
  switch (process.status) {
    case 'starting':
    case 'running':
      return null;
    case 'exited':
      return 'exited';
    case 'killed':
      return 'killed';
    case 'failed':
      switch (process.statusReason) {
        case 'backend_launch_failed':
          return 'launch_failed';
        case 'backend_attach_failed':
          return 'attach_failed';
        // `backend_process_missing` and `runtime_ephemeral_lost` are the two
        // reasons this case exists for. The remaining reasons cannot reach a
        // `failed` editor row through any path this domain owns, and
        // `process_missing` is the honest catch-all for a process the runtime
        // can no longer account for.
        default:
          return 'process_missing';
      }
  }
}
