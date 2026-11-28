import { Context, Effect, Layer } from 'effect';

import type { PtyProcessBackend } from '@isagi/shared/contracts';

import { RuntimeConfig, type RuntimeConfigPtyBackend } from '../runtime-config/index.js';
import { NodePtyBackend } from './adapters/node-pty.js';
import type { PtyBackendName, PtyBackend as PtyBackendShape } from './types.js';

// Config spells backends for humans, persistence spells them for rows. This map
// owns that vocabulary translation and nothing else, so a new config value
// cannot quietly resolve to node-pty.
const configuredBackendName = {
  'node-pty': 'node_pty',
} satisfies Record<RuntimeConfigPtyBackend, PtyBackendName>;

/**
 * A persisted backend value this runtime can no longer operate. A historical row may carry it, but no adapter exists
 * for it, so its process cannot be owned by this runtime.
 */
export const retiredBackend = Symbol('retired PTY backend');

/**
 * Every persisted backend value maps to a registered adapter or to the retired marker: an adapter name maps to its
 * adapter, and every other persisted value to `retiredBackend`. A new `PtyProcessBackend` value therefore fails to
 * compile until it is either registered or retired.
 */
export type PtyBackendRegistry = Readonly<
  Record<PtyBackendName, PtyBackendShape> &
    Record<Exclude<PtyProcessBackend, PtyBackendName>, typeof retiredBackend>
>;

/**
 * One registry is the sole routing and registration authority: resolution, retirement and enumeration cannot drift
 * apart. The adapters themselves are still constructed by their own Effect tags. Shared with the test catalog.
 */
export function backendRegistry(adapters: {
  readonly nodePty: PtyBackendShape;
}): PtyBackendRegistry {
  return {
    node_pty: adapters.nodePty,
    tmux: retiredBackend,
  };
}

const make = Effect.gen(function* () {
  const config = yield* RuntimeConfig;
  const currentConfig = yield* config.get;
  const nodePty = yield* NodePtyBackend;
  const backends = backendRegistry({ nodePty });

  const configured = backends[configuredBackendName[currentConfig.pty.backend]];
  yield* Effect.logInfo('PTY launch backend selected').pipe(
    Effect.annotateLogs({ backend: configured.name }),
  );

  return catalogFromRegistry(configured, backends);
});

export class PtyBackendCatalog extends Context.Service<
  PtyBackendCatalog,
  {
    // Launch preference. Process-scoped, read once at construction, and consulted
    // by nothing except the launch flow.
    readonly configured: PtyBackendShape;
    // Every operation on an existing PTY row resolves its adapter from the row's
    // persisted backend, never from the launch preference: a persisted incarnation
    // belongs to the transport that created it (ADR 0005). A retired or unknown
    // name is a defect, never a fallback.
    readonly forBackend: (name: PtyProcessBackend) => Effect.Effect<PtyBackendShape>;
    // Whether a persisted backend value is known but has no adapter. Only a
    // terminal row can legitimately carry one; a caller that must establish that
    // such a row's process is gone checks this before resolving an adapter.
    readonly isRetired: (name: PtyProcessBackend) => boolean;
    // Every registered adapter, for sweeps that must cover backend-only state that
    // has no persisted row to dispatch from. Order is incidental.
    readonly all: readonly PtyBackendShape[];
  }
>()('isagi/runtime/pty-processes/PtyBackendCatalog') {
  static readonly layerNoDeps = Layer.effect(PtyBackendCatalog, make);
  static readonly layer = PtyBackendCatalog.layerNoDeps.pipe(Layer.provide(NodePtyBackend.layer));
}

/**
 * The catalog over a registry. Shared with the test catalog so a fake can never be more permissive than production.
 */
export function catalogFromRegistry(
  configured: PtyBackendShape,
  backends: PtyBackendRegistry,
): PtyBackendCatalog['Service'] {
  return {
    configured,
    forBackend: (name) => resolveRegisteredBackend(backends, name),
    isRetired: (name) => Object.hasOwn(backends, name) && backends[name] === retiredBackend,
    all: Object.values(backends).filter(
      (backend): backend is PtyBackendShape => backend !== retiredBackend,
    ),
  };
}

/**
 * SQLite stores `backend` as bare text with no CHECK constraint, so an unknown value is out-of-model corruption — and
 * an inherited key like `toString` would otherwise resolve to something that is not an adapter at all. A retired value
 * names a transport this runtime has no adapter for, and only a terminal row may carry one, so reaching it here is
 * corruption too. Dying loudly is the only safe answer either way: falling back to the configured adapter would aim an
 * inspect or kill at the wrong process.
 */
function resolveRegisteredBackend(
  backends: PtyBackendRegistry,
  name: PtyProcessBackend,
): Effect.Effect<PtyBackendShape> {
  if (!Object.hasOwn(backends, name)) {
    return Effect.die(new Error(`Unknown persisted PTY backend ${String(name)}.`));
  }
  const backend = backends[name];
  return backend === retiredBackend
    ? Effect.die(new Error(`Persisted PTY backend ${name} is retired and has no adapter.`))
    : Effect.succeed(backend);
}
