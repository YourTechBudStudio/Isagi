import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { Context, Data, Effect, Layer } from 'effect';

import { DataDirectory } from './data-directory.service.js';

export interface WorkspaceState {
  readonly version: 1;
  readonly workspace: {
    readonly activeProjectId: number | null;
    readonly activeWorktreeId: number | null;
    readonly activeContextRevision: number;
  };
}

export class StateFileError extends Data.TaggedError('StateFileError')<{
  readonly cause: unknown;
  readonly operation: string;
}> {}

export interface StateFileService {
  readonly read: Effect.Effect<WorkspaceState, StateFileError>;
  readonly write: (state: WorkspaceState) => Effect.Effect<void, StateFileError>;
  readonly writeActiveContextIfFresh: (input: {
    readonly activeProjectId: number | null;
    readonly activeWorktreeId: number | null;
    readonly revision: number;
  }) => Effect.Effect<WorkspaceState, StateFileError>;
}

export const StateFile = Context.GenericTag<StateFileService>('isagi/StateFile');

const defaultState: WorkspaceState = {
  version: 1,
  workspace: {
    activeProjectId: null,
    activeWorktreeId: null,
    activeContextRevision: 0,
  },
};

export const StateFileLive = Layer.effect(
  StateFile,
  Effect.gen(function* () {
    const directory = yield* DataDirectory;

    return {
      read: Effect.try({
        try: () => {
          if (!existsSync(directory.paths.statePath)) {
            writeStateFile(directory.paths.statePath, defaultState);
            return defaultState;
          }

          try {
            return parseState(JSON.parse(readFileSync(directory.paths.statePath, 'utf8')));
          } catch {
            const backupPath = `${directory.paths.statePath}.malformed-${Date.now()}`;
            renameSync(directory.paths.statePath, backupPath);
            const recoveryMessage = `Recovered malformed Isagi state file by moving it to ${backupPath}. Active workspace context was reset.`;
            // This is intentionally a runtime-only diagnostic for now. The workspace
            // snapshot stays declarative and does not carry transient recovery messages.
            console.warn(recoveryMessage);
            writeStateFile(directory.paths.statePath, defaultState);
            return defaultState;
          }
        },
        catch: (cause) => new StateFileError({ operation: 'read_state_file', cause }),
      }),
      write: (state) =>
        Effect.try({
          try: () => writeStateFile(directory.paths.statePath, state),
          catch: (cause) => new StateFileError({ operation: 'write_state_file', cause }),
        }),
      writeActiveContextIfFresh: (input) =>
        Effect.try({
          try: () => {
            const current = readStateFile(directory.paths.statePath);
            if (input.revision <= current.workspace.activeContextRevision) {
              return current;
            }
            const next = stateFromActiveContext(
              input.activeProjectId,
              input.activeWorktreeId,
              input.revision,
            );
            writeStateFile(directory.paths.statePath, next);
            return next;
          },
          catch: (cause) =>
            new StateFileError({ operation: 'write_active_context_state_file', cause }),
        }),
    } satisfies StateFileService;
  }),
);

export function stateFromActiveContext(
  activeProjectId: number | null,
  activeWorktreeId: number | null,
  activeContextRevision = 0,
): WorkspaceState {
  return {
    version: 1,
    workspace: { activeProjectId, activeWorktreeId, activeContextRevision },
  };
}

function readStateFile(path: string): WorkspaceState {
  if (!existsSync(path)) {
    writeStateFile(path, defaultState);
    return defaultState;
  }
  return parseState(JSON.parse(readFileSync(path, 'utf8')));
}

function parseState(value: unknown): WorkspaceState {
  if (!value || typeof value !== 'object') {
    throw new Error('state.json must contain an object');
  }

  const candidate = value as { version?: unknown; workspace?: unknown };
  if (candidate.version !== 1 || !candidate.workspace || typeof candidate.workspace !== 'object') {
    throw new Error('state.json has an unsupported shape');
  }

  const workspace = candidate.workspace as {
    activeProjectId?: unknown;
    activeWorktreeId?: unknown;
    activeContextRevision?: unknown;
  };

  return {
    version: 1,
    workspace: {
      activeProjectId: nullablePositiveInteger(workspace.activeProjectId),
      activeWorktreeId: nullablePositiveInteger(workspace.activeWorktreeId),
      activeContextRevision: nonNegativeInteger(workspace.activeContextRevision),
    },
  };
}

function nonNegativeInteger(value: unknown): number {
  if (value === null || value === undefined) {
    return 0;
  }
  if (Number.isInteger(value) && typeof value === 'number' && value >= 0) {
    return value;
  }
  throw new Error('state.json active context revision must be a non-negative integer');
}

function nullablePositiveInteger(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (Number.isInteger(value) && typeof value === 'number' && value > 0) {
    return value;
  }
  throw new Error('state.json active ids must be positive integers or null');
}

function writeStateFile(path: string, state: WorkspaceState) {
  const tempPath = join(dirname(path), `.state-${process.pid}-${Date.now()}.tmp`);
  writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  renameSync(tempPath, path);
}
