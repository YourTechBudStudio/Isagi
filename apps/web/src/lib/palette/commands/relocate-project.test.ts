import assert from 'node:assert/strict';
import test from 'node:test';

import type { Project } from '../../workspace/types.js';
import type { Option, PaletteContext } from '../types.js';
import { relocateProjectCommand } from './relocate-project.js';

/**
 * Relocation points a project at a different directory, which the runtime
 * refuses for a folder project before it even checks whether the project is
 * missing. A missing folder recovers at its own path instead (phase 08).
 */

test('relocation offers missing Git projects and no others', async () => {
  const options = await projectOptions(
    ctx([
      missing(gitProject({ id: 2, name: 'gone' })),
      missing({ ...gitProject({ id: 40, name: 'notes' }), kind: 'folder' }),
      gitProject({ id: 1, name: 'isagi' }),
    ]),
  );

  assert.deepEqual(
    options.map((option) => option.value),
    ['2'],
  );
});

test('relocation is available for a missing Git project only', () => {
  assert.equal(
    relocateProjectCommand.available?.(ctx([missing(gitProject({ id: 2, name: 'gone' }))])),
    true,
  );
  assert.equal(
    relocateProjectCommand.available?.(
      ctx([missing({ ...gitProject({ id: 40, name: 'notes' }), kind: 'folder' })]),
    ),
    false,
    'a missing folder project is not relocatable',
  );
  assert.equal(
    relocateProjectCommand.available?.(ctx([gitProject({ id: 1, name: 'isagi' })])),
    false,
    'a present Git project has nowhere to be pointed',
  );
});

async function projectOptions(context: PaletteContext): Promise<readonly Option[]> {
  const spec = relocateProjectCommand.args?.find((arg) => arg.key === 'projectId');
  assert.ok(spec && 'options' in spec);
  return spec.options(context, {});
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
    worktrees: [],
  };
}

function missing(project: Project): Project {
  return { ...project, status: 'missing', missingReason: 'path_not_found', worktrees: [] };
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
