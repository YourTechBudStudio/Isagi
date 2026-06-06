import { Effect } from 'effect';

import type { PathSuggestOutput, WorkspaceSnapshot } from '@isagi/contracts';

import { createRuntimeClient, RuntimeApiError, type RuntimeClient } from '../runtime/client.js';
import { resolveRuntimeUrl } from '../runtime/resolve.js';

let cachedClient: RuntimeClient | null = null;
let cachedRuntimeUrl: string | null = null;

export function fetchWorkspace() {
  return getClient().pipe(Effect.flatMap((client) => client.fetchWorkspace()));
}

export function updateActiveContext(worktreeId: number) {
  return getClient().pipe(Effect.flatMap((client) => client.updateActiveContext(worktreeId)));
}

export function addProject(path: string) {
  return getClient().pipe(Effect.flatMap((client) => client.addProject(path)));
}

export function suggestProjectPaths(
  input: string,
  limit = 25,
): Effect.Effect<PathSuggestOutput, Error> {
  return getClient().pipe(Effect.flatMap((client) => client.suggestProjectPaths(input, limit)));
}

function getClient() {
  return resolveRuntimeUrl().pipe(
    Effect.map((runtimeUrl) => {
      if (!cachedClient || cachedRuntimeUrl !== runtimeUrl) {
        cachedClient = createRuntimeClient(runtimeUrl);
        cachedRuntimeUrl = runtimeUrl;
      }
      return cachedClient;
    }),
  );
}

export function formatRuntimeError(error: unknown) {
  if (error instanceof RuntimeApiError) {
    return `${error.apiError.message} (${error.apiError.code}, request ${error.apiError.requestId})`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export type { WorkspaceSnapshot };
