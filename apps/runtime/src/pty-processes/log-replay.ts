import { statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { setImmediate as yieldImmediate } from 'node:timers/promises';

import { Effect } from 'effect';

import type { PtyStreamOutputMessageSet } from '@isagi/contracts';

import { PtyServiceError } from './types.js';

const replayChunkBytes = 64 * 1024;

export function replayUtf8LogFile(input: {
  readonly logPath: string | null;
  readonly bytes: number | null;
  readonly send: (message: PtyStreamOutputMessageSet) => void;
  readonly failureMessage: string;
}) {
  return Effect.tryPromise({
    try: async () => {
      const bytes = input.logPath ? (input.bytes ?? statSync(input.logPath).size) : 0;
      input.send({ type: 'replay_start', bytes });
      if (input.logPath && bytes > 0) {
        const file = await open(input.logPath, 'r');
        try {
          const buffer = Buffer.allocUnsafe(Math.min(replayChunkBytes, bytes));
          const decoder = new StringDecoder('utf8');
          let offset = 0;
          while (offset < bytes) {
            const toRead = Math.min(buffer.byteLength, bytes - offset);
            const { bytesRead } = await file.read(buffer, 0, toRead, offset);
            if (bytesRead <= 0) {
              break;
            }
            offset += bytesRead;
            const data = decoder.write(buffer.subarray(0, bytesRead));
            if (data.length > 0) input.send({ type: 'output', data, replay: true });
            if (offset < bytes) await yieldImmediate();
          }
          const trailing = decoder.end();
          if (trailing.length > 0) input.send({ type: 'output', data: trailing, replay: true });
        } finally {
          await file.close();
        }
      }
      input.send({ type: 'replay_end' });
    },
    catch: (cause) =>
      new PtyServiceError({
        code: 'log_read_failed',
        message: input.failureMessage,
        cause,
      }),
  });
}
