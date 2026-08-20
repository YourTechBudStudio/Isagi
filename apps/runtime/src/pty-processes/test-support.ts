import type { PtyBackendCatalogService } from './backend.js';
import type { PtyBackendName, PtyBackend as PtyBackendShape } from './types.js';

/**
 * Test-only catalog. Every field is explicit on purpose: a cross-backend test
 * has to state its launch preference and both registered adapters, so a test
 * can never silently pass because the helper defaulted the very thing under
 * test. The internal registry mirrors production, so a widened
 * `PtyBackendName` breaks here first and adding the required parameter then
 * forces every call site to state the new adapter too.
 */
export function fakeBackendCatalog(input: {
  readonly configured: PtyBackendName;
  readonly nodePty: PtyBackendShape;
  readonly tmux: PtyBackendShape;
}): PtyBackendCatalogService {
  const backends = {
    node_pty: input.nodePty,
    tmux: input.tmux,
  } satisfies Record<PtyBackendName, PtyBackendShape>;
  return {
    configured: backends[input.configured],
    forBackend: (name) => {
      if (!Object.hasOwn(backends, name)) {
        throw new Error(`Unknown persisted PTY backend ${String(name)}.`);
      }
      return backends[name];
    },
    all: Object.values(backends),
  };
}
