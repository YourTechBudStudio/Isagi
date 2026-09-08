import assert from 'node:assert/strict';
import test from 'node:test';

import {
  highlightedPathSuggestion,
  movedPathHighlight,
  nextPathIntent,
  pathBufferValue,
  pathPickIntent,
  pathSuggestionsAreStale,
  selectablePathSuggestions,
  withPathSeparator,
  type PathIntent,
  type PathStepView,
  type PathSuggestionLike,
} from './path-step.js';

function suggestion(path: string, hidden = false): PathSuggestionLike {
  return { label: path.split('/').filter(Boolean).at(-1) ?? path, path, hidden };
}

/** A path step whose result was fetched for `suggestionsQuery` (defaulting to a fresh one). */
function view({
  query,
  paths = [],
  suggestionsQuery = query,
  highlightedIndex = null,
}: {
  readonly query: string;
  readonly paths?: readonly string[];
  readonly suggestionsQuery?: string;
  readonly highlightedIndex?: number | null;
}): PathStepView {
  return {
    query,
    stepData: {
      kind: 'path',
      suggestions: paths.map((path) => suggestion(path)),
      suggestionsQuery,
      loading: false,
      error: null,
      attemptId: 1,
      highlightedIndex,
    },
  };
}

const THREE = ['~/work/alpha', '~/work/beta', '~/work/gamma'] as const;

test('pathBufferValue is the trimmed buffer the user sees and submits', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['~/work', '~/work'],
    ['  ~/work  ', '~/work'],
    ['~/work ', '~/work'],
    ['   ', ''],
    ['', ''],
  ];
  for (const [query, expected] of cases) {
    assert.equal(pathBufferValue(query), expected, query);
  }
});

test('staleness compares the raw query the request was issued under', () => {
  assert.equal(pathSuggestionsAreStale(view({ query: '~/work', paths: THREE })), false);
  assert.equal(
    pathSuggestionsAreStale(view({ query: '~/wor', paths: THREE, suggestionsQuery: '~/work' })),
    true,
  );
  // Trimming is a display/submission rule, not a freshness one: a trailing space is
  // a different raw query, and results for it are fresh only under that exact query.
  assert.equal(
    pathSuggestionsAreStale(view({ query: '~/work ', paths: THREE, suggestionsQuery: '~/work' })),
    true,
  );
  assert.equal(pathSuggestionsAreStale(view({ query: '~/work ', paths: THREE })), false);
});

test('stale rows are visible but never selectable', () => {
  assert.deepEqual(selectablePathSuggestions(view({ query: '~/work', paths: THREE })).length, 3);
  assert.deepEqual(
    selectablePathSuggestions(view({ query: '~/wor', paths: THREE, suggestionsQuery: '~/work' })),
    [],
  );
});

test('hidden rows stay selectable — the runtime owns hidden-name eligibility', () => {
  const hiddenView: PathStepView = {
    query: '~/',
    stepData: {
      kind: 'path',
      suggestions: [suggestion('~/.config', true)],
      suggestionsQuery: '~/',
      loading: false,
      error: null,
      attemptId: 1,
      highlightedIndex: 0,
    },
  };
  assert.equal(selectablePathSuggestions(hiddenView).length, 1);
  assert.equal(highlightedPathSuggestion(hiddenView)?.path, '~/.config');
});

test('a highlight resolves only when it is explicit, fresh, and in range', () => {
  assert.equal(highlightedPathSuggestion(view({ query: '~/work', paths: THREE })), null);
  assert.equal(
    highlightedPathSuggestion(view({ query: '~/work', paths: THREE, highlightedIndex: 1 }))?.path,
    '~/work/beta',
  );
  // Defensive: the reducer clears the highlight whenever query or result changes.
  assert.equal(
    highlightedPathSuggestion(view({ query: '~/work', paths: THREE, highlightedIndex: 7 })),
    null,
  );
  assert.equal(
    highlightedPathSuggestion(
      view({ query: '~/wor', paths: THREE, suggestionsQuery: '~/work', highlightedIndex: 1 }),
    ),
    null,
  );
});

test('navigation enters, cycles, and wraps in both directions', () => {
  const cases: readonly (readonly [number | null, number, number | null])[] = [
    [null, 1, 0], // forward from nothing enters at the first row
    [null, -1, 2], // backward from nothing enters at the last row
    [0, 1, 1],
    [2, 1, 0], // wraps forward
    [0, -1, 2], // wraps backward
  ];
  for (const [highlightedIndex, delta, expected] of cases) {
    assert.equal(
      movedPathHighlight(view({ query: '~/work', paths: THREE, highlightedIndex }), delta),
      expected,
      `${String(highlightedIndex)} ${delta}`,
    );
  }
});

