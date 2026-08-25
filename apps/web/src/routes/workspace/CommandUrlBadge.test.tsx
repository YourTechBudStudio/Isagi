import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';

import { CommandUrlBadge } from './CommandUrlBadge.js';
import { ResolvedPortBadge } from './ResolvedPortBadge.js';

const noop = () => undefined;

function badge(presentation: 'compact' | 'url') {
  return renderToStaticMarkup(
    <CommandUrlBadge
      port={51824}
      label="docs"
      url="http://localhost:51824/docs"
      presentation={presentation}
      state="idle"
      onCopy={noop}
    />,
  );
}

describe('CommandUrlBadge', () => {
  it('anchors the compact badge on its resolved port', () => {
    const markup = badge('compact');

    // Direction B: the port is the fact the user did not choose for an allocated
    // entry, so it rides in front of the label instead of being drawer-only.
    assert.match(markup, /:51824/);
    assert.match(markup, /<\/span> docs<\/span>/);
    assert.match(markup, /aria-label="Copy http:\/\/localhost:51824\/docs"/);
  });

  it('renders every state string from first paint so feedback cannot move the badge', () => {
    const markup = badge('compact');

    // All three participate in layout; only visibility differs. Without this a
    // click would reflow the badge that was just clicked and shift the strip's
    // scroll position out from under the pointer.
    assert.match(markup, />copied</);
    assert.match(markup, />copy failed</);
    assert.equal(markup.match(/col-start-1 row-start-1/g)?.length, 3);
    assert.equal(markup.match(/invisible/g)?.length, 2);
  });

  it('keeps the complete URL visible and reserves a trailing feedback slot', () => {
    const markup = badge('url');

    // The visible URL *is* the acceptance criterion, so feedback lives in its own
    // slot rather than replacing the text.
    assert.match(markup, />http:\/\/localhost:51824\/docs</);
    // `wrap-anywhere`, not `break-all`. Both allow a long URL to wrap rather than
    // truncate, but `break-all` breaks eagerly mid-token even when the URL would
    // have fit on the next line — which it did, because the reserved feedback
    // slot shares the row.
    assert.match(markup, /wrap-anywhere/);
    assert.doesNotMatch(markup, /break-all/);
    assert.match(markup, /· copied/);
    assert.match(markup, /· copy failed/);
    // Both markers are stacked and hidden; the URL itself is never hidden.
    assert.equal(markup.match(/invisible/g)?.length, 2);
  });

  it('is a real button in both presentations', () => {
    // Keyboard activation and native scroll-into-view on focus both depend on
    // this being an ordinary button rather than a click-handling span.
    for (const presentation of ['compact', 'url'] as const) {
      assert.match(badge(presentation), /<button type="button"/);
    }
  });
});

describe('ResolvedPortBadge', () => {
  it('reads as a fact, not a control', () => {
    const markup = renderToStaticMarkup(<ResolvedPortBadge port={9229} />);

    // One visual rule holds across the feature: a bordered pill is interactive,
    // borderless text is a fact. Choosing port-anchored URL badges made the two
    // near-identical, so the border now carries the affordance.
    assert.match(markup, /:9229/);
    assert.doesNotMatch(markup, /<button/);
    assert.doesNotMatch(markup, /border/);
    assert.doesNotMatch(markup, /title=/);
  });
});
