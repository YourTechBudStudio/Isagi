import assert from 'node:assert/strict';
import test from 'node:test';

import { Plus } from 'lucide-react';

import { initialPaletteState, paletteReducer, type PaletteState } from './machine.js';
import type { PaletteCommand, PaletteContext, PaletteEntry } from './types.js';

const ctx: PaletteContext = {
  projects: [],
  activeProject: null,
  activeWorktree: null,
  activeSurface: null,
  activePaneId: null,
  launchableHarnesses: [],
  editorAvailable: false,
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

/* ------------------------------------------------------------------ *
 * Story #39 — path interaction. The machine is the sole owner of the
 * highlight, and Enter's meaning is derived from it rather than stored.
 * ------------------------------------------------------------------ */

const pathCommand = fakeCommand({
  args: [{ kind: 'path', key: 'path', label: 'Project path' }],
});
const pathSpec = pathCommand.args?.[0];

/** A path step with `suggestions` loaded and settled against `query`. */
function pathStepAt(
  query: string,
  suggestions: readonly { label: string; path: string }[],
): PaletteState {
  let state = paletteReducer(initialPaletteState, {
    type: 'autostart',
    entryId: 'fake',
    command: pathCommand,
    ctx,
    values: {},
  });
  if (query !== '') {
    state = paletteReducer(state, { type: 'query-changed', query, spec: pathSpec });
  }
  assert.equal(state.kind, 'step');
  assert.equal(state.stepData.kind, 'path');
  state = paletteReducer(state, {
    type: 'paths-loaded',
    attemptId: state.stepData.attemptId,
    suggestions,
  });
  return drainEffects(state);
}

/** Consume every queued effect, as the component does after each render. */
function drainEffects(state: PaletteState): PaletteState {
  return paletteReducer(state, {
    type: 'effects-consumed',
    ids: state.effects.map((effect) => effect.id),
  });
}

function pathData(state: PaletteState) {
  assert.equal(state.kind, 'step');
  assert.equal(state.stepData.kind, 'path');
  if (state.kind !== 'step' || state.stepData.kind !== 'path') throw new Error('not a path step');
  return state.stepData;
}

const rows = [
  { label: 'isagi', path: '/repo/isagi' },
  { label: 'isagi-web', path: '/repo/isagi-web' },
];

test('path navigation moves the highlight and enqueues nothing', () => {
  let state = pathStepAt('/repo/', rows);
  assert.equal(pathData(state).highlightedIndex, null);

  state = paletteReducer(state, { type: 'path-navigate', delta: 1 });
  assert.equal(pathData(state).highlightedIndex, 0);
  assert.deepEqual(state.effects, []);
  assert.equal(state.kind === 'step' ? state.query : null, '/repo/');
  assert.equal(state.kind === 'step' ? state.runAttemptId : 'x', null);

  state = paletteReducer(state, { type: 'path-navigate', delta: 1 });
  assert.equal(pathData(state).highlightedIndex, 1);
  state = paletteReducer(state, { type: 'path-navigate', delta: 1 });
  assert.equal(pathData(state).highlightedIndex, 0, 'wraps forward');
  state = paletteReducer(state, { type: 'path-navigate', delta: -1 });
  assert.equal(pathData(state).highlightedIndex, 1, 'wraps backward');
  assert.deepEqual(state.effects, [], 'no navigation ever requested anything');
});

test('backward navigation from no highlight enters at the last row', () => {
  const state = paletteReducer(pathStepAt('/repo/', rows), { type: 'path-navigate', delta: -1 });
  assert.equal(pathData(state).highlightedIndex, 1);
});

test('a single-row list wraps onto itself and stays an explicit highlight', () => {
  let state = pathStepAt('/repo/', [rows[0]!]);
  state = paletteReducer(state, { type: 'path-navigate', delta: 1 });
  assert.equal(pathData(state).highlightedIndex, 0);
  // The move is a no-op, so the reducer returns the identical state rather than
  // re-rendering the panel — but the highlight stays set.
  const again = paletteReducer(state, { type: 'path-navigate', delta: 1 });
  assert.equal(again, state);
  assert.equal(pathData(again).highlightedIndex, 0);
});

test('navigation over a stale or empty list is inert', () => {
  let state = pathStepAt('/repo/', rows);
  state = paletteReducer(state, { type: 'query-changed', query: '/repo/is', spec: pathSpec });
  state = drainEffects(state);
  assert.equal(pathData(state).suggestionsQuery, '/repo/', 'rows are retained but stale');

  const navigated = paletteReducer(state, { type: 'path-navigate', delta: 1 });
  assert.equal(navigated, state);
  assert.equal(pathData(navigated).highlightedIndex, null);

  const empty = paletteReducer(pathStepAt('/repo/', []), { type: 'path-navigate', delta: 1 });
  assert.equal(pathData(empty).highlightedIndex, null);
});

test('consuming queued effects preserves an explicit highlight', () => {
  // Navigation enqueues nothing, so an `effects-consumed` event is not guaranteed
  // to arrive alongside it — but one from an earlier request may still land here.
  let state = pathStepAt('/repo/', rows);
  state = paletteReducer(state, { type: 'query-changed', query: '/repo/i', spec: pathSpec });
  state = paletteReducer(state, {
    type: 'paths-loaded',
    attemptId: pathData(state).attemptId,
    suggestions: rows,
  });
  state = paletteReducer(state, { type: 'path-navigate', delta: 1 });
  assert.equal(pathData(state).highlightedIndex, 0);

  state = drainEffects(state);
  assert.equal(pathData(state).highlightedIndex, 0, 'unrelated lifecycle events do not clear it');
});

test('a replacement result clears the highlight even at identical length', () => {
  let state = pathStepAt('/repo/', rows);
  state = paletteReducer(state, { type: 'path-navigate', delta: 1 });
  assert.equal(pathData(state).highlightedIndex, 0);

  state = paletteReducer(state, { type: 'query-changed', query: '/repo/i', spec: pathSpec });
  assert.equal(pathData(state).highlightedIndex, null, 'the edit already cleared it');
  state = paletteReducer(state, {
    type: 'paths-loaded',
    attemptId: pathData(state).attemptId,
    // Same row count, different directories: an index must never re-attach.
    suggestions: [
      { label: 'isagi', path: '/repo/isagi' },
      { label: 'isagi-docs', path: '/repo/isagi-docs' },
    ],
  });
  assert.equal(pathData(state).highlightedIndex, null);
});

test('a late result for a superseded attempt cannot disturb an active highlight', () => {
  let state = pathStepAt('/repo/', rows);
  state = paletteReducer(state, { type: 'query-changed', query: '/repo/i', spec: pathSpec });
  const liveAttempt = pathData(state).attemptId;
  state = paletteReducer(state, {
    type: 'paths-loaded',
    attemptId: liveAttempt,
    suggestions: rows,
  });
  state = drainEffects(state);
  state = paletteReducer(state, { type: 'path-navigate', delta: 1 });
  assert.equal(pathData(state).highlightedIndex, 0);

  const staleSuccess = paletteReducer(state, {
    type: 'paths-loaded',
    attemptId: liveAttempt - 1,
    suggestions: [{ label: 'gone', path: '/repo/gone' }],
  });
  assert.equal(staleSuccess, state);
  assert.equal(pathData(staleSuccess).highlightedIndex, 0);

  const staleFailure = paletteReducer(state, {
    type: 'paths-failed',
    attemptId: liveAttempt - 1,
    error: 'unreachable',
  });
  assert.equal(staleFailure, state);
  assert.equal(pathData(staleFailure).error, null);
});

test('a matching listing failure clears the highlight and keeps the buffer', () => {
  let state = pathStepAt('/repo/', rows);
  state = paletteReducer(state, { type: 'path-navigate', delta: 1 });
  state = paletteReducer(state, {
    type: 'paths-failed',
    attemptId: pathData(state).attemptId,
    error: 'unreachable',
  });
  assert.equal(pathData(state).highlightedIndex, null);
  assert.equal(pathData(state).error, 'unreachable');
  assert.equal(state.kind === 'step' ? state.query : null, '/repo/');
});

test('Enter over a highlight accepts it, requests children, and runs nothing', () => {
  let state = pathStepAt('/repo/', rows);
  state = paletteReducer(state, { type: 'path-navigate', delta: 1 });
  state = paletteReducer(state, { type: 'path-enter', command: pathCommand, ctx });

  assert.equal(state.kind === 'step' ? state.query : null, '/repo/isagi');
  assert.equal(pathData(state).highlightedIndex, null);
  assert.equal(state.kind === 'step' ? state.runAttemptId : 'x', null);
  assert.equal(state.effects.length, 1);
  assert.equal(state.effects[0]?.kind, 'suggestPaths');
  assert.equal(
    state.effects[0]?.kind === 'suggestPaths' ? state.effects[0].query : null,
    '/repo/isagi',
  );
  // Rows stay visible and stale under the new buffer, as an edit would leave them.
  assert.deepEqual(pathData(state).suggestions, rows);
  assert.equal(pathData(state).suggestionsQuery, '/repo/');
});

test('the next Enter submits the accepted path exactly once', () => {
  let state = pathStepAt('/repo/', rows);
  state = paletteReducer(state, { type: 'path-navigate', delta: 1 });
  state = drainEffects(paletteReducer(state, { type: 'path-enter', command: pathCommand, ctx }));

  state = paletteReducer(state, { type: 'path-enter', command: pathCommand, ctx });
  const runs = state.effects.filter((effect) => effect.kind === 'run');
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0]?.kind === 'run' ? runs[0].values : null, { path: '/repo/isagi' });
  assert.notEqual(state.kind === 'step' ? state.runAttemptId : null, null);
});

