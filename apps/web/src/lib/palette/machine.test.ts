import assert from 'node:assert/strict';
import test from 'node:test';

import { Plus } from 'lucide-react';

import { initialPaletteState, paletteReducer } from './machine.js';
import type { PaletteCommand, PaletteContext, PaletteEntry } from './types.js';

const ctx: PaletteContext = {
  projects: [],
  activeProject: null,
  activeWorktree: null,
  activeSurface: null,
  activePaneId: null,
  launchableHarnesses: [],
};

test('opens into search and tracks query', () => {
  let state = paletteReducer(initialPaletteState, { type: 'opened' });
  assert.equal(state.kind, 'search');

  state = paletteReducer(state, { type: 'query-changed', query: 'open' });
  assert.equal(state.kind, 'search');
  assert.equal(state.query, 'open');
});

test('activation preflights commands and ignores stale completions', () => {
  const command = fakeCommand({
    preflight: () => ({ mode: 'run', values: { ok: '1' } }),
  });
  const entry = fakeEntry(command);
  let state = paletteReducer(initialPaletteState, { type: 'opened' });

  state = paletteReducer(state, { type: 'activate-entry', entry, ctx });

  assert.equal(state.kind, 'search');
  assert.equal(state.effects.at(0)?.kind, 'preflight');
  const attemptId = state.effects.at(0)?.attemptId;
  assert.equal(state.preflightAttemptId, attemptId);

  state = paletteReducer(state, {
    type: 'preflight-failed',
    attemptId: (attemptId ?? 0) + 1,
    error: 'stale',
  });
  assert.equal(state.kind, 'search');
  assert.equal(state.inlineError, null);

  state = paletteReducer(state, {
    type: 'preflight-succeeded',
    attemptId: attemptId ?? 0,
    entryId: entry.id,
    command,
    ctx,
    result: { mode: 'run', values: { ok: '1' } },
  });

  assert.equal(state.kind, 'search');
  assert.equal(state.runAttemptId, (attemptId ?? 0) + 1);
  assert.equal(state.effects.at(-1)?.kind, 'run');
});

test('activation preflight carries entry-captured values', () => {
  const command = fakeCommand({
    preflight: () => ({ mode: 'palette' }),
  });
  const entry = {
    ...fakeEntry(command),
    values: { projectId: '1', worktreeId: '11' },
  } satisfies PaletteEntry;
  let state = paletteReducer(initialPaletteState, { type: 'opened' });

  state = paletteReducer(state, { type: 'activate-entry', entry, ctx });

  const effect = state.effects.at(0);
  assert.equal(effect?.kind, 'preflight');
  assert.deepEqual(effect?.kind === 'preflight' ? effect.values : null, {
    projectId: '1',
    worktreeId: '11',
  });
});

test('preflight can enter a wizard with preserved values', () => {
  const command = fakeCommand({
    preflight: () => ({ mode: 'palette', values: { name: 'Terminal' } }),
    args: [{ kind: 'text', key: 'name', label: 'Name' }],
  });
  const entry = fakeEntry(command);
  let state = paletteReducer(initialPaletteState, { type: 'opened' });

  state = paletteReducer(state, { type: 'activate-entry', entry, ctx });
  const attemptId = state.effects.at(0)?.attemptId ?? 0;
  state = paletteReducer(state, {
    type: 'preflight-succeeded',
    attemptId,
    entryId: entry.id,
    command,
    ctx,
    result: { mode: 'palette', values: { name: 'Terminal' } },
  });

  assert.equal(state.kind, 'step');
  assert.equal(state.flow.values.name, 'Terminal');
  assert.equal(state.query, 'Terminal');
});

