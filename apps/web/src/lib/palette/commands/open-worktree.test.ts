import assert from 'node:assert/strict';
import test from 'node:test';

import { paletteCopy } from '../../../copy/index.js';
import { useWorkspaceStore } from '../../workspace/store.js';
import type { Project, Worktree } from '../../workspace/types.js';
import type { CommandOutcome, Option, PaletteContext } from '../types.js';
import { openWorktreeCommand } from './open-worktree.js';

/**
 * `open-worktree` creates checkouts, which a folder project cannot have. The web
 * filters it to Git projects for honesty; the runtime refuses regardless.
 *
 * The selection-only paths through `run` need their own guard, because they
 * never reach the runtime and so can never be refused by it.
 */

test.afterEach(() => {
  useWorkspaceStore.setState({ selection: { kind: 'empty' } });
});

test('open-worktree offers present Git projects and no others', async () => {
  const options = await projectOptions(
    ctx([
      gitProject({ id: 1, name: 'isagi' }),
      folderProject({ id: 40, name: 'notes' }),
      {
        ...gitProject({ id: 2, name: 'gone' }),
        status: 'missing',
        missingReason: 'path_not_found',
        worktrees: [],
      } as Project,
    ]),
  );

  assert.deepEqual(
    options.map((option) => option.value),
    ['1'],
  );
});

test('open-worktree is available with a Git project and unavailable without one', () => {
  assert.equal(
    openWorktreeCommand.available?.(ctx([gitProject({ id: 1, name: 'isagi' })])),
    true,
    'a present Git project makes it available',
  );
  assert.equal(
    openWorktreeCommand.available?.(
      ctx([folderProject({ id: 40, name: 'notes' }), folderProject({ id: 50, name: 'scratch' })]),
    ),
    false,
    'an all-folder workspace offers nothing to open',
  );
});

test('an existing-worktree payload selects its target when the project is still eligible', async () => {
  const context = ctx([gitProject({ id: 1, name: 'isagi' })]);

  const outcome = await openWorktreeCommand.run({}, context, {
    branch: { kind: 'existing_worktree', projectId: 1, worktreeId: 11 },
  });

  assert.equal(outcome, undefined, 'the Git fast path stays a plain selection');
  assert.deepEqual(useWorkspaceStore.getState().selection, {
    kind: 'worktree',
    projectId: 1,
    worktreeId: 11,
  });
});

test('an existing-worktree payload naming a deleted worktree refuses without selecting', async () => {
  // The worktree was in the options when they were assembled and is gone from
  // the latest client-observed workspace by the time `run` fires.
  const outcome = await openWorktreeCommand.run({}, ctx([gitProject({ id: 1, name: 'isagi' })]), {
    branch: { kind: 'existing_worktree', projectId: 1, worktreeId: 999 },
  });

  assertUnavailable(outcome);
  assert.deepEqual(useWorkspaceStore.getState().selection, { kind: 'empty' });
});

test('an existing-worktree payload naming an ineligible project refuses without selecting', async () => {
  // Kind is immutable, so this guards a forced or replayed payload rather than a
  // live transition — but selection is client-only, so nothing else would catch it.
  const outcome = await openWorktreeCommand.run(
    {},
    ctx([folderProject({ id: 40, name: 'notes' })]),
    {
      branch: { kind: 'existing_worktree', projectId: 40, worktreeId: 401 },
    },
  );

  assertUnavailable(outcome);
  assert.deepEqual(useWorkspaceStore.getState().selection, { kind: 'empty' });
});

test('the values path refuses an absent or ineligible project instead of completing silently', async () => {
  assertUnavailable(
    await openWorktreeCommand.run({ projectId: '77', branch: 'main' }, ctx([]), {}),
    'a project that is no longer in the workspace',
  );
  assertUnavailable(
    await openWorktreeCommand.run(
      { projectId: '40', branch: 'main' },
      ctx([folderProject({ id: 40, name: 'notes' })]),
      {},
    ),
    'a project that cannot hold another checkout',
  );
  assert.deepEqual(useWorkspaceStore.getState().selection, { kind: 'empty' });
});

test('an empty branch on an eligible project stays silent rather than blaming the workspace', async () => {
  // Missing input is not a changed workspace. Borrowing the unavailable wording
  // here would explain the situation falsely.
  const outcome = await openWorktreeCommand.run(
    { projectId: '1', branch: '' },
    ctx([gitProject({ id: 1, name: 'isagi' })]),
    {},
  );

  assert.equal(outcome, undefined);
});

function assertUnavailable(outcome: CommandOutcome | void, message?: string) {
  assert.ok(outcome && outcome.kind === 'error', message ?? 'expected an error outcome');
  assert.equal(outcome.content.title, paletteCopy.outcome.commandUnavailableTitle);
  assert.equal(outcome.content.body, paletteCopy.outcome.commandUnavailableBody);
}

async function projectOptions(context: PaletteContext): Promise<readonly Option[]> {
  const spec = openWorktreeCommand.args?.find((arg) => arg.key === 'projectId');
  assert.ok(spec && 'options' in spec);
  return spec.options(context, {});
}

function worktree(id: number, projectId: number): Worktree {
  return {
    id,
    projectId,
    title: 'main',
    path: `/repo/${projectId}`,
    branch: 'main',
    head: 'abcdef0',
    isRoot: true,
    attention: 'idle',
    parked: false,
    surfaces: [],
    activeSurfaceId: null,
  };
}

function gitProject(input: { readonly id: number; readonly name: string }): Project {
  return {
    id: input.id,
    name: input.name,
    rootPath: `/repo/${input.name}`,
    kind: 'git',
    glyph: 'IS',
    accent: 'blue',
    status: 'present',
    worktrees: [worktree(input.id * 10 + 1, input.id)],
  };
}

function folderProject(input: { readonly id: number; readonly name: string }): Project {
  return {
    ...gitProject(input),
    kind: 'folder',
    worktrees: [
      { ...worktree(input.id * 10 + 1, input.id), title: 'folder', branch: null, head: null },
    ],
  };
}

function ctx(projects: readonly Project[]): PaletteContext {
  return {
    projects,
    activeProject: null,
    activeWorktree: null,
    activeSurface: null,
    activePaneId: null,
    launchableHarnesses: [],
    editorAvailable: false,
  };
}
