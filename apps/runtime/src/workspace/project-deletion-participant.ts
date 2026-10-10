import { Context } from 'effect';

import type { RuntimeDrizzleDatabase } from '../platform/persistence/index.js';

/**
 * Port: another module's rows that must be erased in the same transaction that deletes a project.
 *
 * The workspace owns the transaction that deletes a project; a module above it (today: workflows,
 * whose runs reference the project) owns the SQL that erases its own rows inside that transaction
 * (ADR 0008). The workspace cannot import that module, so it names this port and the composition
 * root wires the implementation (`WorkflowProjectErasure`).
 */
export class ProjectDeletionParticipant extends Context.Service<
  ProjectDeletionParticipant,
  {
    /**
     * Runs inside workspace's `deleteProject` transaction (a better-sqlite3 synchronous callback),
     * first, even when no project row matches. Returns the number of rows erased. A throw rolls
     * back the whole delete.
     */
    readonly eraseInTransaction: (db: RuntimeDrizzleDatabase, projectId: number) => number;
  }
>()('isagi/runtime/workspace/ProjectDeletionParticipant') {}
