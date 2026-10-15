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

  const leading = (
    overrides: Partial<NonNullable<Parameters<typeof PaneActionCluster>[0]['leadingAction']>> = {},
  ) => ({
    label: 'Switch to Fluidcast',
    icon: <span data-icon="mic" />,
    pressed: false,
    pending: false,
    onClick: noop,
    ...overrides,
  });

  it('renders the leading action first, before the split buttons', () => {
    const markup = render({ ...base, leadingAction: leading() });
    const labels = [...markup.matchAll(/aria-label="([^"]+)"/g)].map((match) => match[1]);

    assert.deepEqual(labels, [
      'Switch to Fluidcast',
      'Split pane right',
      'Split pane down',
      'Delete pane',
    ]);
  });

  it('marks the leading action as a toggle and lights it while pressed', () => {
    const unpressed = render({ ...base, leadingAction: leading() });
    const pressed = render({ ...base, leadingAction: leading({ pressed: true }) });

    assert.match(unpressed, /aria-pressed="false"/);
    assert.doesNotMatch(unpressed, /border-blue\/30 bg-blue\/10 text-blue/);
    assert.match(pressed, /aria-pressed="true"/);
    assert.match(pressed, /border-blue\/30 bg-blue\/10 text-blue/);
    // Only the toggle carries a pressed state.
    assert.equal(pressed.match(/aria-pressed/g)?.length, 1);
  });

  it('pins visible, goes inert and sweeps neutrally while the leading action runs', () => {
    const markup = render({ ...base, leadingAction: leading({ pending: true }) });

    assert.match(markup, /opacity-100/);
    assert.equal(markup.match(/disabled=""/g)?.length, 4);
    assert.match(markup, /command-sweep command-sweep-pinned/);
    assert.doesNotMatch(markup, /command-sweep-danger/);
  });

  it('goes inert with the rest of the cluster while a delete runs', () => {
    const markup = render({ ...base, leadingAction: leading(), deletePending: true });

    assert.equal(markup.match(/disabled=""/g)?.length, 4);
    assert.match(markup, /command-sweep-danger/);
  });
});
