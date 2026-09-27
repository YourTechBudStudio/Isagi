import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { Context, Effect, Layer } from 'effect';
import * as nodePty from 'node-pty';

import {
  createShellIntegrationParser,
  foregroundStateFromEvent,
  shellIntegrationTokenFromRef,
  stripShellIntegrationMarkers,
} from '../service/shell-integration.js';
import type {
  BackendAttachment,
  BackendTerminateResult,
  PtyBackend as PtyBackendShape,
  TmuxBackendRef,
} from '../types.js';
import {
  PtyInspectError,
  PtyKillError,
  PtyResizeError,
  PtyServiceError,
  PtyStartError,
  PtyWriteError,
} from '../types.js';
import {
  killProcessTreeSurvivors,
  signalProcessTreeDescendants,
  snapshotProcessTree,
} from './process-tree.js';
import { collectTmuxGarbage } from './tmux-gc.js';

const execFileAsync = promisify(execFile);

const isagiTmuxSocketName = 'isagi';
const isagiTmuxOptions = [
  ['set-option', '-g', 'status', 'off'],
  ['set-option', '-g', 'mouse', 'on'],
  ['set-option', '-gq', 'extended-keys', 'on'],
  ['set-option', '-gq', 'extended-keys-format', 'csi-u'],
  ['set-option', '-gq', 'xterm-keys', 'on'],
  ['set-option', '-gq', 'terminal-features[99]', 'xterm*:extkeys'],
  ['set-option', '-gqu', 'terminal-overrides[99]'],
] as const;

