import assert from 'node:assert/strict';
import test from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';

import { paletteCopy } from '../../copy/index.js';
import { OutcomePanel } from './CommandPaletteViews.js';

/**
 * What an outcome panel shows, given content.
 *
 * The panel is generic chrome: it renders sentences somebody else formed. These pin the two things
 * a caller relies on — that a body written as paragraphs is shown as paragraphs, and that the
 * actions it offers are the actions it gets back when one is chosen.
 */

test('a multi-line body reads as paragraphs rather than one run-on line', () => {
  const markup = renderToStaticMarkup(
    <OutcomePanel
      kind="error"
      content={{
        title: "Couldn't prepare the environment.",
        body: 'First thing.\n\nSecond thing.',
      }}
      onAction={() => {}}
    />,
  );

  assert.match(markup, /whitespace-pre-line/);
  assert.ok(markup.includes('First thing.'));
  assert.ok(markup.includes('Second thing.'));
});

test('an outcome with no actions still offers Close', () => {
  const markup = renderToStaticMarkup(
    <OutcomePanel
      kind="result"
      content={{ tone: 'warning', title: 'Stopped.' }}
      onAction={() => {}}
    />,
  );

  assert.ok(markup.includes(paletteCopy.outcome.close));
});

test('a primary action is drawn as the primary one, in the order it was given', () => {
  const markup = renderToStaticMarkup(
    <OutcomePanel
      kind="error"
      content={{
        title: 'Broke.',
        actions: [
          { value: 'retry', label: 'Retry', intent: 'primary', run: () => undefined },
          { value: 'close', label: 'Close' },
        ],
      }}
      onAction={() => {}}
    />,
  );

  // Retry leads because it is what the person most likely wants; Close is the quiet way out.
  assert.ok(markup.indexOf('Retry') < markup.indexOf('Close'));
  assert.match(markup, /Retry/);
  assert.notEqual(
    outcomeButtonClass(markup, 'Retry'),
    outcomeButtonClass(markup, 'Close'),
    'a primary action should not be drawn identically to a default one',
  );
});

/** The class list of the button carrying `label`, for comparing how two actions are drawn. */
function outcomeButtonClass(markup: string, label: string): string {
  const end = markup.indexOf(`>${label}</button>`);
  const start = markup.lastIndexOf('<button', end);
  return markup.slice(start, end);
}
