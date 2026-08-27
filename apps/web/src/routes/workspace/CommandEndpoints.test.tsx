import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';

import type { CommandPort, CommandSummary } from '@isagi/contracts';

import type { RuntimeLocality } from '../../lib/runtime/locality.js';
import { CommandEndpoints } from './CommandEndpoints.js';

function port(
  value: number,
  paths: readonly (readonly [string, string])[] = [],
  envVar: string | null = null,
): CommandPort {
  return {
    port: value,
    envVar,
    urls: paths.map(([label, path]) => ({
      label,
      path,
      url: `http://localhost:${value}${path}`,
    })),
  };
}

const API = port(
  51824,
  [
    ['docs', '/docs'],
    ['health', '/healthz'],
  ],
  'API_PORT',
);
const INSPECTOR = port(9229);

function render(ports: CommandSummary['ports'], locality: RuntimeLocality) {
  return renderToStaticMarkup(
    <CommandEndpoints commandName="api" ports={ports} locality={locality} />,
  );
}

/**
 * These cover the **closed** toggle, which is the only state a production mount
 * reaches without interaction — and the state the whole design turns on, because
 * closed-by-default is what makes the toggle's wording and tone load-bearing.
 * Opening, copying, and dismissal need a real DOM and are covered by the
 * Playwright fixture instead.
 */
describe('CommandEndpoints', () => {
  it('renders nothing at all when the command declared no ports', () => {
    // `[]` is authoritative, not degraded. There is nothing to say, so the
    // header keeps exactly the shape every other command has.
    assert.equal(render([], 'local'), '');
    assert.equal(render([], 'non_local'), '');
  });

  it('counts URLs quietly when they can actually be offered', () => {
    const markup = render([API, INSPECTOR], 'local');

    assert.match(markup, />2 urls</);
    assert.match(markup, /text-cyan/);
    assert.doesNotMatch(markup, /text-amber/);
    assert.match(markup, /aria-expanded="false"/);
  });

  it('goes amber and stops counting URLs it is withholding', () => {
    const markup = render([API, INSPECTOR], 'non_local');

    // The strip renders no URL badges when the runtime is not local, so this
    // popover is the only channel left — a quiet closed toggle would hide the
    // one thing that needed to be seen.
    assert.match(markup, />2 ports · no urls</);
    assert.match(markup, /text-amber/);
  });

  it('stays quiet for an all-pathless set, which withholds nothing', () => {
    const markup = render([INSPECTOR], 'non_local');

    assert.match(markup, />1 port</);
    assert.doesNotMatch(markup, /no urls/);
    assert.doesNotMatch(markup, /text-amber/);
  });

  it('voices degraded metadata rather than looking like a command with no ports', () => {
    const markup = render(null, 'local');

    assert.match(markup, />ports unknown</);
    assert.match(markup, /text-amber/);
  });

  it('keeps the panel closed and its content out of the tree until asked', () => {
    const markup = render([API], 'local');

    // Closed by default, every time: no open-state memory, and no URL text in
    // the header before the user asks for it.
    assert.doesNotMatch(markup, /http:\/\/localhost/);
    assert.match(markup, /aria-controls="/);
  });

  it('carries a live region that is not inside the popover', () => {
    // A confirmed copy dismisses the popover, so a region living inside it would
    // be announcing against its own teardown.
    assert.match(render([API], 'local'), /aria-live="polite"/);
  });
});
