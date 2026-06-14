import assert from 'node:assert/strict';
import test from 'node:test';

import { Plus } from 'lucide-react';

import {
  commandForEntryId,
  computeStepOptions,
  defaultOptionIndex,
  reviewChoiceCancels,
} from './model.js';
import type { ArgSpec, PaletteCommand, PaletteEntry, ReviewChoice } from './types.js';

const options = [
  { value: 'alpha', label: 'Alpha' },
  { value: 'bravo', label: 'Bravo', isDefault: true },
];

test('wizard select steps can opt out of empty-query default selection', () => {
  const spec: ArgSpec = {
    kind: 'select',
    key: 'worktreeId',
    label: 'Worktree',
    defaultSelection: 'none',
    options: () => options,
  };

  assert.equal(defaultOptionIndex(spec, options), null);
});

test('wizard select steps default to explicit defaults when allowed', () => {
  const spec: ArgSpec = {
    kind: 'select',
    key: 'projectId',
    label: 'Project',
    options: () => options,
  };

  assert.equal(defaultOptionIndex(spec, options), 1);
});

test('combo create options use command-specific copy', () => {
  const spec: ArgSpec = {
    kind: 'combo',
    key: 'branch',
    label: 'Worktree',
    createHint: 'create branch',
    options: () => [],
  };

  assert.deepEqual(computeStepOptions(spec, [], 'feature/new'), [
    { value: 'feature/new', create: true, hint: 'create branch' },
  ]);
});

test('autostart command lookup resolves contextual assembled entry ids', () => {
  const command: PaletteCommand = {
    id: 'rename-active-surface',
    label: 'Rename active surface',
    icon: Plus,
    group: 'worktree-actions',
    args: [{ kind: 'text', key: 'title', label: 'Surface title' }],
    run: () => undefined,
  };
  const entries: readonly PaletteEntry[] = [
    {
      id: 'worktree:10:rename-active-surface',
      label: command.label,
      icon: command.icon,
      group: command.group,
      command,
      values: { worktreeId: '10', surfaceId: '501' },
      run: () => undefined,
    },
  ];

  assert.deepEqual(commandForEntryId(entries, 'worktree:10:rename-active-surface'), {
    entryId: 'worktree:10:rename-active-surface',
    command,
    values: { worktreeId: '10', surfaceId: '501' },
  });
  assert.equal(commandForEntryId(entries, command.id), null);
});

test('review cancel choices are behaviorally distinct from accept choices', () => {
  const cancel = {
    value: 'cancel',
    label: 'Cancel',
    intent: 'cancel',
  } satisfies ReviewChoice;
  const danger = {
    value: 'delete',
    label: 'Delete',
    intent: 'danger',
  } satisfies ReviewChoice;

  assert.equal(reviewChoiceCancels(cancel), true);
  assert.equal(reviewChoiceCancels(danger), false);
});