test('Enter over a highlight equal to the buffer accepts without a second request', () => {
  // Deliberately asymmetric with a click: navigating onto a row is still
  // browsing, so Enter fills first and the Enter after it submits.
  let state = pathStepAt('/repo/isagi', rows);
  state = paletteReducer(state, { type: 'path-navigate', delta: 1 });
  state = paletteReducer(state, { type: 'path-enter', command: pathCommand, ctx });

  assert.equal(pathData(state).highlightedIndex, null);
  assert.deepEqual(state.effects, [], 'no identical request is reissued');
  assert.equal(state.kind === 'step' ? state.runAttemptId : 'x', null);

  state = paletteReducer(state, { type: 'path-enter', command: pathCommand, ctx });
  assert.equal(state.effects.filter((effect) => effect.kind === 'run').length, 1);
});

test('navigating after an acceptance makes Enter accept again, even onto the same path', () => {
  let state = pathStepAt('/repo/', rows);
  state = paletteReducer(state, { type: 'path-navigate', delta: 1 });
  state = drainEffects(paletteReducer(state, { type: 'path-enter', command: pathCommand, ctx }));
  // Children arrive for the accepted folder, unhighlighted.
  state = paletteReducer(state, {
    type: 'paths-loaded',
    attemptId: pathData(state).attemptId,
    suggestions: [{ label: 'isagi', path: '/repo/isagi' }],
  });
  state = drainEffects(state);

  state = paletteReducer(state, { type: 'path-navigate', delta: 1 });
  state = paletteReducer(state, { type: 'path-enter', command: pathCommand, ctx });
  assert.equal(state.kind === 'step' ? state.runAttemptId : 'x', null, 'accepted, not submitted');
  assert.equal(state.effects.filter((effect) => effect.kind === 'run').length, 0);
});

