import { Context, Effect, Layer } from 'effect';

import { RuntimeConfig, type RuntimeConfigPtyBackend } from '../runtime-config/index.js';
import { NodePtyBackend } from './adapters/node-pty.js';
import { TmuxBackend } from './adapters/tmux.js';
import type { PtyBackendName, PtyBackend as PtyBackendShape } from './types.js';

// Config spells backends for humans, persistence spells them for rows. This map
// owns that vocabulary translation and nothing else, so a new config value
// cannot quietly resolve to node-pty.
const configuredBackendName = {
  'node-pty': 'node_pty',
  tmux: 'tmux',
} satisfies Record<RuntimeConfigPtyBackend, PtyBackendName>;

export interface PtyBackendCatalogService {
  // Launch preference. Process-scoped, read once at construction, and consulted
  // by nothing except the launch flow.
  readonly configured: PtyBackendShape;
  // Every operation on an existing PTY row resolves its adapter from the row's
  // persisted backend, never from the launch preference: a persisted incarnation
  // belongs to the transport that created it (ADR 0005).
  readonly forBackend: (name: PtyBackendName) => PtyBackendShape;
  // Every registered adapter, for sweeps that must cover backend-only state that
  // has no persisted row to dispatch from. Order is incidental.
  readonly all: readonly PtyBackendShape[];
}

export const PtyBackendCatalog =
  Context.GenericTag<PtyBackendCatalogService>('isagi/PtyBackendCatalog');

export const PtyBackendCatalogLive = Layer.effect(
  PtyBackendCatalog,
  Effect.gen(function* () {
    const config = yield* RuntimeConfig;
    const currentConfig = yield* config.get;
    const tmux = yield* TmuxBackend;
    const nodePty = yield* NodePtyBackend;

    // One registry is the sole routing and registration authority: resolution
    // and enumeration cannot drift apart, and a new `PtyBackendName` fails to
    // compile here rather than silently becoming unroutable and uncollectable.
    // The adapters themselves are still constructed by their own Effect tags.
    const backends = {
      node_pty: nodePty,
      tmux,
    } satisfies Record<PtyBackendName, PtyBackendShape>;

    const configured = backends[configuredBackendName[currentConfig.pty.backend]];
    if (configured === tmux && !(yield* tmux.available)) {
      console.warn(
        '[runtime] Configured PTY backend tmux is unavailable; PTY launches may fail until tmux is installed or config.yaml selects node-pty.',
      );
    }
    console.info(`[runtime] PTY launch backend selected backend=${configured.name}`);

    return {
      configured,
      forBackend: (name) => {
        // SQLite stores `backend` as bare text with no CHECK constraint, so an
        // unknown value is out-of-model corruption — and an inherited key like
        // `toString` would otherwise resolve to something that is not an adapter
        // at all. Failing loudly is the only safe answer: falling back to the
        // configured adapter would aim an inspect or kill at the wrong process.
        if (!Object.hasOwn(backends, name)) {
          throw new Error(`Unknown persisted PTY backend ${String(name)}.`);
        }
        return backends[name];
      },
      all: Object.values(backends),
    } satisfies PtyBackendCatalogService;
  }),
);
