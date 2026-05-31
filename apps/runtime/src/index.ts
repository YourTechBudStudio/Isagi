import process from 'node:process';

import { Effect } from 'effect';

import { formatReadyLine, parsePort, startRuntimeServer } from './server.js';

const program = Effect.gen(function* () {
  const host = process.env.HOST;
  const port = yield* parsePort(process.env.PORT);
  const { server, url } = yield* startRuntimeServer(host ? { host, port } : { port });

  console.log(formatReadyLine(url));

  const close = () =>
    Effect.runPromise(
      Effect.tryPromise({
        try: () => server.close(),
        catch: toError,
      }),
    );

  process.once('SIGINT', () => {
    void close().finally(() => process.exit(0));
  });

  process.once('SIGTERM', () => {
    void close().finally(() => process.exit(0));
  });
});

await Effect.runPromise(program);

function toError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}
