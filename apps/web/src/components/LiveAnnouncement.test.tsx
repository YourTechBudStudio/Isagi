import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';

import { LiveAnnouncement } from './LiveAnnouncement.js';

const regions = (markup: string) =>
  Array.from(markup.matchAll(/<span aria-live="polite" class="sr-only">([^<]*)<\/span>/g)).map(
    (match) => match[1],
  );

describe('LiveAnnouncement', () => {
  it('says nothing before anything has been announced', () => {
    assert.deepEqual(
      regions(renderToStaticMarkup(<LiveAnnouncement announcement={{ message: '', seq: 0 }} />)),
      ['', ''],
    );
  });

  it('moves a repeated message between regions so the repeat is a real change', () => {
    // The reason this component exists. A single region holding `copied` and
    // then being set to `copied` again produces no DOM mutation, and the second
    // copy is announced to nobody — while the visible badge confirms it twice.
    const first = regions(
      renderToStaticMarkup(<LiveAnnouncement announcement={{ message: 'copied', seq: 1 }} />),
    );
    const second = regions(
      renderToStaticMarkup(<LiveAnnouncement announcement={{ message: 'copied', seq: 2 }} />),
    );

    assert.deepEqual(first, ['', 'copied']);
    assert.deepEqual(second, ['copied', '']);
    // Each region's own text changed, which is what a polite region reacts to.
    assert.notEqual(first[0], second[0]);
    assert.notEqual(first[1], second[1]);
  });

  it('speaks only the message, never the sequence that carried it', () => {
    const markup = renderToStaticMarkup(
      <LiveAnnouncement announcement={{ message: 'copy failed', seq: 7 }} />,
    );

    assert.match(markup, />copy failed</);
    assert.doesNotMatch(markup, /7/);
  });
});
