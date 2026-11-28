import { join } from 'node:path';

import { Effect, Schema } from 'effect';

import type { PtyProcessRecord } from '../types.js';
import { PtyServiceError, type BackendSessionRef } from '../types.js';

const nodePtyBackendRefSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  backend: Schema.Literal('node_pty'),
  ptyProcessId: Schema.Int.check(Schema.isGreaterThan(0)),
  pid: Schema.NullOr(Schema.Int),
  shellIntegrationToken: Schema.optional(Schema.NullOr(Schema.String)),
});

export function decodeBackendRef(
  session: PtyProcessRecord,
): Effect.Effect<BackendSessionRef, PtyServiceError> {
  return Effect.try({
    try: () => {
      const raw = JSON.parse(session.backendRefJson);
      const ref = Schema.decodeUnknownSync(nodePtyBackendRefSchema)(raw);
      // The ref must describe this row: the transport the row records and the row itself. A row whose backend has no
      // operable ref (a retired backend, or corruption) fails here rather than being operated as something else.
      if (ref.backend !== session.backend) {
        throw new Error(
          `Backend ref backend ${ref.backend} does not match row backend ${String(session.backend)}.`,
        );
      }
      if (ref.ptyProcessId !== session.id) {
        throw new Error(
          `Backend ref ptyProcessId ${ref.ptyProcessId} does not match row id ${session.id}.`,
        );
      }
      return ref;
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
  metadata: { readonly ptyProcessId: number; readonly logPath: string | null },
  sessionsPath: string,
) {
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