const tmuxKillTimeoutMs = 5_000;

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
            ptyProcessId: input.ptyProcessId,
            command: input.command,
            cwd: input.cwd,
            cause: new Error('Tmux launch requires a deterministic backend session name.'),
          }),
        );
      }
      const sessionName = input.backendSessionName;
      yield* runConfiguredTmux(
        [
          'new-session',
          '-d',
          '-s',
          sessionName,
          '-c',
          input.cwd,
          shellCommand(input.command, input.args),
        ],
        {
          env: input.env,
        },
      ).pipe(
        Effect.mapError(
          (cause) =>
            new PtyStartError({
              ptyProcessId: input.ptyProcessId,
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
        shellIntegrationToken: input.shellIntegration?.token ?? null,
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
          // The parser is created per attach, so a command already running when a
          // client (re)attaches — or any command alive across a runtime restart —
          // emits no start marker the runtime can observe and reads as idle until it
          // ends. tmux is a legacy/optional backend; under-reporting to idle is the
          // safe direction (never a false "working"). node-pty binds the parser at
          // launch and does not have this gap.
          const parser = createShellIntegrationParser({
            shellIntegration: shellIntegrationTokenFromRef(input.ref),
            onEvent: (event) => {
              if (input.ref.backend !== 'tmux') return;
              const ptyProcessId = ptyProcessIdFromTmuxSessionName(input.ref.sessionName);
              if (ptyProcessId > 0) {
                input.onForegroundCommand?.({
                  ptyProcessId,
                  state: foregroundStateFromEvent(event),
                });
              }
            },
          });
          client.onData((data) => {
            const visible = parser.push(data);
            if (visible.length > 0) input.onOutput(visible);
          });
          client.onExit(() => {
            // The tmux client is only the runtime attachment. Its exit is not durable
            // session exit; startup reconciliation and polling own tmux session state.
          });
          return {
            replayBytes: null,
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
  writeInput: (input) =>
    Effect.gen(function* () {
      if (input.ref.backend !== 'tmux') {
        return yield* Effect.fail(
          new PtyWriteError({
            cause: new Error(`Cannot write tmux input to ${input.ref.backend} ref.`),
          }),
        );
      }
      const bufferName = `isagi-input-${process.pid}-${Date.now()}`;
      yield* runTmux(['set-buffer', '-b', bufferName, input.data]).pipe(
        Effect.mapError((cause) => new PtyWriteError({ cause })),
      );
      yield* runTmux(['paste-buffer', '-d', '-b', bufferName, '-t', input.ref.sessionName]).pipe(
        Effect.asVoid,
        Effect.mapError((cause) => new PtyWriteError({ cause })),
      );
    }),
  replay: (input) =>
    Effect.gen(function* () {
      if (input.ref.backend !== 'tmux') {
        return yield* Effect.fail(
          new PtyServiceError({
            code: 'log_read_failed',
            message: `Cannot replay tmux backend from ${input.ref.backend} ref.`,
          }),
        );
      }
      const ref = input.ref;
      const { stdout } = yield* runTmux([
        'capture-pane',
        '-p',
        '-e',
        '-S',
        '-',
        '-t',
        ref.sessionName,
      ]).pipe(
        Effect.mapError(
          (cause) =>
            new PtyServiceError({
              code: 'log_read_failed',
              message: `Could not replay tmux session ${ref.sessionName}.`,
              cause,
            }),
        ),
      );
      const replayData = terminalReplayDataFromCapturePane(stdout);
      const data = ref.shellIntegrationToken
        ? stripShellIntegrationMarkers(replayData, shellIntegrationTokenFromRef(ref))
        : replayData;
      const bytes = Buffer.byteLength(data);
      input.send({ type: 'replay_start', bytes });
      if (bytes > 0) {
        input.send({ type: 'output', data, replay: true });
      }
      input.send({ type: 'replay_end' });
    }),
  inspect: (ref) =>
    runTmux(['has-session', '-t', ref.backend === 'tmux' ? ref.sessionName : '']).pipe(
      Effect.as({ status: 'alive' as const }),
      Effect.catchAll((cause) => Effect.succeed(classifyTmuxInspectFailure(cause))),
    ),
  listSessions: listTmuxSessions,
  collectGarbage: (input) => collectTmuxGarbage(input, listTmuxSessions),
  terminate: (input) => {
    console.warn(
      '[runtime] tmux PTY backend does not support reliable graceful termination; killing tmux session directly.',
    );
    return killTmuxSession(
      input.ref.backend === 'tmux' ? input.ref.sessionName : '',
      input.gracefulTimeoutMs,
    );
  },
  kill: (ref) => killTmuxSession(ref.backend === 'tmux' ? ref.sessionName : '', null),
} satisfies PtyBackendShape);

// A successful `kill-session` is an affirmative kill. A missing session or a
// missing server is verified absence: the attempt terminated nothing, so its
// caller must persist no `killed` fact. Everything else — an unusable tmux
// binary included — stays a control failure with no terminal evidence.
//
// `kill-session` only SIGHUPs the pane processes, so their process trees are
// snapshotted first and swept afterwards (see `process-tree.ts`). With a
// graceful timeout the survivors get SIGTERM and that long to exit before the
// SIGKILL sweep; without one they are SIGKILLed at once.
//
// `kill-session` and the sweep form one uninterruptible operation: the tmux
// server can act before the client returns, so a cancellation that landed
// while the command was in flight would otherwise strand the descendants of a
// session that is already dead. A timeout bounds it instead, so a wedged tmux
// still cannot hold the caller forever — it surfaces as a control failure,
// after sweeping whatever panes that failure demonstrably killed anyway.
function killTmuxSession(sessionName: string, gracefulTimeoutMs: number | null) {
  return Effect.gen(function* () {
    const ptyProcessId = ptyProcessIdFromTmuxSessionName(sessionName);
    const panePids = yield* listTmuxPanePids(sessionName, ptyProcessId);
    const trees = yield* Effect.forEach(panePids, (rootPid) =>
      snapshotProcessTree({ ptyProcessId, rootPid }),
    );
    return yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const result = yield* runTmux(['kill-session', '-t', sessionName], {
          timeoutMs: tmuxKillTimeoutMs,
        }).pipe(
          Effect.as({ terminated: true } satisfies BackendTerminateResult),
          Effect.catchAll((cause) =>
            isTmuxBinaryMissing(cause) ||
            !(isTmuxSessionMissing(cause) || isTmuxServerMissing(cause))
              ? Effect.fail(new PtyKillError({ cause }))
              : Effect.succeed({ terminated: false } satisfies BackendTerminateResult),
          ),
          // A control failure — a timeout included — does not say whether the
          // server acted before it failed. Sweep only the trees whose root is
          // demonstrably gone, then still report the failure: the kill is not
          // affirmed, so the caller persists no `killed` fact.
          Effect.tapError(() =>
            Effect.forEach(trees, (tree) =>
              killProcessTreeSurvivors(tree, { requireRootExited: true }),
            ),
          ),
        );
        if (gracefulTimeoutMs !== null && trees.some((tree) => tree !== null)) {
          yield* Effect.forEach(trees, (tree) => signalProcessTreeDescendants(tree, 'SIGTERM'));
          yield* Effect.sleep(gracefulTimeoutMs);
        }
        const swept = yield* Effect.forEach(trees, (tree) => killProcessTreeSurvivors(tree));
        // A missing session does not mean its panes are gone: a pane root that
        // ignored the hangup outlives the session it ran in. The sweep kills it
        // rather than leaving it untracked, and that kill is affirmed so the
        // caller does not record absence for a process this attempt ended.
        if (!result.terminated && swept.some((sweep) => sweep.killedRoot)) {
          console.warn(
            `[runtime] tmux session was already gone but its pane root was still alive; killed it ptyProcessId=${ptyProcessId} sessionName=${sessionName}`,
          );
          return { terminated: true } satisfies BackendTerminateResult;
        }
        return result;
      }),
    );
  });
}