test('editing after an acceptance retargets Enter at the typed value', () => {
  let state = pathStepAt('/repo/', rows);
  state = paletteReducer(state, { type: 'path-navigate', delta: 1 });
  state = drainEffects(paletteReducer(state, { type: 'path-enter', command: pathCommand, ctx }));

  state = paletteReducer(state, { type: 'query-changed', query: '/elsewhere', spec: pathSpec });
  state = drainEffects(state);
  state = paletteReducer(state, { type: 'path-enter', command: pathCommand, ctx });

  const runs = state.effects.filter((effect) => effect.kind === 'run');
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0]?.kind === 'run' ? runs[0].values : null, { path: '/elsewhere' });
});

test('a typed directory submits itself even once its children are listed', () => {
  // The AC7 defect this story removes: arriving children used to auto-highlight,
  // so Enter selected the first child instead of the folder that was typed.
  let state = pathStepAt('/repo/isagi/', [{ label: 'apps', path: '/repo/isagi/apps' }]);
  assert.equal(pathData(state).highlightedIndex, null);

  state = paletteReducer(state, { type: 'path-enter', command: pathCommand, ctx });
  const runs = state.effects.filter((effect) => effect.kind === 'run');
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0]?.kind === 'run' ? runs[0].values : null, { path: '/repo/isagi/' });
});

test('typed submission works while a listing is in flight or has failed', () => {
  for (const settle of ['loading', 'failed'] as const) {
    let state = pathStepAt('/repo/', rows);
    state = paletteReducer(state, { type: 'query-changed', query: '/repo/isagi', spec: pathSpec });
    if (settle === 'failed') {
      state = paletteReducer(state, {
        type: 'paths-failed',
        attemptId: pathData(state).attemptId,
        error: 'unreachable',
      });
    }
    state = drainEffects(state);

    state = paletteReducer(state, { type: 'path-enter', command: pathCommand, ctx });
    const runs = state.effects.filter((effect) => effect.kind === 'run');
    assert.equal(runs.length, 1, `${settle}: suggestions are advisory, not a gate`);
    assert.deepEqual(runs[0]?.kind === 'run' ? runs[0].values : null, { path: '/repo/isagi' });
  }
});

