import { accessSync, appendFileSync, chmodSync, constants, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import process from 'node:process';

import { Context, Effect, Layer, Queue, Stream, type Cause } from 'effect';
import * as nodePty from 'node-pty';

import { describeOperationalCause } from '../../platform/diagnostics/index.js';
import { replayUtf8LogFile } from '../log-replay.js';
import {
  createShellIntegrationParser,
  foregroundStateFromEvent,
} from '../service/shell-integration.js';
import type {
  BackendAttachment,
  BackendTerminateResult,
  LaunchBackendSessionInput,
  NodePtyBackendRef,
  PtyBackend as PtyBackendShape,
  PtyOutputMessage,
  PtyProcessEvent,
} from '../types.js';
import { PtyKillError, PtyResizeError, PtyStartError, PtyWriteError } from '../types.js';
import { collectNodePtyGarbage } from './node-pty-gc.js';
import {
  killProcessTreeSurvivors,
  signalProcessTreeDescendants,
  snapshotProcessTree,
} from './process-tree.js';

// node-pty is adapted here, once: its `onData`/`onExit` callbacks do only synchronous work (parse, append the log,
// enqueue) and never run an Effect. Every fact about a launched process reaches the PTY service through the
// `events` queue returned by `launch`; live output reaches an attachment through the queue it registered.
interface LiveNodePtyProcess {
  readonly ptyProcessId: number;
  readonly process: nodePty.IPty;
  readonly logPath: string | null;
  attachment: NodePtyAttachmentSink | null;
  running: boolean;
  suppressExitCallback: boolean;
}

interface NodePtyAttachmentSink {
  readonly output: Queue.Enqueue<PtyOutputMessage>;
}

const make = Effect.gen(function* () {
  yield* ensureNodePtyDarwinHelperExecutable;
  const liveSessions = new Map<number, LiveNodePtyProcess>();
  const listSessions = Effect.sync(() =>
    [...liveSessions.values()].flatMap((session) =>
      session.running
        ? [
            {
              schemaVersion: 1,
              backend: 'node_pty' as const,
              ptyProcessId: session.ptyProcessId,
              pid: session.process.pid,
            } satisfies NodePtyBackendRef,
          ]
        : [],
    ),
  );

  return {
    name: 'node_pty',
    available: Effect.succeed(true),
    launch: Effect.fnUntraced(function* (input: LaunchBackendSessionInput) {
      // Created before the spawn, so nothing the process does can happen before there is somewhere to put it.
      const events = yield* Queue.unbounded<PtyProcessEvent, Cause.Done>();
      const ref = yield* Effect.try({
        try: () => startNodePtyProcess(input, events, liveSessions),
        catch: (cause) =>
          new PtyStartError({
            ptyProcessId: input.ptyProcessId,
            command: input.command,
            cwd: input.cwd,
            cause,
          }),
      });
      return { ref, events: Stream.fromQueue(events) };
    }),
    attach: (input) => {
      const ref = input.ref;
      if (ref.backend !== 'node_pty') {
        return Effect.fail(
          attachError(
            undefined,
            new Error(`Cannot attach node-pty backend to ${ref.backend} ref.`),
          ),
        );
      }
      const sink: NodePtyAttachmentSink = { output: input.output };
      return Effect.acquireRelease(
        // Registration and the log size are read in one synchronous step, so no byte is both replayed and delivered.
        Effect.suspend(() => {
          const live = liveSessions.get(ref.ptyProcessId);
          if (!live?.running) {
            return Effect.fail(
              attachError(
                ref.ptyProcessId,
                new Error(`node-pty process ${ref.ptyProcessId} is not live.`),
              ),
            );
          }
          return Effect.try({
            try: () => {
              live.process.resize(input.cols, input.rows);
              live.attachment = sink;
              return { live, replayBytes: replayBytesForLog(live.logPath) };
            },
            catch: (cause) => attachError(ref.ptyProcessId, cause),
          });
        }),
        ({ live }) =>
          Effect.sync(() => {
            if (live.attachment === sink) live.attachment = null;
          }),
      ).pipe(
        Effect.map(
          ({ live, replayBytes }) =>
            ({
              replayBytes,
              write: (data) =>
                Effect.try({
                  try: () => live.process.write(data),
                  catch: (cause) => new PtyWriteError({ ptyProcessId: ref.ptyProcessId, cause }),
                }),
              resize: (size) =>
                Effect.try({
                  try: () => live.process.resize(size.cols, size.rows),
                  catch: (cause) => new PtyResizeError({ ptyProcessId: ref.ptyProcessId, cause }),
                }),
            }) satisfies BackendAttachment,
        ),
      );
    },
    writeInput: (input) => {
      const ref = input.ref;
      if (ref.backend !== 'node_pty') {
        return Effect.fail(
          new PtyWriteError({
            cause: new Error(`Cannot write node-pty input to ${ref.backend} ref.`),
          }),
        );
      }
      return Effect.suspend(() => {
        const live = liveSessions.get(ref.ptyProcessId);
        if (!live?.running) {
          return Effect.fail(
            new PtyWriteError({
              ptyProcessId: ref.ptyProcessId,
              cause: new Error(`node-pty process ${ref.ptyProcessId} is not live.`),
            }),
          );
        }
        return Effect.try({
          try: () => live.process.write(input.data),
          catch: (cause) => new PtyWriteError({ ptyProcessId: ref.ptyProcessId, cause }),
        });
      });
    },
    replay: (input) => replayBackendLog(input.logPath, input.bytes, input.send),
    inspect: (ref) =>
      Effect.succeed(
        ref.backend === 'node_pty' && liveSessions.get(ref.ptyProcessId)?.running
          ? { status: 'alive' as const }
          : { status: 'missing' as const },
      ),
    listSessions,
    collectGarbage: (input) => collectNodePtyGarbage(input, listSessions),
    // Absence and signalling are reported separately: `terminated: false` means
    // no live handle existed for this ref, so the attempt terminated nothing
    // and its caller must persist no `killed` fact. `true` is returned only
    // when a signal operation completed successfully — a throwing SIGKILL
    // escalation surfaces `PtyKillError` instead.
    //
    // Both paths act on the whole process tree, not just the spawned root: the
    // tree is snapshotted while the root still anchors it, and anything left of
    // it afterwards is SIGKILLed (see `process-tree.ts`). Everything from the
    // first signal on is uninterruptible: once the tree has been told to die, a
    // cancelled request must not strand the descendants that ignored it. A
    // failed root kill skips the sweep, since the root may still be a live,
    // tracked process whose children are not ours to take.
    terminate: (input) =>
      Effect.gen(function* () {
        const ref = input.ref;
        const ptyProcessId = ref.backend === 'node_pty' ? ref.ptyProcessId : undefined;
        const toKillError = (cause: unknown) => new PtyKillError({ ptyProcessId, cause });
        if (ref.backend !== 'node_pty') {
          return yield* Effect.fail(
            toKillError(new Error(`Cannot terminate node-pty backend for ${ref.backend} ref.`)),
          );
        }
        const live = liveSessions.get(ref.ptyProcessId);
        if (!live) {
          return { terminated: false } satisfies BackendTerminateResult;
        }
        const tree = yield* snapshotProcessTree({
          ptyProcessId: ref.ptyProcessId,
          rootPid: live.process.pid,
        });
        return yield* Effect.gen(function* () {
          const graceful = yield* Effect.try({
            try: () => {
              try {
                live.process.kill('SIGTERM');
                return true;
              } catch {
                live.process.kill();
                return false;
              }
            },
            catch: toKillError,
          });
          if (graceful) {
            yield* signalProcessTreeDescendants(tree, 'SIGTERM');
            yield* Effect.sleep(input.gracefulTimeoutMs);
            const current = liveSessions.get(ref.ptyProcessId);
            if (current?.running) {
              current.suppressExitCallback = true;
              liveSessions.delete(ref.ptyProcessId);
              yield* Effect.try({
                try: () => current.process.kill('SIGKILL'),
                // A failed escalation leaves the root possibly alive, so it
                // goes back under tracking rather than running unwatched.
                catch: (cause) => {
                  current.suppressExitCallback = false;
                  if (current.running) {
                    liveSessions.set(ref.ptyProcessId, current);
                  }
                  return toKillError(cause);
                },
              });
            }
          }
          return { terminated: true } satisfies BackendTerminateResult;
        }).pipe(
          Effect.tap(() => killProcessTreeSurvivors(tree)),
          Effect.uninterruptible,
        );
      }),
    kill: (ref) =>
      Effect.gen(function* () {
        const ptyProcessId = ref.backend === 'node_pty' ? ref.ptyProcessId : undefined;
        const toKillError = (cause: unknown) => new PtyKillError({ ptyProcessId, cause });
        if (ref.backend !== 'node_pty') {
          return yield* Effect.fail(
            toKillError(new Error(`Cannot kill node-pty backend for ${ref.backend} ref.`)),
          );
        }
        const live = liveSessions.get(ref.ptyProcessId);
        if (!live) {
          return { terminated: false } satisfies BackendTerminateResult;
        }
        const tree = yield* snapshotProcessTree({
          ptyProcessId: ref.ptyProcessId,
          rootPid: live.process.pid,
        });
        return yield* Effect.gen(function* () {
          live.suppressExitCallback = true;
          liveSessions.delete(ref.ptyProcessId);
          yield* Effect.try({
            // SIGKILL, not node-pty's default SIGHUP: the live entry is dropped
            // above, so a root that ignored a softer signal would keep running
            // with nothing left that tracks it.
            try: () => live.process.kill('SIGKILL'),
            catch: (cause) => {
              live.suppressExitCallback = false;
              if (live.running) {
                liveSessions.set(ref.ptyProcessId, live);
              }
              return toKillError(cause);
            },
          });
          return { terminated: true } satisfies BackendTerminateResult;
        }).pipe(
          Effect.tap(() => killProcessTreeSurvivors(tree)),
          Effect.uninterruptible,
        );
      }),
  } satisfies PtyBackendShape;
});

export class NodePtyBackend extends Context.Service<NodePtyBackend, PtyBackendShape>()(
  'isagi/runtime/pty-processes/NodePtyBackend',
) {
  static readonly layer = Layer.effect(NodePtyBackend, make);
}

type NodePtySpawn = typeof nodePty.spawn;

function attachError(ptyProcessId: number | undefined, cause: unknown) {
  return new PtyStartError({ ptyProcessId, command: 'node_pty_attach', cwd: '', cause });
}

/**
 * Spawns and wires the node-pty callbacks. They do only synchronous work: answer terminal probes while detached, parse
 * shell-integration markers, append the log (synchronously, which is what makes an attachment's `replayBytes` exact),
 * and enqueue. `events` ends after `Exited`, or without one when `kill`/`terminate` suppressed the exit callback.
 */
function startNodePtyProcess(
  input: LaunchBackendSessionInput,
  events: Queue.Queue<PtyProcessEvent, Cause.Done>,
  liveSessions: Map<number, LiveNodePtyProcess>,
): NodePtyBackendRef {
  const pty = spawnNodePty(input);
  const live: LiveNodePtyProcess = {
    ptyProcessId: input.ptyProcessId,
    process: pty,
    logPath: input.logPath,
    attachment: null,
    running: true,
    suppressExitCallback: false,
  };
  liveSessions.set(input.ptyProcessId, live);
  const parser = createShellIntegrationParser({
    shellIntegration: input.shellIntegration ?? null,
    onEvent: (event) =>
      Queue.offerUnsafe(events, {
        _tag: 'ForegroundChanged',
        state: foregroundStateFromEvent(event),
      }),
  });
  const appendVisible = (visible: string) => {
    const failure = appendBackendLog(input.logPath, visible);
    if (failure !== null) Queue.offerUnsafe(events, { _tag: 'LogAppendFailed', cause: failure });
    if (live.attachment)
      Queue.offerUnsafe(live.attachment.output, { type: 'output', data: visible });
  };
  pty.onData((data) => {
    if (live.attachment === null) {
      for (const response of terminalProbeResponses(data, {
        cols: input.cols,
        rows: input.rows,
      })) {
        live.process.write(response);
      }
    }
    const visible = parser.push(data);
    if (visible.length === 0) return;
    appendVisible(visible);
  });
  pty.onExit((event) => {
    // `kill` marks and removes the process-local live entry before node-pty can
    // emit exit. No `Exited` for that callback, so GC/delete cleanup cannot
    // rewrite an already-terminal or already-deleted durable row; the stream
    // still ends, which lets the supervisor finish.
    if (live.suppressExitCallback || liveSessions.get(input.ptyProcessId) !== live) {
      Queue.endUnsafe(events);
      return;
    }
    live.running = false;
    // Release any bytes the parser was holding back as a potential partial
    // marker prefix so a mid-escape exit doesn't drop them from the log/replay
    // (mirrors tmux's push+flush on replay).
    const trailing = parser.flush();
    if (trailing.length > 0) appendVisible(trailing);
    const exit = {
      exitCode: event.exitCode ?? null,
      signal: event.signal ? String(event.signal) : null,
    };
    if (live.attachment) Queue.offerUnsafe(live.attachment.output, { type: 'exit', ...exit });
    liveSessions.delete(input.ptyProcessId);
    Queue.offerUnsafe(events, { _tag: 'Exited', ...exit });
    Queue.endUnsafe(events);
  });
  return {
    schemaVersion: 1,
    backend: 'node_pty',
    ptyProcessId: input.ptyProcessId,
    pid: pty.pid,
    shellIntegrationToken: input.shellIntegration?.token ?? null,
  } satisfies NodePtyBackendRef;
}

export function spawnNodePty(
  input: LaunchBackendSessionInput,
  spawn: NodePtySpawn = nodePty.spawn,
) {
  const launch = nodePtyLaunchCommand(input.command, input.args);
  return spawn(launch.command, launch.args, {
    name: 'xterm-256color',
    cols: input.cols,
    rows: input.rows,
    cwd: input.cwd,
    env: input.env,
  });
}

export function nodePtyLaunchCommand(command: string, args: readonly string[]) {
  return {
    command,
    args: [...args],
  };
}

export function terminalProbeResponses(
  data: string,
  size: { readonly cols: number; readonly rows: number },
) {
  const responses: Array<{ readonly index: number; readonly data: string }> = [];
  let offset = 0;
  while (offset < data.length) {
    const index = data.indexOf(ESC, offset);
    if (index === -1) break;
    const slice = data.slice(index);
    const response = terminalProbeResponse(slice, size);
    if (response) responses.push({ index, data: response });
    offset = index + 1;
  }
  return responses.sort((left, right) => left.index - right.index).map((response) => response.data);
}

const ESC = '\x1b';
const BEL = '\x07';
const ST = `${ESC}\\`;

function terminalProbeResponse(
  data: string,
  size: { readonly cols: number; readonly rows: number },
) {
  if (data.startsWith(`${ESC}[c`) || data.startsWith(`${ESC}[0c`)) return `${ESC}[?1;2c`;
  if (data.startsWith(`${ESC}[>c`) || data.startsWith(`${ESC}[>0c`)) return `${ESC}[>0;276;0c`;
  if (data.startsWith(`${ESC}[5n`)) return `${ESC}[0n`;
  if (data.startsWith(`${ESC}[6n`)) return `${ESC}[1;1R`;
  if (data.startsWith(`${ESC}[?6n`)) return `${ESC}[?1;1R`;
  if (data.startsWith(`${ESC}[18t`)) return `${ESC}[8;${size.rows};${size.cols}t`;
  if (data.startsWith(`${ESC}]10;?${BEL}`) || data.startsWith(`${ESC}]10;?${ST}`)) {
    return `${ESC}]10;${defaultTerminalColor('10')}${ST}`;
  }
  if (data.startsWith(`${ESC}]11;?${BEL}`) || data.startsWith(`${ESC}]11;?${ST}`)) {
    return `${ESC}]11;${defaultTerminalColor('11')}${ST}`;
  }
  return null;
}

function defaultTerminalColor(color: string) {
  return color === '10' ? 'rgb:cdd6/cdd6/f4f4' : 'rgb:1e1e/1e1e/2e2e';
}

// Returns the failure, if any, so the caller can enqueue it: this runs inside a node-pty callback, where no Effect
// (and so no logger) may run.
function appendBackendLog(path: string | null, data: string): unknown {
  if (!path) return null;
  try {
    appendFileSync(path, data, 'utf8');
    return null;
  } catch (error) {
    return error;
  }
}

function replayBackendLog(
  path: string | null,
  limitBytes: number | null,
  send: (message: import('@isagi/contracts').PtyStreamOutputMessageSet) => void,
) {
  return replayUtf8LogFile({
    logPath: path,
    bytes: limitBytes,
    send,
    failureMessage: 'Could not replay this session log.',
  });
}

function replayBytesForLog(path: string | null) {
  if (!path) {
    return null;
  }
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

const ensureNodePtyDarwinHelperExecutable = Effect.suspend(() => {
  const outcome = repairNodePtyDarwinHelper();
  switch (outcome._tag) {
    case 'Unchanged':
      return Effect.void;
    case 'Repaired':
      return Effect.logWarning('Repaired node-pty macOS spawn helper permissions').pipe(
        Effect.annotateLogs({ helper: outcome.helper }),
      );
    case 'Failed':
      return Effect.logWarning(
        'Could not inspect or repair node-pty macOS spawn helper permissions',
      ).pipe(Effect.annotateLogs({ cause: describeOperationalCause(outcome.cause) }));
  }
});

function repairNodePtyDarwinHelper():
  | { readonly _tag: 'Unchanged' }
  | { readonly _tag: 'Repaired'; readonly helper: string }
  | { readonly _tag: 'Failed'; readonly cause: unknown } {
  if (process.platform !== 'darwin') return { _tag: 'Unchanged' };
  try {
    const helper = findNodePtySpawnHelper();
    if (!helper) return { _tag: 'Unchanged' };
    try {
      accessSync(helper, constants.X_OK);
      return { _tag: 'Unchanged' };
    } catch {
      const mode = statSync(helper).mode;
      chmodSync(helper, mode | 0o111);
      return { _tag: 'Repaired', helper };
    }
  } catch (cause) {
    return { _tag: 'Failed', cause };
  }
}

function findNodePtySpawnHelper() {
  const require = createRequire(import.meta.url);
  const packageJson = require.resolve('node-pty/package.json');
  const packageRoot = dirname(packageJson);
  const candidates = [
    join(packageRoot, 'build', 'Release', 'spawn-helper'),
    join(packageRoot, 'build', 'Debug', 'spawn-helper'),
  ];

  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // Keep looking; package layouts vary by install method.
    }
  }

  return findFileByName(packageRoot, 'spawn-helper', 4);
}

function findFileByName(root: string, name: string, maxDepth: number): string | null {
  if (maxDepth < 0) {
    return null;
  }

  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isFile() && entry.name === name) {
      return path;
    }
    if (entry.isDirectory()) {
      const found = findFileByName(path, name, maxDepth - 1);
      if (found) {
        return found;
      }
    }
  }

  return null;
}
