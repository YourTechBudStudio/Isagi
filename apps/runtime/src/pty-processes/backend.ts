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

const make = Effect.gen(function* () {
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
    yield* Effect.logWarning(
      'Configured PTY backend tmux is unavailable; PTY launches may fail until tmux is installed or config.yaml selects node-pty.',
    );
  }
  yield* Effect.logInfo('PTY launch backend selected').pipe(
    Effect.annotateLogs({ backend: configured.name }),
  );

  return PtyBackendCatalog.of({
    configured,
    forBackend: (name) => resolveRegisteredBackend(backends, name),
    all: Object.values(backends),
  });
});

export class PtyBackendCatalog extends Context.Service<
  PtyBackendCatalog,
  {
    // Launch preference. Process-scoped, read once at construction, and consulted
    // by nothing except the launch flow.
    readonly configured: PtyBackendShape;
    // Every operation on an existing PTY row resolves its adapter from the row's
    // persisted backend, never from the launch preference: a persisted incarnation
    // belongs to the transport that created it (ADR 0005). An unknown name is a
    // defect, never a fallback.
    readonly forBackend: (name: PtyBackendName) => Effect.Effect<PtyBackendShape>;
    // Every registered adapter, for sweeps that must cover backend-only state that
    // has no persisted row to dispatch from. Order is incidental.
    readonly all: readonly PtyBackendShape[];
  }
>()('isagi/runtime/pty-processes/PtyBackendCatalog') {
  static readonly layerNoDeps = Layer.effect(PtyBackendCatalog, make);
  static readonly layer = PtyBackendCatalog.layerNoDeps.pipe(
    Layer.provide([NodePtyBackend.layer, TmuxBackend.layer]),
  );
}

/**
 * SQLite stores `backend` as bare text with no CHECK constraint, so an unknown value is out-of-model corruption — and
 * an inherited key like `toString` would otherwise resolve to something that is not an adapter at all. Dying loudly is
 * the only safe answer: falling back to the configured adapter would aim an inspect or kill at the wrong process.
 * Shared with the test catalog so a fake can never be more permissive than production.
 */
export function resolveRegisteredBackend(
  backends: Readonly<Record<PtyBackendName, PtyBackendShape>>,
  name: PtyBackendName,
): Effect.Effect<PtyBackendShape> {
  return Object.hasOwn(backends, name)
    ? Effect.succeed(backends[name])
    : Effect.die(new Error(`Unknown persisted PTY backend ${String(name)}.`));
}