test('step accept skips irrelevant steps and back returns to previous visible step', () => {
  const command = fakeCommand({
    args: [
      {
        kind: 'select',
        key: 'kind',
        label: 'Kind',
        options: () => [{ value: 'existing', label: 'Existing' }],
      },
      {
        kind: 'select',
        key: 'base',
        label: 'Base',
        skip: (_ctx, values) => values.kind === 'existing',
        options: () => [{ value: 'main', label: 'main' }],
      },
      { kind: 'text', key: 'title', label: 'Title' },
    ],
  });
  let state = paletteReducer(initialPaletteState, {
    type: 'autostart',
    entryId: 'fake',
    command,
    ctx,
    values: {},
  });

  assert.equal(state.kind, 'step');
  state = paletteReducer(state, {
    type: 'accept-value',
    command,
    ctx,
    value: 'existing',
    label: 'Existing',
  });

  assert.equal(state.kind, 'step');
  assert.equal(state.flow.stepIndex, 2);

  state = paletteReducer(state, { type: 'back', command, ctx });
  assert.equal(state.kind, 'step');
  assert.equal(state.flow.stepIndex, 0);
  assert.equal(state.flow.values.kind, undefined);
});

test('review cancel closes and null review runs the command once', () => {
  const command = fakeCommand({
    args: [{ kind: 'review', key: 'confirm', label: 'Confirm', load: () => null }],
  });
  let state = paletteReducer(initialPaletteState, {
    type: 'autostart',
    entryId: 'fake',
    command,
    ctx,
    values: {},
  });

  assert.equal(state.kind, 'step');
  assert.equal(state.effects.at(0)?.kind, 'loadReview');

  const reviewAttempt = state.effects.at(0)?.attemptId ?? 0;
  state = paletteReducer(state, {
    type: 'review-loaded',
    attemptId: reviewAttempt,
    command,
    ctx,
    content: null,
  });

  assert.equal(state.kind, 'step');
  assert.equal(state.runAttemptId, reviewAttempt + 1);
  assert.equal(state.effects.at(-1)?.kind, 'run');

  const cancelCommand = fakeCommand({
    args: [{ kind: 'review', key: 'confirm', label: 'Confirm', load: () => null }],
  });
  state = paletteReducer(initialPaletteState, {
    type: 'autostart',
    entryId: 'fake',
    command: cancelCommand,
    ctx,
    values: {},
  });
  state = paletteReducer(state, {
    type: 'accept-review-choice',
    command: cancelCommand,
    ctx,
    choice: { value: 'cancel', label: 'Cancel', intent: 'cancel' },
  });
  assert.equal(state.kind, 'closed');
});

test('null review advances to the next visible step before running', () => {
  const command = fakeCommand({
    args: [
      { kind: 'review', key: 'dirty', label: 'Dirty checkout', load: () => null },
      {
        kind: 'select',
        key: 'mode',
        label: 'Delete mode',
        options: () => [{ value: 'checkout-only', label: 'Checkout only' }],
      },
    ],
  });
  let state = paletteReducer(initialPaletteState, {
    type: 'autostart',
    entryId: 'delete-active-worktree',
    command,
    ctx,
    values: {},
  });

  assert.equal(state.kind, 'step');
  const reviewAttempt = state.effects.at(0)?.attemptId ?? 0;
  state = paletteReducer(state, {
    type: 'review-loaded',
    attemptId: reviewAttempt,
    command,
    ctx,
    content: null,
  });

  assert.equal(state.kind, 'step');
  assert.equal(state.flow.stepIndex, 1);
  assert.equal(state.stepData.kind, 'select');
  assert.equal(state.runAttemptId, null);
});

test('stale option loads are ignored', () => {
  const command = fakeCommand({
    args: [
      {
        kind: 'select',
        key: 'project',
        label: 'Project',
        options: () => [{ value: '1', label: 'One' }],
      },
    ],
  });
  let state = paletteReducer(initialPaletteState, {
    type: 'autostart',
    entryId: 'fake',
    command,
    ctx,
    values: {},
  });
  assert.equal(state.kind, 'step');
  const attemptId = state.stepData.kind === 'select' ? state.stepData.attemptId : 0;

  state = paletteReducer(state, {
    type: 'options-loaded',
    attemptId: attemptId + 1,
    options: [{ value: 'stale' }],
  });
  assert.equal(state.kind, 'step');
  assert.equal(state.stepData.kind, 'select');
  assert.deepEqual(state.stepData.options, []);

  state = paletteReducer(state, {
    type: 'options-loaded',
    attemptId,
    options: [{ value: '1', label: 'One' }],
  });
  assert.equal(state.kind, 'step');
  assert.equal(state.stepData.kind, 'select');
  assert.deepEqual(state.stepData.options, [{ value: '1', label: 'One' }]);
});