test('a single row wraps onto itself and stays an explicit highlight', () => {
  const single = view({ query: '~/w', paths: ['~/work'], highlightedIndex: 0 });
  assert.equal(movedPathHighlight(single, 1), 0);
  assert.equal(movedPathHighlight(single, -1), 0);
  assert.equal(nextPathIntent(single).kind, 'accept');
});

test('navigation over an empty or stale list is inert', () => {
  assert.equal(movedPathHighlight(view({ query: '~/nope' }), 1), null);
  assert.equal(
    movedPathHighlight(
      view({ query: '~/wor', paths: THREE, suggestionsQuery: '~/work', highlightedIndex: 1 }),
      1,
    ),
    null,
  );
});

test('Enter accepts a resolved highlight, otherwise submits the visible buffer', () => {
  const cases: readonly (readonly [string, PathStepView, PathIntent])[] = [
    [
      'resolved highlight accepts',
      view({ query: '~/work', paths: THREE, highlightedIndex: 1 }),
      { kind: 'accept', path: '~/work/beta' },
    ],
    [
      // Deliberate navigation is the intent, not the string difference.
      'a highlight equal to the buffer still accepts',
      view({ query: '~/work/beta', paths: THREE, highlightedIndex: 1 }),
      { kind: 'accept', path: '~/work/beta' },
    ],
    [
      'no highlight submits the typed buffer',
      view({ query: '~/work/projects/Isagi', paths: THREE }),
      { kind: 'submit', value: '~/work/projects/Isagi' },
    ],
    [
      'a trailing-separator buffer submits itself, not a child',
      view({ query: '~/work/', paths: THREE }),
      { kind: 'submit', value: '~/work/' },
    ],
    [
      'whitespace is trimmed out of the submitted value',
      view({ query: '  ~/work  ', paths: THREE }),
      { kind: 'submit', value: '~/work' },
    ],
    [
      'a stale result leaves typed submission available',
      view({ query: '~/wor', paths: THREE, suggestionsQuery: '~/work', highlightedIndex: 1 }),
      { kind: 'submit', value: '~/wor' },
    ],
    [
      // Same resolved-highlight absence as a stale result: submit the current buffer,
      // never the unresolvable row.
      'an out-of-range highlight submits the current buffer',
      view({ query: '~/work', paths: THREE, highlightedIndex: 7 }),
      { kind: 'submit', value: '~/work' },
    ],
    ['an empty buffer does nothing', view({ query: '   ' }), { kind: 'none' }],
    [
      'an empty buffer with an unresolvable highlight does nothing',
      view({ query: '', highlightedIndex: 0 }),
      { kind: 'none' },
    ],
  ];
  for (const [name, current, expected] of cases) {
    assert.deepEqual(nextPathIntent(current), expected, name);
  }
});

test('a click submits an equal row and accepts a differing one', () => {
  const cases: readonly (readonly [string, PathStepView, number, PathIntent])[] = [
    [
      'a differing row fills the buffer',
      view({ query: '~/work', paths: THREE }),
      2,
      { kind: 'accept', path: '~/work/gamma' },
    ],
    [
      // Deliberately unlike Enter over an equal highlight, which accepts first.
      'a row equal to the buffer submits immediately',
      view({ query: '~/work/beta', paths: THREE }),
      1,
      { kind: 'submit', value: '~/work/beta' },
    ],
    [
      'equality ignores an unrelated highlight',
      view({ query: '~/work/beta', paths: THREE, highlightedIndex: 0 }),
      1,
      { kind: 'submit', value: '~/work/beta' },
    ],
    [
      'equality uses the trimmed buffer while freshness uses the raw query',
      view({ query: '~/work/beta ', paths: THREE }),
      1,
      { kind: 'submit', value: '~/work/beta' },
    ],
    [
      'a stale row does nothing',
      view({ query: '~/wor', paths: THREE, suggestionsQuery: '~/work' }),
      1,
      { kind: 'none' },
    ],
    [
      'an out-of-range row does nothing',
      view({ query: '~/work', paths: THREE }),
      7,
      { kind: 'none' },
    ],
    [
      'a negative index does nothing',
      view({ query: '~/work', paths: THREE }),
      -1,
      { kind: 'none' },
    ],
  ];
  for (const [name, current, index, expected] of cases) {
    assert.deepEqual(pathPickIntent(current, index), expected, name);
  }
});

test('descent appends exactly one separator', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['~/work', '~/work/'],
    ['~/work/', '~/work/'],
    ['/', '/'],
    ['/Volumes/data', '/Volumes/data/'],
    // Total by the append rule; the helper validates nothing.
    ['', '/'],
  ];
  for (const [path, expected] of cases) {
    assert.equal(withPathSeparator(path), expected, path);
  }
});
