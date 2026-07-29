import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';

import { ptyCopy } from '../../../copy/index.js';
import { DURATION } from '../../../lib/motion.js';
import { terminalRevealTransition } from './revealMotion.js';
import { TerminalRevealSlot } from './TerminalRevealSlot.js';

const covered = () => renderToStaticMarkup(<TerminalRevealSlot revealed={false} />);

const revealed = () => renderToStaticMarkup(<TerminalRevealSlot revealed />);

describe('TerminalRevealSlot', () => {
  it('covers the terminal opaquely and holds the host inert while unrevealed', () => {
    const markup = covered();

    assert.match(markup, /data-terminal-cover/);
    // Opaque terminal surface, not a translucent scrim: no history leaks through.
    assert.match(markup, /class="[^"]*bg-terminal-surface[^"]*"/);
    assert.match(markup, /data-terminal-host[^>]*inert/);
    assert.match(markup, /opacity-0/);
  });

  it('wears the shell running state rather than a terminal-only invention', () => {
    const markup = covered();

    // Same activity hairline as the palette, context menu, and action cluster —
    // pinned to the top edge so it cannot be confused with the delete sweep the
    // action cluster pins to the bottom.
    assert.match(markup, /command-sweep command-sweep-pinned-top/);
    // Never the destructive tone: this is a restore, not a deletion.
    assert.doesNotMatch(markup, /command-sweep-danger/);
    // And the palette's breathing working-dot beside the status line.
    assert.match(markup, /bg-working[^"]*animate-breathe/);
  });

  it('announces the wait once from a stable live region, not from the cover', () => {
    // The live region exists in both states; only its content changes, so the
    // announcement fires on the change rather than on region insertion.
    assert.match(covered(), /role="status"[^>]*class="sr-only"/);
    assert.match(revealed(), /role="status"[^>]*class="sr-only"/);
    assert.match(covered(), new RegExp(ptyCopy.reconstructing));
    // The visible cover is decorative — the live region owns the wording.
    assert.match(covered(), /aria-hidden="true" data-terminal-cover/);
    // Nothing announces once the terminal is its own accessible surface again.
    assert.equal(revealed().match(new RegExp(ptyCopy.reconstructing, 'g')), null);
  });

  it('drops the cover and un-inerts the host once revealed', () => {
    const markup = revealed();

    assert.doesNotMatch(markup, /data-terminal-cover|command-sweep/);
    assert.doesNotMatch(markup, /inert/);
  });

  it('is not focusable and blocks pointer input while covered', () => {
    const markup = covered();

    assert.doesNotMatch(markup, /tabindex/i);
    // The cover must not opt out of pointer events; a click may not reach a
    // terminal the user cannot see.
    assert.doesNotMatch(markup, /data-terminal-cover[^>]*pointer-events-none/);
  });

  it('exposes the settled reduced-motion transition contract', () => {
    assert.deepEqual(terminalRevealTransition(true), { duration: 0 });
    assert.equal(terminalRevealTransition(false).duration, DURATION.ui);
  });

  it('carries the CSS reduced-motion escape hatch', () => {
    assert.match(covered(), /motion-reduce:animate-none/);
  });
});