test('path queries keep previous suggestions while loading newer results', () => {
  const command = fakeCommand({
    args: [{ kind: 'path', key: 'path', label: 'Project path' }],
  });
  let state = paletteReducer(initialPaletteState, {
    type: 'autostart',
    entryId: 'fake',
    command,
    ctx,
    values: {},
  });

  assert.equal(state.kind, 'step');
  assert.equal(state.stepData.kind, 'path');
  assert.equal(state.stepData.loading, true);
  const firstAttempt = state.stepData.attemptId;

  state = paletteReducer(state, {
    type: 'paths-loaded',
    attemptId: firstAttempt,
    suggestions: [{ label: 'isagi', path: '/repo/isagi' }],
  });
  assert.equal(state.kind, 'step');
  assert.equal(state.stepData.kind, 'path');
  assert.equal(state.stepData.loading, false);
  assert.equal(state.stepData.suggestionsQuery, '');
  assert.deepEqual(state.stepData.suggestions, [{ label: 'isagi', path: '/repo/isagi' }]);

  state = paletteReducer(state, {
    type: 'query-changed',
    query: '/repo/i',
    spec: command.args?.[0],
  });
  assert.equal(state.kind, 'step');
  assert.equal(state.stepData.kind, 'path');
  assert.equal(state.stepData.loading, true);
  assert.equal(state.stepData.suggestionsQuery, '');
  assert.deepEqual(state.stepData.suggestions, [{ label: 'isagi', path: '/repo/isagi' }]);
  const secondAttempt = state.stepData.attemptId;

  state = paletteReducer(state, {
    type: 'paths-loaded',
    attemptId: firstAttempt,
    suggestions: [{ label: 'stale', path: '/repo/stale' }],
  });
  assert.equal(state.kind, 'step');
  assert.equal(state.stepData.kind, 'path');
  assert.deepEqual(state.stepData.suggestions, [{ label: 'isagi', path: '/repo/isagi' }]);

  state = paletteReducer(state, {
    type: 'paths-loaded',
    attemptId: secondAttempt,
    suggestions: [{ label: 'isagi-web', path: '/repo/isagi-web' }],
  });
  assert.equal(state.kind, 'step');
  assert.equal(state.stepData.kind, 'path');
  assert.equal(state.stepData.loading, false);
  assert.equal(state.stepData.suggestionsQuery, '/repo/i');
  assert.deepEqual(state.stepData.suggestions, [{ label: 'isagi-web', path: '/repo/isagi-web' }]);
});

test('run success closes or shows structured result/error outcomes', () => {
  let state = paletteReducer(initialPaletteState, { type: 'opened' });
  state = paletteReducer(state, { type: 'activate-entry', entry: fakeEntry(null), ctx });
  assert.equal(state.kind, 'search');
  const closeAttempt = state.runAttemptId ?? 0;

  state = paletteReducer(state, {
    type: 'run-succeeded',
    attemptId: closeAttempt,
    outcome: undefined,
  });
  assert.equal(state.kind, 'closed');

  state = paletteReducer(initialPaletteState, { type: 'opened' });
  state = paletteReducer(state, { type: 'activate-entry', entry: fakeEntry(null), ctx });
  const resultAttempt = state.kind === 'search' ? (state.runAttemptId ?? 0) : 0;
  state = paletteReducer(state, {
    type: 'run-succeeded',
    attemptId: resultAttempt,
    outcome: {
      kind: 'result',
      content: {
        tone: 'warning',
        title: 'Checkout deleted, branch preserved.',
        diagnostic: { label: 'git', detail: 'branch is not fully merged' },
      },
    },
  });
  assert.equal(state.kind, 'result');
  assert.equal(state.content.diagnostic?.detail, 'branch is not fully merged');

  state = paletteReducer(initialPaletteState, { type: 'opened' });
  state = paletteReducer(state, { type: 'activate-entry', entry: fakeEntry(null), ctx });
  const errorAttempt = state.kind === 'search' ? (state.runAttemptId ?? 0) : 0;
  state = paletteReducer(state, {
    type: 'run-succeeded',
    attemptId: errorAttempt,
    outcome: {
      kind: 'error',
      content: { title: 'Root worktree cannot be deleted.' },
    },
  });
  assert.equal(state.kind, 'error');
  assert.equal(state.content.title, 'Root worktree cannot be deleted.');
});

