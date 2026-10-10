/**
 * The app registry of a fixture page: one per page load, like `main.tsx` creates one per app
 * session. Each fixture app module calls this once at module level and provides the result with
 * `AppStateProvider`. Fake runtimes keep stubbing `window.fetch` / `window.isagi`, so the
 * production `RuntimeApi.layer` runs unchanged.
 */
import { connectBrowserRevalidation } from '../../../src/lib/state/policy.js';
import { makeAppRegistry, type AppRegistryOptions } from '../../../src/lib/state/registry.js';

export function createFixtureRegistry(options: AppRegistryOptions = {}) {
  const registry = makeAppRegistry(options);
  connectBrowserRevalidation(registry, window, () => document.visibilityState === 'visible');
  return registry;
}