// Pane root pids for the tree sweep. Best effort: the kill itself must not
// depend on it, so a failure yields no panes. An already-gone session or server
// has no panes to sweep and stays quiet; anything else means the sweep is lost
// for this kill, which is logged so the degradation is visible.
function listTmuxPanePids(sessionName: string, ptyProcessId: number) {
  return runTmux(['list-panes', '-s', '-t', sessionName, '-F', '#{pane_pid}']).pipe(
    Effect.map(({ stdout }) =>
      stdout
        .split('\n')
        .map((line) => Number(line.trim()))
        .filter((pid) => Number.isSafeInteger(pid) && pid > 0),
    ),
    Effect.catchAll((cause) =>
      Effect.sync(() => {
        if (
          !isTmuxBinaryMissing(cause) &&
          (isTmuxSessionMissing(cause) || isTmuxServerMissing(cause))
        ) {
          return [] as number[];
        }
        console.warn(
          `[runtime] Could not list tmux pane pids; PTY descendants will not be swept ptyProcessId=${ptyProcessId} sessionName=${sessionName}`,
          cause,
        );
        return [] as number[];
      }),
    ),
  );
}

function terminalReplayDataFromCapturePane(output: string) {
  // `capture-pane -p` returns rendered screen rows separated with LF, not a raw PTY byte
  // stream. xterm runs with convertEol disabled for live-stream correctness, so replay
  // snapshots need explicit carriage returns to start each captured row at column 0.
  return output.replace(/\r?\n/g, '\r\n');
}

function runConfiguredTmux(
  args: readonly string[],
  options: { readonly env?: NodeJS.ProcessEnv | undefined } = {},
) {
  return runTmux(configuredTmuxCommand(args), options);
}

function runTmux(
  args: readonly string[],
  options: {
    readonly env?: NodeJS.ProcessEnv | undefined;
    readonly timeoutMs?: number | undefined;
  } = {},
) {
  return Effect.tryPromise({
    try: async (signal) => {
      const { stdout, stderr } = await execFileAsync('tmux', tmuxArgs(args), {
        encoding: 'utf8',
        env: options.env,
        signal,
        timeout: options.timeoutMs,
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

function shellCommand(command: string, args: readonly string[] = []) {
  return [command, ...args].map(shellQuote).join(' ');
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function tmuxArgs(args: readonly string[]) {
  return ['-L', isagiTmuxSocketName, ...args];
}

function ptyProcessIdFromTmuxSessionName(sessionName: string) {
  const match = /_(\d+)$/.exec(sessionName);
  return match ? Number(match[1]) : 0;
}

function classifyTmuxInspectFailure(cause: unknown) {
  if (isTmuxUnavailable(cause)) {
    return { status: 'unavailable' as const, cause };
  }
  return { status: 'missing' as const };
}

function isTmuxUnavailable(cause: unknown) {
  if (isTmuxBinaryMissing(cause)) {
    return true;
  }
  return stderrOf(cause).includes('no server running');
}

function isTmuxBinaryMissing(cause: unknown) {
  if (!cause || typeof cause !== 'object') {
    return false;
  }
  return ('code' in cause ? (cause as { readonly code?: unknown }).code : null) === 'ENOENT';
}

// tmux reports an already-gone session on stderr rather than through an exit
// code we can distinguish, so the established message shapes are the classifier.
function isTmuxSessionMissing(cause: unknown) {
  const stderr = stderrOf(cause);
  return stderr.includes("can't find session") || stderr.includes('session not found');
}

function stderrOf(cause: unknown) {
  if (!cause || typeof cause !== 'object') {
    return '';
  }
  const stderr = 'stderr' in cause ? (cause as { readonly stderr?: unknown }).stderr : null;
  return typeof stderr === 'string' ? stderr : '';
}

function isTmuxServerMissing(cause: unknown) {
  const stderr = stderrOf(cause);
  return stderr.includes('no server running') || stderr.includes('error connecting');
}
