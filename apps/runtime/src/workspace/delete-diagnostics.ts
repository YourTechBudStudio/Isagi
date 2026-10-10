import { eq, inArray } from 'drizzle-orm';
import { Context, Effect, Layer } from 'effect';

import { worktreeCommandRuns, worktreeCommandStates } from '../commands/tables.js';
import {
  agentSessions,
  surfacePanes,
  terminalSessions,
  worktreeSurfaces,
} from '../environment/tables.js';
import { type DatabaseError, RuntimeDatabase } from '../platform/persistence/index.js';

/**
 * What deleting a worktree would destroy: the durable rows its cascade removes and the PTY
 * processes those rows still point at. Read before the delete, both to stop those processes and to
 * report the cascade in the delete's log line.
 */
export interface WorktreeDeleteDiagnostics {
  readonly agentSessionCount: number;
  readonly agentSessionActivePtyProcessIds: readonly number[];
  readonly commandRunCount: number;
  readonly commandRunPtyProcessIds: readonly number[];
  readonly commandStateCount: number;
  readonly commandStateActivePtyProcessIds: readonly number[];
  readonly paneCount: number;
  readonly surfaceCount: number;
  readonly terminalSessionCount: number;
  readonly terminalSessionActivePtyProcessIds: readonly number[];
}

/**
 * The delete preflight's read across the environment and command tables a worktree delete
 * cascades through. A read-only join, which a module may make over the tables of modules it
 * depends on (ADR 0008: only the owner writes).
 */
export class WorktreeDeleteDiagnosticsReader extends Context.Service<
  WorktreeDeleteDiagnosticsReader,
  {
    readonly read: (worktreeId: number) => Effect.Effect<WorktreeDeleteDiagnostics, DatabaseError>;
  }
>()('isagi/runtime/workspace/WorktreeDeleteDiagnosticsReader') {
  static readonly layer = Layer.effect(
    WorktreeDeleteDiagnosticsReader,
    Effect.gen(function* () {
      const database = yield* RuntimeDatabase;
      return WorktreeDeleteDiagnosticsReader.of({
        read: (worktreeId) =>
          database.use('read_worktree_delete_diagnostics', (db) => {
            const surfaces = db
              .select({ id: worktreeSurfaces.id })
              .from(worktreeSurfaces)
              .where(eq(worktreeSurfaces.worktreeId, worktreeId))
              .all();
            const surfaceIds = surfaces.map((surface) => surface.id);
            const panes =
              surfaceIds.length === 0
                ? []
                : db
                    .select({ id: surfacePanes.id })
                    .from(surfacePanes)
                    .where(inArray(surfacePanes.surfaceId, surfaceIds))
                    .all();
            const agents = db
              .select({
                activePtyProcessId: agentSessions.activePtyProcessId,
              })
              .from(agentSessions)
              .where(eq(agentSessions.worktreeId, worktreeId))
              .all();
            const terminals = db
              .select({
                activePtyProcessId: terminalSessions.activePtyProcessId,
              })
              .from(terminalSessions)
              .where(eq(terminalSessions.worktreeId, worktreeId))
              .all();
            const commandStates = db
              .select({
                activePtyProcessId: worktreeCommandStates.activePtyProcessId,
              })
              .from(worktreeCommandStates)
              .where(eq(worktreeCommandStates.worktreeId, worktreeId))
              .all();
            const commandRuns = db
              .select({
                ptyProcessId: worktreeCommandRuns.ptyProcessId,
              })
              .from(worktreeCommandRuns)
              .where(eq(worktreeCommandRuns.worktreeId, worktreeId))
              .all();

            return {
              agentSessionCount: agents.length,
              agentSessionActivePtyProcessIds: compactIds(
                agents.map((agent) => agent.activePtyProcessId),
              ),
              commandRunCount: commandRuns.length,
              commandRunPtyProcessIds: compactIds(commandRuns.map((run) => run.ptyProcessId)),
              commandStateCount: commandStates.length,
              commandStateActivePtyProcessIds: compactIds(
                commandStates.map((state) => state.activePtyProcessId),
              ),
              paneCount: panes.length,
              surfaceCount: surfaces.length,
              terminalSessionCount: terminals.length,
              terminalSessionActivePtyProcessIds: compactIds(
                terminals.map((terminal) => terminal.activePtyProcessId),
              ),
            } satisfies WorktreeDeleteDiagnostics;
          }),
      });
    }),
  );
}

/** The live session processes a worktree delete must stop, each once. */
export function sessionPtyProcessIds(diagnostics: WorktreeDeleteDiagnostics): number[] {
  return [
    ...new Set([
      ...diagnostics.agentSessionActivePtyProcessIds,
      ...diagnostics.terminalSessionActivePtyProcessIds,
    ]),
  ];
}

function compactIds(ids: readonly (number | null)[]) {
  return ids.filter((id): id is number => id !== null);
}
