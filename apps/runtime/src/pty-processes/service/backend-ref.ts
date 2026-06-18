import { join } from 'node:path';

import { Effect, Schema } from 'effect';

import type { PtyProcessRecord } from '../../surfaces/index.js';
import { PtyServiceError, type BackendSessionRef, type PtyBackend } from '../types.js';

const nodePtyBackendRefSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  backend: Schema.Literal('node_pty'),
  ptyProcessId: Schema.Number.pipe(Schema.int(), Schema.positive()),
  pid: Schema.NullOr(Schema.Number.pipe(Schema.int())),
});

const tmuxBackendRefSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  backend: Schema.Literal('tmux'),
  sessionName: Schema.String.pipe(Schema.minLength(1)),
});

export function decodeBackendRef(
  session: PtyProcessRecord,
): Effect.Effect<BackendSessionRef, PtyServiceError> {
  return Effect.try({
    try: () => {
      const raw = JSON.parse(session.backendRefJson);
      if (session.backend === 'tmux') {
        return Schema.decodeUnknownSync(tmuxBackendRefSchema)(raw);
      }
      const ref = Schema.decodeUnknownSync(nodePtyBackendRefSchema)(raw);
      if (ref.ptyProcessId === session.id) {
        return ref;
      }
      throw new Error(
        `Backend ref ptyProcessId ${ref.ptyProcessId} does not match row id ${session.id}.`,
      );
    },
    catch: (cause) =>
      new PtyServiceError({
        code: 'backend_session_missing',
        message: `PTY process ${session.id} has an invalid or unsupported backend ref.`,
        ptyProcessId: session.id,
        cause,
      }),
  });
}

export function backendMetadataForLaunch(
  backend: PtyBackend,
  metadata: { readonly ptyProcessId: number; readonly logPath: string | null },
  runtimeNamespace: string,
  sessionsPath: string,
) {
  if (backend.name === 'tmux') {
    const sessionName = `isagi_${runtimeNamespace}_${metadata.ptyProcessId}`;
    return {
      backendSessionName: sessionName,
      logMode: 'none' as const,
      logPath: null,
      ref: {
        schemaVersion: 1,
        backend: 'tmux',
        sessionName,
      } as const,
    };
  }
  const logPath = join(sessionsPath, `${metadata.ptyProcessId}.ptylog`);
  return {
    backendSessionName: null,
    logMode: 'backend_file' as const,
    logPath: metadata.logPath ?? logPath,
    ref: {
      schemaVersion: 1,
      backend: 'node_pty',
      ptyProcessId: metadata.ptyProcessId,
      pid: null,
    } as const,
  };
}
