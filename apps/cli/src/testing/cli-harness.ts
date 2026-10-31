import { Writable } from 'node:stream';

import { Effect, Layer, Stream } from 'effect';

import {
  RuntimeClient,
  RuntimeTransportError,
  type RuntimeClientError,
  type RuntimeContent,
} from '@isagi/runtime-client';

import { runCli } from '../main.js';
import type { RuntimeEntry, RuntimeLaunch } from '../serve/launch.js';

/**
 * A fake `RuntimeClient` keyed by endpoint id. A route answers with the value its handler returns
 * (a content route with `content(…)` / `cutContent(…)`), or with the runtime-client failure it
 * returns wrapped in `fail(…)`. Every request is recorded, so a test can assert exactly which routes
 * a command called and with what.
 */
export interface RecordedCall {
  readonly endpointId: string;
  readonly args: readonly unknown[];
}

export type RouteAnswer = unknown;
export type Route = (...args: readonly unknown[]) => RouteAnswer;

const failure = Symbol('failure');
export function fail(error: RuntimeClientError) {
  return { [failure]: error };
}

/** A content route's answer: these bytes, then the end of the body. */
export function content(bytes: Uint8Array | string): RuntimeContent {
  return contentOf(
    Stream.make(typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes),
  );
}

/** A content route's answer whose body breaks after `bytes`, like a dropped connection. */
export function cutContent(endpointId: string, bytes: Uint8Array, cause: unknown): RuntimeContent {
  return contentOf(
    Stream.make(bytes).pipe(
      Stream.concat(Stream.fail(new RuntimeTransportError({ endpointId, cause }))),
    ),
  );
}

function contentOf(stream: Stream.Stream<Uint8Array, RuntimeTransportError>): RuntimeContent {
  return {
    contentType: 'application/octet-stream',
    stream,
    // The CLI only ever streams a body to its destination.
    arrayBuffer: Effect.die(new Error('The CLI does not read content bodies whole.')),
  };
}

export function fakeRuntime(
  routes: Readonly<Record<string, Route>>,
  contentRoutes: Readonly<
    Record<string, (params: Record<string, string | number>) => RouteAnswer>
  > = {},
) {
  const calls: RecordedCall[] = [];
  const answer = (value: RouteAnswer) => {
    if (value && typeof value === 'object' && failure in value) {
      return Effect.fail((value as { [failure]: RuntimeClientError })[failure]);
    }
    return Effect.succeed(value);
  };
  const layer = (runtimeUrl: string): Layer.Layer<RuntimeClient> =>
    Layer.succeed(
      RuntimeClient,
      RuntimeClient.of({
        runtimeUrl,
        request: ((endpoint: { id: string }, ...args: unknown[]) =>
          Effect.suspend(() => {
            calls.push({ endpointId: endpoint.id, args });
            const route = routes[endpoint.id];
            if (!route) return Effect.die(new Error(`Unexpected request to ${endpoint.id}`));
            return answer(route(...args));
          })) as unknown as RuntimeClient['Service']['request'],
        requestContent: ((
          endpoint: { id: string },
          params: Record<string, string | number>,
          query?: Record<string, unknown>,
        ) =>
          Effect.suspend(() => {
            calls.push({ endpointId: endpoint.id, args: query ? [params, query] : [params] });
            const route = contentRoutes[endpoint.id];
            if (!route) return Effect.die(new Error(`Unexpected request to ${endpoint.id}`));
            return answer(route(params));
          })) as unknown as RuntimeClient['Service']['requestContent'],
        // The CLI opens no event streams.
        requestEventStream: ((endpoint: { id: string }) =>
          Stream.die(
            new Error(`Unexpected event stream ${endpoint.id}`),
          )) as unknown as RuntimeClient['Service']['requestEventStream'],
      }),
    );
  return { calls, layer };
}

export interface CliRun {
  readonly code: number;
  readonly stdout: string;
  readonly stdoutBytes: Buffer;
  readonly stderr: string;
}

/** Runs the whole CLI in process against a fake runtime (or none). */
export async function runIsagi(
  argv: readonly string[],
  options: {
    readonly runtime?: ReturnType<typeof fakeRuntime>;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly cwd?: string;
    /** Replaces the collected stdout, e.g. with one that fails like a closed pipe or a full disk. */
    readonly stdout?: NodeJS.WritableStream;
    readonly runtimeEntry?: RuntimeEntry;
  } = {},
): Promise<CliRun> {
  const stdout = collector();
  const stderr = collector();
  const code = await runCli(
    argv,
    {
      stdout: options.stdout ?? stdout.stream,
      stderr: stderr.stream,
      cwd: options.cwd ?? process.cwd(),
      env: options.env ?? { ISAGI_RUNTIME_URL: 'http://127.0.0.1:4100' },
    },
    {
      ...(options.runtime ? { runtimeClient: options.runtime.layer } : {}),
      ...(options.runtimeEntry ? { runtimeEntry: options.runtimeEntry } : {}),
    },
  );
  const stdoutBytes = stdout.bytes();
  return {
    code,
    stdout: stdoutBytes.toString('utf8'),
    stdoutBytes,
    stderr: stderr.bytes().toString('utf8'),
  };
}

function collector() {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      callback();
    },
  });
  return { stream, bytes: () => Buffer.concat(chunks) };
}

/** The single JSON document a `--json` run printed; fails if stdout holds anything else. */
export function onlyJsonDocument(stdout: string): unknown {
  const lines = stdout.split('\n').filter((line) => line.length > 0);
  if (lines.length !== 1) throw new Error(`Expected one JSON document, got: ${stdout}`);
  return JSON.parse(lines[0]!);
}

/**
 * A runtime entry for `serve` that records every launch instead of starting a runtime. `load`
 * replaces the module loader, e.g. with one that rejects like a native module built for another Node.
 */
export function fakeRuntimeEntry(options: { readonly load?: () => Promise<unknown> } = {}) {
  const launches: RuntimeLaunch[] = [];
  const entry: RuntimeEntry = {
    cliEntryPath: '/opt/isagi/dist/isagi.mjs',
    load:
      options.load ??
      (() =>
        Promise.resolve({
          serveRuntime: (launch: RuntimeLaunch) => {
            launches.push(launch);
          },
        })),
  };
  return { entry, launches };
}

/** The smallest accepted command line of every leaf (after its words): each positional and required flag. */
export const minimalCommandLines: Readonly<Record<string, readonly string[]>> = {
  'workflows list': [],
  'workflows runs launch': ['implement-story'],
  'workflows runs list': [],
  'workflows runs show': ['7'],
  'workflows runs structure': ['7'],
  'workflows runs events': ['7'],
  'workflows runs pause': ['7'],
  'workflows runs resume': ['7'],
  'workflows runs retry': ['7'],
  'workflows runs cancel': ['7'],
  'workflows executions show': ['7'],
  'workflows operations list': ['--run', '42'],
  'workflows operations show': ['7'],
  'workflows checkpoints list': ['--run', '42'],
  'workflows checkpoints show': ['7'],
  'workflows checkpoints read': ['7', 'scratch/plan.md'],
  'workflows checkpoints export': ['7', '--output', 'rebuilt'],
};
