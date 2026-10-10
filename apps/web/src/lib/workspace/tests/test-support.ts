import type { TestContext } from 'node:test';

import { Effect } from 'effect';
import type { AtomRegistry } from 'effect/reactivity';

import type { ProjectKind, WorkspaceSnapshot } from '@isagi/contracts';

import type { RuntimeApiShape } from '../../runtime/client.js';
import { controllable, flush, makeTestRegistry } from '../../state/testing.js';
import type { WorkspaceData } from '../model.js';
import { cachedWorkspaceData, workspaceAtom } from '../queries.js';
import { terminalFactsAtom, type TerminalWorkspaceFact } from '../terminal-presentation/facts.js';
import type { Project, Surface, Worktree } from '../types.js';

export function surface(input: { readonly id: number; readonly title?: string }): Surface {
  return {
    id: input.id,
    title: input.title ?? `surface-${input.id}`,
    paneKinds: [],
    attention: 'idle',
  };
}

export function worktree(input: {
  readonly id: number;
  readonly projectId: number;
  readonly title?: string;
  readonly isRoot?: boolean;
  readonly surfaces?: readonly Surface[];
}): Worktree {
  const title = input.title ?? (input.isRoot ? 'main' : `worktree-${input.id}`);
  return {
    id: input.id,
    projectId: input.projectId,
    title,
    path: `/repo/${input.projectId}/${title}`,
    branch: title,
    head: 'abcdef0',
    isRoot: input.isRoot ?? false,
    attention: 'idle',
    parked: false,
    surfaces: input.surfaces ?? [],
    activeSurfaceId: null,
  };
}

export function project(input: {
  readonly id: number;
  readonly name: string;
  readonly surfaces?: readonly Surface[];
  /** Replaces the default single root worktree outright. */
  readonly worktrees?: readonly Worktree[];
  readonly status?: 'present' | 'missing';
  /** Defaults to a Git project; folder fixtures pass this explicitly. */
  readonly kind?: ProjectKind;
}): Project {
  const base = {
    id: input.id,
    name: input.name,
    rootPath: `/repo/${input.name}`,
    kind: input.kind ?? 'git',
    glyph: input.name.slice(0, 2).toUpperCase(),
    accent: 'blue' as const,
    worktrees: input.worktrees ?? [
      worktree({
        id: input.id * 10,
        projectId: input.id,
        isRoot: true,
        surfaces: input.surfaces ?? [],
      }),
    ],
  };
  return input.status === 'missing'
    ? { ...base, status: 'missing', missingReason: 'path_not_found' }
    : { ...base, status: 'present' };
}

export function workspace(projects: readonly Project[]): WorkspaceData {
  return { projects };
}

// --- App-state helpers ------------------------------------------------------------------------------

/** The runtime's wire shape of `data`: what a fake `fetchWorkspace` answers. */
export function snapshotOf(data: WorkspaceData): WorkspaceSnapshot {
  return {
    projects: data.projects.map(({ glyph: _glyph, accent: _accent, worktrees, ...rest }) => ({
      ...rest,
      worktrees: worktrees.map(({ attention: _attention, surfaces, ...worktreeRest }) => ({
        ...worktreeRest,
        surfaces: surfaces.map(({ attention: _surfaceAttention, ...surfaceRest }) => surfaceRest),
      })),
    })),
  } as unknown as WorkspaceSnapshot;
}

/** A failure a fake endpoint answers with; the message is what callers and toasts see. */
export const refuse = (message: string) =>
  Effect.fail(new Error(message)) as unknown as Effect.Effect<never, never>;

/** One scripted workspace read: data, a failure message, or a request the test answers. */
export type ScriptedRead =
  | WorkspaceData
  | { readonly fail: string }
  | { readonly pending: ReturnType<typeof controllable<WorkspaceSnapshot>> };

/**
 * A test app session whose `fetchWorkspace` answers `reads` in order (the last one repeats) and
 * counts every read that actually ran. Disposed with the test.
 */
export function workspaceSession(
  t: TestContext,
  reads: readonly ScriptedRead[],
  options: { readonly api?: Partial<RuntimeApiShape>; readonly retry?: boolean } = {},
) {
  const log: string[] = [];
  let index = 0;
  const registry = makeTestRegistry({
    retry: options.retry ?? false,
    api: {
      fetchWorkspace: () =>
        Effect.suspend(() => {
          const read = reads[Math.min(index++, reads.length - 1)];
          log.push('workspace');
          if (read === undefined) return refuse('no workspace read is scripted');
          if ('fail' in read) return refuse(read.fail);
          if ('pending' in read) return read.pending.effect;
          return Effect.succeed(snapshotOf(read));
        }),
      ...options.api,
    },
  });
  t.after(() => registry.dispose());
  return { registry, log, reads: () => log.filter((entry) => entry === 'workspace').length };
}

/** Mount the workspace like a reader component would, and let the first read land. */
export async function holdWorkspace(t: TestContext, registry: AtomRegistry.AtomRegistry) {
  const release = registry.mount(workspaceAtom);
  t.after(release);
  await flush();
  return release;
}

/** The project ids the session currently holds. */
export const heldProjectIds = (registry: AtomRegistry.AtomRegistry) =>
  cachedWorkspaceData(registry)?.projects.map(({ id }) => id);

/** Record terminal facts published on this session (`type` or `type:worktreeId`). */
export function recordFacts(registry: AtomRegistry.AtomRegistry, events: string[]) {
  return registry.get(terminalFactsAtom).subscribe((fact: TerminalWorkspaceFact) => {
    events.push(
      fact.type === 'durable_worktree_deleted' ? `${fact.type}:${fact.worktreeId}` : fact.type,
    );
  });
}
