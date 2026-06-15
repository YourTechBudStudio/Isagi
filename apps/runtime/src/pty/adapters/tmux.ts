import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { Context, Effect, Layer } from 'effect';
import * as nodePty from 'node-pty';

import type { BackendAttachment, PtyBackend as PtyBackendShape, TmuxBackendRef } from '../types.js';
import {
  PtyInspectError,
  PtyKillError,
  PtyResizeError,
  PtyStartError,
  PtyWriteError,
} from '../types.js';
import { collectTmuxGarbage } from './tmux-gc.js';

const execFileAsync = promisify(execFile);

const isagiTmuxSocketName = 'isagi';
const isagiTmuxOptions = [
  ['set-option', '-g', 'mouse', 'on'],
  ['set-option', '-gq', 'extended-keys', 'on'],
  ['set-option', '-gq', 'extended-keys-format', 'csi-u'],
  ['set-option', '-gq', 'xterm-keys', 'on'],
  ['set-option', '-gq', 'terminal-features[99]', 'xterm*:extkeys'],
] as const;

export const TmuxBackend = Context.GenericTag<PtyBackendShape>('isagi/TmuxBackend');

const listTmuxSessions = runTmux(['list-sessions', '-F', '#S']).pipe(
  Effect.map(({ stdout }) =>
    stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((sessionName) => sessionName.length > 0)
      .map(
        (sessionName) =>
          ({
            schemaVersion: 1,
            backend: 'tmux',
            sessionName,
          }) satisfies TmuxBackendRef,
      ),
  ),
  Effect.catchAll((cause) =>
    isTmuxServerMissing(cause) ? Effect.succeed([]) : Effect.fail(new PtyInspectError({ cause })),
  ),
);

export const TmuxBackendLive = Layer.succeed(TmuxBackend, {
  name: 'tmux',
  available: runTmux(['-V']).pipe(
    Effect.as(true),
    Effect.catchAll(() => Effect.succeed(false)),
  ),
  launch: (input) =>
    Effect.gen(function* () {
      if (!input.backendSessionName) {
        return yield* Effect.fail(
          new PtyStartError({
            ptySessionId: input.ptySessionId,
            command: input.command,
            cwd: input.cwd,
            cause: new Error('Tmux launch requires a deterministic backend session name.'),
          }),
        );
      }
      const sessionName = input.backendSessionName;
      yield* runConfiguredTmux(
        ['new-session', '-d', '-s', sessionName, '-c', input.cwd, input.command],
        {
          env: input.env,
        },
      ).pipe(
        Effect.mapError(
          (cause) =>
            new PtyStartError({
              ptySessionId: input.ptySessionId,
              command: input.command,
              cwd: input.cwd,
              cause,
            }),
        ),
      );
      return {
        schemaVersion: 1,
        backend: 'tmux',
        sessionName,
      } satisfies TmuxBackendRef;
    }),
  attach: (input) =>
    Effect.gen(function* () {
      if (input.ref.backend !== 'tmux') {
        return yield* Effect.fail(
          new PtyStartError({
            command: 'tmux attach-session',
            cwd: '',
            cause: new Error(`Cannot attach tmux backend to ${input.ref.backend} ref.`),
          }),
        );
      }
      const sessionName = input.ref.sessionName;
      return yield* Effect.try({
        try: () => {
          const client = nodePty.spawn(
            'tmux',
            tmuxArgs(configuredTmuxCommand(['attach-session', '-t', sessionName])),
            {
              name: 'xterm-256color',
              cols: input.cols,
              rows: input.rows,
              env: {
                ...process.env,
                TERM: 'xterm-256color',
                COLORTERM: 'truecolor',
              },
            },
          );
          client.onData(input.onOutput);
          client.onExit(() => {
            // The tmux client is only the runtime attachment. Its exit is not durable
            // session exit; startup reconciliation and polling own tmux session state.
          });
          return {
            write: (data) =>
              Effect.try({
                try: () => client.write(data),
                catch: (cause) => new PtyWriteError({ cause }),
              }),
            resize: (size) =>
              Effect.try({
                try: () => client.resize(size.cols, size.rows),
                catch: (cause) => new PtyResizeError({ cause }),
              }),
            detach: Effect.sync(() => {
              client.kill();
            }),
          } satisfies BackendAttachment;
        },
        catch: (cause) =>
          new PtyStartError({
            command: 'tmux attach-session',
            cwd: '',
            cause,
          }),
      });
    }),
  replay: (input) =>
    Effect.sync(() => {
      input.send({ type: 'replay_start', bytes: 0 });
      input.send({ type: 'replay_end' });
    }),
  inspect: (ref) =>
    runTmux(['has-session', '-t', ref.backend === 'tmux' ? ref.sessionName : '']).pipe(
      Effect.as({ status: 'alive' as const }),
      Effect.catchAll((cause) => Effect.succeed(classifyTmuxInspectFailure(cause))),
    ),
  listSessions: listTmuxSessions,
  collectGarbage: (input) => collectTmuxGarbage(input, listTmuxSessions),
  kill: (ref) =>
    runTmux(['kill-session', '-t', ref.backend === 'tmux' ? ref.sessionName : '']).pipe(
      Effect.asVoid,
      Effect.mapError((cause) => new PtyKillError({ cause })),
    ),
} satisfies PtyBackendShape);

function runConfiguredTmux(
  args: readonly string[],
  options: { readonly env?: NodeJS.ProcessEnv | undefined } = {},
) {
  return runTmux(configuredTmuxCommand(args), options);
}

function runTmux(
  args: readonly string[],
  options: { readonly env?: NodeJS.ProcessEnv | undefined } = {},
) {
  return Effect.tryPromise({
    try: async (signal) => {
      const { stdout, stderr } = await execFileAsync('tmux', tmuxArgs(args), {
        encoding: 'utf8',
        env: options.env,
        signal,
      });
      return { stdout, stderr };
    },
    catch: (cause) => cause,
  });
}

function configuredTmuxCommand(args: readonly string[]) {
  const command: string[] = [];
  for (const option of isagiTmuxOptions) {
    command.push(...option, ';');
  }
  command.push(...args);
  return command;
}

function tmuxArgs(args: readonly string[]) {
  return ['-L', isagiTmuxSocketName, ...args];
}

function classifyTmuxInspectFailure(cause: unknown) {
  if (isTmuxUnavailable(cause)) {
    return { status: 'unavailable' as const, cause };
  }
  return { status: 'missing' as const };
}

function isTmuxUnavailable(cause: unknown) {
  if (!cause || typeof cause !== 'object') {
    return false;
  }
  const code = 'code' in cause ? (cause as { readonly code?: unknown }).code : null;
  if (code === 'ENOENT') {
    return true;
  }
  const stderr = 'stderr' in cause ? (cause as { readonly stderr?: unknown }).stderr : null;
  return typeof stderr === 'string' && stderr.includes('no server running');
}

function isTmuxServerMissing(cause: unknown) {
  if (!cause || typeof cause !== 'object') {
    return false;
  }
  const stderr = 'stderr' in cause ? (cause as { readonly stderr?: unknown }).stderr : null;
  return (
    typeof stderr === 'string' &&
    (stderr.includes('no server running') || stderr.includes('error connecting'))
  );
}
