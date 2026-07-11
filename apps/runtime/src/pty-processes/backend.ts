import { Context, Effect, Layer } from 'effect';

import { RuntimeConfig } from '../runtime-config/index.js';
import { NodePtyBackend } from './adapters/node-pty.js';
import { TmuxBackend } from './adapters/tmux.js';
import type { PtyBackend as PtyBackendShape } from './types.js';

export const PtyBackend = Context.GenericTag<PtyBackendShape>('isagi/PtyBackend');

export const PtyBackendLive = Layer.effect(
  PtyBackend,
  Effect.gen(function* () {
    const config = yield* RuntimeConfig;
    const currentConfig = yield* config.get;
    const tmux = yield* TmuxBackend;
    const nodePty = yield* NodePtyBackend;

    // Backend selection is process-scoped. A runtime process owns one configured
    // PTY backend family; if that backend degrades after startup, we surface the
    // degradation instead of mixing tmux and node-pty backends.
    const backend = currentConfig.pty.backend === 'tmux' ? tmux : nodePty;
    if (backend === tmux && !(yield* tmux.available)) {
      console.warn(
        '[runtime] Configured PTY backend tmux is unavailable; PTY launches may fail until tmux is installed or config.yaml selects node-pty.',
      );
    }
    console.info(`[runtime] PTY backend selected backend=${backend.name}`);
    return backend;
  }),
);
