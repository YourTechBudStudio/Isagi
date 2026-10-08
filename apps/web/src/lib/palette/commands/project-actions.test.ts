import assert from 'node:assert/strict';
import test from 'node:test';

import { projectActionsCopy } from '../../../copy/index.js';
import { project } from '../../workspace/tests/test-support.js';
import { dispatchCommandEntry } from '../dispatcher.js';
import { assembleEntries } from '../entries.js';
import type { ArgValues, PaletteContext } from '../types.js';
import { deleteProjectCommand, projectIdFromValues } from './project-actions.js';
import { workbenchActionCommands } from './workbench-actions.js';

const active = project({ id: 3, name: 'active' });
const target = project({ id: 7, name: 'target' });
const disconnected = project({ id: 9, name: 'adrift', status: 'missing' });

test('delete-project is offered in search only with an active project', () => {
  assert.equal(deleteProjectCommand.available?.(ctx({ activeProject: active })), true);
  assert.equal(deleteProjectCommand.available?.(ctx({ activeProject: null })), false);
});

test('an explicit project id wins over the active project', () => {
  const context = ctx({ activeProject: active });
  assert.equal(projectIdFromValues({ projectId: '7' }, context), 7);
  assert.equal(projectIdFromValues({}, context), 3);
  for (const invalid of ['0', '-1', '1.5', 'abc', '']) {
    assert.equal(projectIdFromValues({ projectId: invalid }, context), 3, invalid);
  }
  assert.equal(projectIdFromValues({}, ctx({ activeProject: null })), null);
});

test('the review names the target project and its folder, with danger and cancel', async () => {
  const content = await loadReview({ projectId: '7' }, ctx({ activeProject: active }));

  assert.equal(content?.title, projectActionsCopy.deleteProject.review.title('target'));
  assert.equal(content?.body, projectActionsCopy.deleteProject.review.body);
  assert.deepEqual(content?.items, [{ label: 'target', detail: '/repo/target' }]);
  assert.deepEqual(
    content?.choices.map(({ value, label, intent }) => ({ value, label, intent })),
    [
      { value: 'delete', label: 'Delete project', intent: 'danger' },
      { value: 'cancel', label: 'Cancel', intent: 'cancel' },
    ],
  );
});

test('a disconnected project can be reviewed even though it is never active', async () => {
  const content = await loadReview({ projectId: '9' }, ctx({ activeProject: null }));
  assert.deepEqual(content?.items, [{ label: 'adrift', detail: '/repo/adrift' }]);
});

test('an unknown project makes the review fail instead of offering a delete', async () => {
  await assert.rejects(() => loadReview({ projectId: '404' }, ctx({ activeProject: active })), {
    message: projectActionsCopy.deleteProject.gone,
  });
  await assert.rejects(() => loadReview({}, ctx({ activeProject: null })), {
    message: projectActionsCopy.deleteProject.gone,
  });
});

test('explicit-target triggers resolve the command and keep their own id', async () => {
  assert.ok(workbenchActionCommands.some((command) => command.id === 'delete-project'));

  // With an active project the assembled entry carries *its* id; the trigger's
  // id must still be the one the palette opens on.
  const withActive = ctx({ activeProject: active });
  assert.deepEqual(await dispatchOpened(withActive, { projectId: '7' }), {
    entryId: 'delete-project',
    values: { projectId: '7' },
  });

  // A disconnected project has no assembled entry at all.
  assert.deepEqual(await dispatchOpened(ctx({ activeProject: null }), { projectId: '9' }), {
    entryId: 'delete-project',
    values: { projectId: '9' },
  });
});

async function loadReview(values: ArgValues, context: PaletteContext) {
  const step = deleteProjectCommand.args?.[0];
  assert.equal(step?.kind, 'review');
  if (step?.kind !== 'review') return null;
  return step.load(context, values);
}

async function dispatchOpened(context: PaletteContext, values: ArgValues) {
  let opened: { entryId: string | undefined; values: ArgValues | undefined } | null = null;
  await dispatchCommandEntry('delete-project', values, {
    entries: assembleEntries(context),
    ctx: context,
    openPalette: (entryId, openedValues) => {
      opened = { entryId, values: openedValues };
    },
  });
  return opened;
}

function ctx(input: { readonly activeProject: PaletteContext['activeProject'] }): PaletteContext {
  const activeProject = input.activeProject;
  return {
    projects: [active, target, disconnected],
    activeProject,
    activeWorktree: activeProject?.worktrees[0] ?? null,
    activeSurface: null,
    activePaneId: null,
    launchableHarnesses: [],
    editorAvailable: false,
  };
}
