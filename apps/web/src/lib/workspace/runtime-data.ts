import { Effect } from 'effect';

import type { PathSuggestOutput, WorkspaceSnapshot } from '@isagi/contracts';

import { createIsagiClient, type IsagiClient } from '../../client.js';
import { resolveRuntimeUrl } from '../runtime.js';

let cachedClient: IsagiClient | null = null;
let cachedRuntimeUrl: string | null = null;

export function fetchWorkspace() {
  return getClient().pipe(
    Effect.flatMap((client) =>
      Effect.tryPromise({
        try: () => client.workspace.get(),
        catch: toError,
      }),
    ),
  );
}

export function updateActiveContext(worktreeId: number) {
  return getClient().pipe(
    Effect.flatMap((client) =>
      Effect.tryPromise({
        try: () => client.workspace.setActiveContext({ worktreeId }),
        catch: toError,
      }),
    ),
  );
}

export function addProject(path: string) {
  return getClient().pipe(
    Effect.flatMap((client) =>
      Effect.tryPromise({
        try: () => client.projects.add({ path }),
        catch: toError,
      }),
    ),
  );
}

export function suggestProjectPaths(
  input: string,
  limit = 25,
): Effect.Effect<PathSuggestOutput, Error> {
  return getClient().pipe(
    Effect.flatMap((client) =>
      Effect.tryPromise({
        try: () => client.paths.suggest({ input, limit }),
        catch: toError,
      }),
    ),
  );
}

function getClient() {
  return resolveRuntimeUrl().pipe(
    Effect.map((runtimeUrl) => {
      if (!cachedClient || cachedRuntimeUrl !== runtimeUrl) {
        cachedClient = createIsagiClient(runtimeUrl);
        cachedRuntimeUrl = runtimeUrl;
      }
      return cachedClient;
    }),
  );
}

export function formatRuntimeError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export type { WorkspaceSnapshot };

function toError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}
