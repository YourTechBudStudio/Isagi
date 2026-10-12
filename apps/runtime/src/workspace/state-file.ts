import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { Context, Data, Effect, Layer } from 'effect';

import { DataDirectory } from '../platform/persistence/index.js';

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

const defaultState: WorkspaceState = {
  version: 1,
  workspace: {
    activeProjectId: null,
    activeWorktreeId: null,
    activeContextRevision: 0,
  },
};

/** What reading `state.json` found: a valid state, no file yet, or a file that failed to parse or validate. */
type StateFileContents =
  | { readonly _tag: 'Parsed'; readonly state: WorkspaceState }
  | { readonly _tag: 'Absent' }
  | { readonly _tag: 'Malformed' };

const make = Effect.gen(function* () {
  const directory = yield* DataDirectory;
  const statePath = directory.paths.statePath;
  const readFailed = (cause: unknown) =>
    new StateFileError({ operation: 'read_state_file', cause });

  /**
   * A malformed file is moved aside and replaced by the default state, so a bad edit costs the user their active
   * context and nothing else. The backup keeps the original for diagnosis.
   */
  const recoverMalformed = Effect.fnUntraced(function* () {
    const backupPath = `${statePath}.malformed-${Date.now()}`;
    yield* Effect.try({
      try: () => {
        renameSync(statePath, backupPath);
        writeStateFile(statePath, defaultState);
      },
      catch: readFailed,
    });
    // Runtime-only on purpose: the workspace snapshot stays declarative and carries no transient recovery messages.
    yield* Effect.logWarning(
      'Recovered malformed Isagi state file; active workspace context was reset',
    ).pipe(Effect.annotateLogs({ backupPath }));
    return defaultState;
  });

  return StateFile.of({
    read: Effect.gen(function* () {
      const contents = yield* Effect.try({ try: () => readContents(statePath), catch: readFailed });
      switch (contents._tag) {
        case 'Parsed':
          return contents.state;
        case 'Absent':
          yield* Effect.try({
            try: () => writeStateFile(statePath, defaultState),
            catch: readFailed,
          });
          return defaultState;
        case 'Malformed':
          return yield* recoverMalformed();
      }
    }).pipe(Effect.withSpan('StateFile.read')),
    write: Effect.fn('StateFile.write')(function* (state: WorkspaceState) {
      yield* Effect.try({
        try: () => writeStateFile(statePath, state),
        catch: (cause) => new StateFileError({ operation: 'write_state_file', cause }),
      });
    }),
    writeActiveContextIfFresh: Effect.fn('StateFile.writeActiveContextIfFresh')(function* (input: {
      readonly activeProjectId: number | null;
      readonly activeWorktreeId: number | null;
      readonly revision: number;
    }) {
      return yield* Effect.try({
        try: () => {
          const current = readStateFile(statePath);
          if (input.revision <= current.workspace.activeContextRevision) {
            return current;
          }
          const next = stateFromActiveContext(
            input.activeProjectId,
            input.activeWorktreeId,
            input.revision,
          );
          writeStateFile(statePath, next);
          return next;
        },
        catch: (cause) =>
          new StateFileError({ operation: 'write_active_context_state_file', cause }),
      });
    }),
  });
});

/**
 * Synchronous on purpose: reads and writes of `state.json` are atomic with respect to fibers, which
 * `writeActiveContextIfFresh`'s read-compare-write relies on. Only `existsSync` can throw out of here; an unreadable or
 * invalid file is `Malformed`.
 */
function readContents(path: string): StateFileContents {
  if (!existsSync(path)) {
    return { _tag: 'Absent' };
  }
  try {
    return { _tag: 'Parsed', state: parseState(JSON.parse(readFileSync(path, 'utf8'))) };
  } catch {
    return { _tag: 'Malformed' };
  }
}

export class StateFile extends Context.Service<
  StateFile,
  {
    readonly read: Effect.Effect<WorkspaceState, StateFileError>;
    readonly write: (state: WorkspaceState) => Effect.Effect<void, StateFileError>;
    readonly writeActiveContextIfFresh: (input: {
      readonly activeProjectId: number | null;
      readonly activeWorktreeId: number | null;
      readonly revision: number;
    }) => Effect.Effect<WorkspaceState, StateFileError>;
  }
>()('isagi/runtime/workspace/StateFile') {
  static readonly layer = Layer.effect(StateFile, make);
}

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

/**
 * The validator for `state.json`: deliberately lenient, so a file an older runtime wrote never reads as
 * malformed. A missing or `null` revision is 0, and a missing or `null` id is `null`. Anything else that does not fit
 * throws, and `read` treats the file as malformed.
 */
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