test('Enter on an empty buffer does nothing', () => {
  const state = pathStepAt('', []);
  const after = paletteReducer(state, { type: 'path-enter', command: pathCommand, ctx });
  assert.equal(after, state);
  assert.deepEqual(after.effects, []);
});

test('descent adopts the highlighted folder with exactly one separator', () => {
  let state = pathStepAt('/repo/', rows);
  state = paletteReducer(state, { type: 'path-navigate', delta: 1 });
  state = paletteReducer(state, { type: 'path-descend' });

  assert.equal(state.kind === 'step' ? state.query : null, '/repo/isagi/');
  assert.equal(pathData(state).highlightedIndex, null);
  assert.equal(state.effects.length, 1);
  assert.equal(
    state.effects[0]?.kind === 'suggestPaths' ? state.effects[0].query : null,
    '/repo/isagi/',
  );
});

test('descent onto a path the buffer already holds issues no second request', () => {
  // Root `/` and a buffer already typed with its trailing slash both land here;
  // the equality branch handles them without a root-specific rule.
  for (const [query, path] of [
    ['/', '/'],
    ['~/work/', '~/work'],
  ] as const) {
    let state = pathStepAt(query, [{ label: 'self', path }]);
    state = paletteReducer(state, { type: 'path-navigate', delta: 1 });
    state = paletteReducer(state, { type: 'path-descend' });

    assert.equal(state.kind === 'step' ? state.query : null, query);
    assert.equal(pathData(state).highlightedIndex, null);
    assert.deepEqual(state.effects, []);
  }
});

test('descent without a highlight is inert', () => {
  const state = pathStepAt('/repo/', rows);
  assert.equal(paletteReducer(state, { type: 'path-descend' }), state);
});

test('a click on a differing row accepts it; a click on an equal row submits', () => {
  let state = pathStepAt('/repo/', rows);
  const accepted = paletteReducer(state, {
    type: 'path-pick',
    index: 0,
    command: pathCommand,
    ctx,
  });
  assert.equal(accepted.kind === 'step' ? accepted.query : null, '/repo/isagi');
  assert.equal(accepted.effects.filter((effect) => effect.kind === 'run').length, 0);

  // No prior acceptance needed: equality is between path strings.
  state = pathStepAt('/repo/isagi', rows);
  const submitted = paletteReducer(state, {
    type: 'path-pick',
    index: 0,
    command: pathCommand,
    ctx,
  });
  const runs = submitted.effects.filter((effect) => effect.kind === 'run');
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0]?.kind === 'run' ? runs[0].values : null, { path: '/repo/isagi' });
});

test('clicks on stale and out-of-range rows do nothing', () => {
  let state = pathStepAt('/repo/', rows);
  state = drainEffects(
    paletteReducer(state, { type: 'query-changed', query: '/repo/i', spec: pathSpec }),
  );
  assert.equal(
    paletteReducer(state, { type: 'path-pick', index: 0, command: pathCommand, ctx }),
    state,
  );

  const fresh = pathStepAt('/repo/', rows);
  for (const index of [-1, 2]) {
    assert.equal(
      paletteReducer(fresh, { type: 'path-pick', index, command: pathCommand, ctx }),
      fresh,
    );
  }
});

test('a click ignores an unrelated highlight and acts on the clicked row', () => {
  let state = pathStepAt('/repo/', rows);
  state = paletteReducer(state, { type: 'path-navigate', delta: 1 });
  state = paletteReducer(state, { type: 'path-pick', index: 1, command: pathCommand, ctx });
  assert.equal(state.kind === 'step' ? state.query : null, '/repo/isagi-web');
  assert.equal(pathData(state).highlightedIndex, null);
});

test('acceptance that moves the buffer clears a previous submission rejection', () => {
  // The rejection described the path that was submitted; once a different path is
  // in the buffer it is describing something the user is no longer looking at.
  let state = pathStepAt('/repo/notes', rows);
  state = paletteReducer(state, { type: 'path-enter', command: pathCommand, ctx });
  const runAttempt = state.kind === 'step' ? state.runAttemptId : null;
  assert.notEqual(runAttempt, null);
  state = paletteReducer(state, {
    type: 'run-failed',
    attemptId: runAttempt!,
    error: 'Not a Git repository root',
  });
  state = drainEffects(state);
  assert.equal(state.kind === 'step' ? state.inlineError : null, 'Not a Git repository root');

  state = paletteReducer(state, { type: 'path-navigate', delta: 1 });
  assert.equal(
    state.kind === 'step' ? state.inlineError : null,
    'Not a Git repository root',
    'navigation alone changes nothing the rejection described',
  );

  state = paletteReducer(state, { type: 'path-enter', command: pathCommand, ctx });
  assert.equal(state.kind === 'step' ? state.query : null, '/repo/isagi');
  assert.equal(state.kind === 'step' ? state.inlineError : null, null);
});

