import assert from 'node:assert/strict';
import test from 'node:test';

import { Plus } from 'lucide-react';

import { dispatchCommandEntry } from './dispatcher.js';
import type { PaletteContext, PaletteEntry } from './types.js';

const ctx: PaletteContext = {
  projects: [],
  activeProject: null,
  activeWorktree: null,
  activeSurface: null,
  activePaneId: null,
};

test('dispatcher immediate command run pushes recent after success', async () => {
  const events: string[] = [];
  const entries: readonly PaletteEntry[] = [
    {
      id: 'fake:run',
      label: 'Fake run',
      icon: Plus,
      group: 'global',
      command: {
        id: 'fake-command',
        label: 'Fake run',
        icon: Plus,
        group: 'global',
        run: () => {
          events.push('run');
        },
      },
      run: () => undefined,
    },
  ];

  await dispatchCommandEntry('fake:run', {}, { entries, ctx, pushRecent: (id) => events.push(id) });

  assert.deepEqual(events, ['run', 'fake:run']);
});

test('dispatcher opens palette with entry id for palette preflight', async () => {
  const opened: Array<{
    readonly entryId: string | undefined;
    readonly value: string | undefined;
  }> = [];
  const entries: readonly PaletteEntry[] = [
    {
      id: 'fake:palette',
      label: 'Fake palette',
      icon: Plus,
      group: 'global',
      command: {
        id: 'fake-command',
        label: 'Fake palette',
        icon: Plus,
        group: 'global',
        preflight: () => ({ mode: 'palette', values: { title: 'Terminal' } }),
        args: [{ kind: 'text', key: 'title', label: 'Title' }],
        run: () => {
          throw new Error('run should not be called');
        },
      },
      run: () => undefined,
    },
  ];

  await dispatchCommandEntry(
    'fake:palette',
    {},
    {
      entries,
      ctx,
      openPalette: (entryId, values) => opened.push({ entryId, value: values?.title }),
      pushRecent: () => {
        throw new Error('recent should not be pushed');
      },
    },
  );

  assert.deepEqual(opened, [{ entryId: 'fake:palette', value: 'Terminal' }]);
});

test('dispatcher routes palette-owned commands through palette with explicit values', async () => {
  const opened: Array<{
    readonly entryId: string | undefined;
    readonly projectId: string | undefined;
    readonly worktreeId: string | undefined;
  }> = [];
  const entries: readonly PaletteEntry[] = [
    {
      id: 'fake:delete-worktree',
      label: 'Delete worktree',
      icon: Plus,
      group: 'worktree-actions',
      command: {
        id: 'fake-delete-worktree',
        label: 'Delete worktree',
        icon: Plus,
        group: 'worktree-actions',
        feedbackSurface: 'palette',
        preflight: () => {
          throw new Error('preflight should be owned by palette');
        },
        run: () => {
          throw new Error('run should be owned by palette');
        },
      },
      run: () => undefined,
    },
  ];

  await dispatchCommandEntry(
    'fake:delete-worktree',
    { projectId: '1', worktreeId: '10' },
    {
      entries,
      ctx,
      openPalette: (entryId, values) =>
        opened.push({ entryId, projectId: values?.projectId, worktreeId: values?.worktreeId }),
      pushRecent: () => {
        throw new Error('recent should not be pushed');
      },
    },
  );

  assert.deepEqual(opened, [{ entryId: 'fake:delete-worktree', projectId: '1', worktreeId: '10' }]);
});

test('dispatcher unavailable preflight no-ops', async () => {
  const events: string[] = [];
  const entries: readonly PaletteEntry[] = [
    {
      id: 'fake:unavailable',
      label: 'Fake unavailable',
      icon: Plus,
      group: 'global',
      command: {
        id: 'fake-command',
        label: 'Fake unavailable',
        icon: Plus,
        group: 'global',
        preflight: () => ({ mode: 'unavailable' }),
        run: () => {
          events.push('run');
        },
      },
      run: () => undefined,
    },
  ];

  await dispatchCommandEntry(
    'fake:unavailable',
    {},
    {
      entries,
      ctx,
      openPalette: () => events.push('open'),
      pushRecent: () => events.push('recent'),
    },
  );

  assert.deepEqual(events, []);
});

test('dispatcher resolves explicit surface commands even when absent from assembled entries', async () => {
  const opened: Array<{
    readonly entryId: string | undefined;
    readonly surfaceId: string | undefined;
    readonly title: string | undefined;
  }> = [];

  await dispatchCommandEntry(
    'rename-active-surface',
    { worktreeId: '10', surfaceId: '501', title: 'Terminal' },
    {
      entries: [],
      ctx,
      openPalette: (entryId, values) =>
        opened.push({ entryId, surfaceId: values?.surfaceId, title: values?.title }),
      pushRecent: () => {
        throw new Error('recent should not be pushed');
      },
    },
  );

  assert.deepEqual(opened, [
    { entryId: 'rename-active-surface', surfaceId: '501', title: 'Terminal' },
  ]);
});

test('dispatcher resolves explicit worktree commands even when absent from assembled entries', async () => {
  const opened: Array<{
    readonly entryId: string | undefined;
    readonly projectId: string | undefined;
    readonly worktreeId: string | undefined;
  }> = [];

  await dispatchCommandEntry(
    'delete-active-worktree',
    { projectId: '1', worktreeId: '11' },
    {
      entries: [],
      ctx,
      openPalette: (entryId, values) =>
        opened.push({ entryId, projectId: values?.projectId, worktreeId: values?.worktreeId }),
      pushRecent: () => {
        throw new Error('recent should not be pushed');
      },
    },
  );

  assert.deepEqual(opened, [
    { entryId: 'delete-active-worktree', projectId: '1', worktreeId: '11' },
  ]);
});
