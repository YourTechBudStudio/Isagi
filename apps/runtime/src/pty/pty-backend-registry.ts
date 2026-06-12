import { Context, Effect, Layer } from 'effect';

import { NodePtyBackend } from './node-pty.adapter.js';
import { TmuxBackend } from './tmux.adapter.js';
import type { PtyBackendName, PtyBackendRegistry as PtyBackendRegistryShape } from './types.js';
import { UnsupportedPtyBackendError } from './types.js';

export const PtyBackendRegistry = Context.GenericTag<PtyBackendRegistryShape>(
  'isagi/PtyBackendRegistry',
);

export const PtyBackendRegistryLive = Layer.effect(
  PtyBackendRegistry,
  Effect.gen(function* () {
    const tmux = yield* TmuxBackend;
    const nodePty = yield* NodePtyBackend;

    return {
      selectForLaunch: () =>
        tmux.available.pipe(Effect.map((available) => (available ? tmux : nodePty))),
      get: (name: PtyBackendName) => {
        switch (name) {
          case 'tmux':
            return Effect.succeed(tmux);
          case 'node_pty':
            return Effect.succeed(nodePty);
          default:
            return Effect.fail(new UnsupportedPtyBackendError({ backend: name }));
        }
      },
    } satisfies PtyBackendRegistryShape;
  }),
);
