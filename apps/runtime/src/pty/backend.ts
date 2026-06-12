import { Context, Effect, Layer } from 'effect';

import { NodePtyBackend } from './adapters/node-pty.js';
import { TmuxBackend } from './adapters/tmux.js';
import type { PtyBackend as PtyBackendShape } from './types.js';

export const PtyBackend = Context.GenericTag<PtyBackendShape>('isagi/PtyBackend');

export const PtyBackendLive = Layer.effect(
  PtyBackend,
  Effect.gen(function* () {
    const tmux = yield* TmuxBackend;
    const nodePty = yield* NodePtyBackend;
    const tmuxAvailable = yield* tmux.available;

    // Backend selection is process-scoped. A runtime process owns one PTY
    // backend family; if tmux degrades after startup, we surface that
    // degradation instead of mixing tmux and node-pty sessions.
    const backend = tmuxAvailable ? tmux : nodePty;
    console.info(`[runtime] PTY backend selected backend=${backend.name}`);
    return backend;
  }),
);