test('acceptance of an equal path preserves both error channels', () => {
  // It starts no new request, so neither the listing error nor the rejection has
  // been superseded by anything.
  let state = pathStepAt('/repo/isagi', rows);
  state = paletteReducer(state, { type: 'path-enter', command: pathCommand, ctx });
  const runAttempt = state.kind === 'step' ? state.runAttemptId : null;
  state = paletteReducer(state, {
    type: 'run-failed',
    attemptId: runAttempt!,
    error: 'Not a Git repository root',
  });
  state = paletteReducer(state, {
    type: 'paths-failed',
    attemptId: pathData(state).attemptId,
    error: 'unreachable',
  });
  state = drainEffects(state);

  state = paletteReducer(state, { type: 'path-navigate', delta: 1 });
  assert.equal(pathData(state).highlightedIndex, null, 'a failed listing has no selectable rows');

  // Restore rows so an equal-path acceptance is reachable, then accept.
  state = paletteReducer(state, {
    type: 'paths-loaded',
    attemptId: pathData(state).attemptId,
    suggestions: rows,
  });
  state = paletteReducer(state, { type: 'path-navigate', delta: 1 });
  state = paletteReducer(state, { type: 'path-enter', command: pathCommand, ctx });
  assert.equal(state.kind === 'step' ? state.inlineError : null, 'Not a Git repository root');
});

test('acceptance that moves the buffer supersedes a listing error too', () => {
  let state = pathStepAt('/repo/', rows);
  state = paletteReducer(state, { type: 'path-navigate', delta: 1 });
  state = paletteReducer(state, { type: 'path-enter', command: pathCommand, ctx });
  assert.equal(pathData(state).error, null);
  assert.equal(pathData(state).loading, true);
});

test('every path action is inert while a command run holds the palette', () => {
  let state = pathStepAt('/repo/', rows);
  state = paletteReducer(state, { type: 'path-navigate', delta: 1 });
  state = drainEffects(state);
  const highlighted = state;
  state = paletteReducer(state, { type: 'path-enter', command: pathCommand, ctx });
  state = paletteReducer(state, { type: 'path-enter', command: pathCommand, ctx });
  state = drainEffects(state);
  assert.notEqual(state.kind === 'step' ? state.runAttemptId : null, null, 'busy');

  for (const event of [
    { type: 'path-navigate', delta: 1 },
    { type: 'path-descend' },
    { type: 'path-enter', command: pathCommand, ctx },
    { type: 'path-pick', index: 0, command: pathCommand, ctx },
  ] as const) {
    assert.equal(paletteReducer(state, event), state, `${event.type} must not act while busy`);
  }
  assert.notEqual(highlighted, state);
});

test('leaving the path step discards its selection entirely', () => {
  let state = pathStepAt('/repo/', rows);
  state = paletteReducer(state, { type: 'path-navigate', delta: 1 });
  assert.equal(pathData(state).highlightedIndex, 0);

  // `back` out of the only argument rebuilds the palette as a search view; there
  // is no path state left to carry a highlight.
  const backed = paletteReducer(state, { type: 'back', command: pathCommand, ctx });
  assert.equal(backed.kind, 'search');
  // These two facts are what make the palette's composed snap key on return
  // identical to the one it held before the step was entered, which is why the
  // hook — having written nothing while the machine owned the highlight —
  // retains its previous numeric index instead of snapping. Recorded as a
  // deliberate, bounded consequence; the hook half is verified in the browser.
  assert.equal(backed.kind === 'search' ? backed.query : null, '');
  assert.equal(backed.kind === 'search' ? backed.viewKey : null, 'recent');

  // Re-entering builds a fresh step rather than restoring anything.
  const reentered = pathStepAt('/repo/', rows);
  assert.equal(pathData(reentered).highlightedIndex, null);
});

test('path actions are ignored outside a path step', () => {
  const search = paletteReducer(initialPaletteState, { type: 'opened' });
  assert.equal(paletteReducer(search, { type: 'path-navigate', delta: 1 }), search);
  assert.equal(paletteReducer(search, { type: 'path-enter', command: pathCommand, ctx }), search);
});
