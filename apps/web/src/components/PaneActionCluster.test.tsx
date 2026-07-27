import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';

import { PaneActionCluster } from './PaneActionCluster.js';

const noop = () => undefined;

function render(props: Parameters<typeof PaneActionCluster>[0]) {
  return renderToStaticMarkup(<PaneActionCluster {...props} />);
}

const base = { onSplitRight: noop, onSplitDown: noop, onDelete: noop } as const;

describe('PaneActionCluster', () => {
  it('stays hidden and interactive at rest', () => {
    const markup = render({ ...base });

    assert.match(markup, /opacity-0/);
    assert.doesNotMatch(markup, /command-sweep/);
    assert.doesNotMatch(markup, /disabled=""/);
  });

  it('pins visible and sweeps when it owns the running delete', () => {
    const markup = render({ ...base, deletePending: true });

    // Hover-reveal would take the only running indicator off screen the moment
    // the pointer left the pane.
    assert.match(markup, /opacity-100/);
    assert.doesNotMatch(markup, /opacity-0/);
    assert.match(markup, /command-sweep command-sweep-danger/);
    assert.equal(markup.match(/disabled=""/g)?.length, 3);
  });

  it('goes inert without sweeping when the delete is owned elsewhere', () => {
    const markup = render({ ...base, disabled: true });

    // The context menu or the surface owns the indicator; this cluster is only
    // locked, so it must not draw a second one.
    assert.doesNotMatch(markup, /command-sweep/);
    assert.match(markup, /opacity-0/);
    assert.equal(markup.match(/disabled=""/g)?.length, 3);
  });
});
