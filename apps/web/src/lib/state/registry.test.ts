// One registry per app session, shared by React and non-React callers.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RegistryContext } from '@effect/atom-react';
import { Effect } from 'effect';
import { AtomRegistry } from 'effect/reactivity';
import { createElement, useContext } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { AppStateProvider } from './AppStateProvider.js';
import { makeAppRegistry, useRegistry } from './registry.js';
import { runApp } from './runtime.js';

test('React and non-React callers read the same registry instance', async (t) => {
  const registry = makeAppRegistry();
  t.after(() => registry.dispose());
  const seen: { app?: AtomRegistry.AtomRegistry; atomReact?: AtomRegistry.AtomRegistry } = {};
  function Probe() {
    seen.app = useRegistry();
    seen.atomReact = useContext(RegistryContext);
    return null;
  }

  renderToStaticMarkup(createElement(AppStateProvider, { registry }, createElement(Probe)));
  const fromEffect = await runApp(registry, Effect.service(AtomRegistry.AtomRegistry));

  assert.equal(seen.app, registry, 'our hooks');
  assert.equal(seen.atomReact, registry, "atom-react's hooks");
  assert.equal(fromEffect, registry, 'Effect code run at an imperative edge');
});

test('useRegistry throws outside AppStateProvider instead of using a default registry', () => {
  function Probe() {
    useRegistry();
    return null;
  }
  assert.throws(() => renderToStaticMarkup(createElement(Probe)), /AppStateProvider is missing/);
});
