import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { Context, Data, Effect, Layer } from 'effect';

import { DataDirectory } from './data-directory.js';

export interface WorkspaceState {
  readonly version: 1;
  readonly workspace: {
    readonly activeProjectId: number | null;
    readonly activeWorktreeId: number | null;
  };
}

export class StateFileError extends Data.TaggedError('StateFileError')<{
  readonly cause: unknown;
  readonly operation: string;
}> {}

export interface WorkspaceStateRead extends WorkspaceState {
  readonly recoveryNotice?: string | undefined;
}

export interface StateFileService {
  readonly read: Effect.Effect<WorkspaceStateRead, StateFileError>;
  readonly write: (state: WorkspaceState) => Effect.Effect<void, StateFileError>;
}

export const StateFile = Context.GenericTag<StateFileService>('isagi/StateFile');

const defaultState: WorkspaceState = {
  version: 1,
  workspace: {
    activeProjectId: null,
    activeWorktreeId: null,
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
            const recoveryNotice = `Recovered malformed Isagi state file by moving it to ${backupPath}. Active workspace context was reset.`;
            console.warn(recoveryNotice);
            writeStateFile(directory.paths.statePath, defaultState);
            return { ...defaultState, recoveryNotice };
          }
        },
        catch: (cause) => new StateFileError({ operation: 'read_state_file', cause }),
      }),
      write: (state) =>
        Effect.try({
          try: () => writeStateFile(directory.paths.statePath, state),
          catch: (cause) => new StateFileError({ operation: 'write_state_file', cause }),
        }),
    } satisfies StateFileService;
  }),
);

export function stateFromActiveContext(
  activeProjectId: number | null,
  activeWorktreeId: number | null,
): WorkspaceState {
  return {
    version: 1,
    workspace: { activeProjectId, activeWorktreeId },
  };
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
  };

  return {
    version: 1,
    workspace: {
      activeProjectId: nullablePositiveInteger(workspace.activeProjectId),
      activeWorktreeId: nullablePositiveInteger(workspace.activeWorktreeId),
    },
  };
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