test('step flows can fail locally when their command entry disappears', () => {
  const command = fakeCommand({
    args: [{ kind: 'text', key: 'title', label: 'Title' }],
  });
  let state = paletteReducer(initialPaletteState, {
    type: 'autostart',
    entryId: 'fake',
    command,
    ctx,
    values: {},
  });

  assert.equal(state.kind, 'step');

  state = paletteReducer(state, {
    type: 'flow-failed',
    content: {
      title: 'Command is no longer available.',
      body: 'The workspace changed while the palette was open. Close this and try again.',
    },
  });

  assert.equal(state.kind, 'error');
  assert.equal(state.entryId, 'fake');
  assert.equal(state.content.title, 'Command is no longer available.');
});

test('entry-list flows can fail locally before entering a command step', () => {
  let state = paletteReducer(initialPaletteState, { type: 'opened' });

  state = paletteReducer(state, {
    type: 'flow-failed',
    entryId: 'workflow:launch-context-probe',
    content: {
      title: "Couldn't start workflow.",
      body: "Those answers didn't pass the workflow's checks.",
    },
  });

  assert.equal(state.kind, 'error');
  assert.equal(state.entryId, 'workflow:launch-context-probe');
  assert.equal(state.content.body, "Those answers didn't pass the workflow's checks.");
});

test('an error-detail entry opens an error outcome and closes on action or back', () => {
  const content = { title: 'Scan failed', body: 'unreadable path' };
  const entry: PaletteEntry = {
    id: 'workflow-failure',
    label: "Workflows couldn't be scanned.",
    icon: Plus,
    group: 'workflows',
    tone: 'error',
    run: () => ({ kind: 'error', content }),
  };

  let state = paletteReducer(initialPaletteState, { type: 'opened' });
  state = paletteReducer(state, { type: 'activate-entry', entry, ctx });

  // A command-less entry enqueues a run effect that will invoke entry.run().
  const runEffect = state.effects.at(-1);
  assert.equal(runEffect?.kind, 'run');
  const attemptId = runEffect?.kind === 'run' ? runEffect.attemptId : -1;

  state = paletteReducer(state, {
    type: 'run-succeeded',
    attemptId,
    outcome: { kind: 'error', content },
  });
  assert.equal(state.kind, 'error');
  assert.equal(state.kind === 'error' && state.content.title, 'Scan failed');

  assert.equal(paletteReducer(state, { type: 'outcome-action', value: 'close' }).kind, 'closed');
  assert.equal(paletteReducer(state, { type: 'back', ctx }).kind, 'closed');
});

function fakeCommand(overrides: Partial<PaletteCommand> = {}): PaletteCommand {
  return {
    id: 'fake-command',
    label: 'Fake command',
    icon: Plus,
    group: 'global',
    run: () => undefined,
    ...overrides,
  };
}

function fakeEntry(command: PaletteCommand | null): PaletteEntry {
  return {
    id: 'fake-entry',
    label: 'Fake entry',
    icon: Plus,
    group: 'global',
    ...(command ? { command } : {}),
    run: () => undefined,
  };
}
