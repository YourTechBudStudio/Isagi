import { accessSync, appendFileSync, chmodSync, constants, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import process from 'node:process';

import { Context, Effect, Layer } from 'effect';
import * as nodePty from 'node-pty';

import { replayUtf8LogFile } from '../log-replay.js';
import {
  createShellIntegrationParser,
  foregroundStateFromEvent,
} from '../service/shell-integration.js';
import type {
  BackendAttachment,
  LaunchBackendSessionInput,
  NodePtyBackendRef,
  PtyBackend as PtyBackendShape,
} from '../types.js';
import { PtyKillError, PtyResizeError, PtyStartError, PtyWriteError } from '../types.js';
import { collectNodePtyGarbage } from './node-pty-gc.js';

interface LiveNodePtyProcess {
  readonly ptyProcessId: number;
  readonly process: nodePty.IPty;
  readonly logPath: string | null;
  attachment: NodePtyAttachment | null;
  running: boolean;
  suppressExitCallback: boolean;
}

interface NodePtyAttachment {
  readonly id: symbol;
  readonly onOutput: (data: string) => void;
  readonly onExit: (exit: {
    readonly exitCode: number | null;
    readonly signal: string | null;
  }) => void;
}

export const NodePtyBackend = Context.GenericTag<PtyBackendShape>('isagi/NodePtyBackend');

export const NodePtyBackendLive = Layer.effect(
  NodePtyBackend,
  Effect.sync(() => {
    ensureNodePtyDarwinHelperExecutable();
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
      launch: (input) =>
        Effect.try({
          try: () => {
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
                input.onForegroundCommand?.({
                  ptyProcessId: input.ptyProcessId,
                  state: foregroundStateFromEvent(event),
                }),
            });
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
              appendBackendLog(input.logPath, visible, input.ptyProcessId);
              live.attachment?.onOutput(visible);
            });
            pty.onExit((event) => {
              // `kill` marks and removes the process-local live entry before
              // node-pty can emit exit. Ignore that callback so GC/delete cleanup
              // cannot rewrite an already-terminal or already-deleted durable row.
              if (live.suppressExitCallback || liveSessions.get(input.ptyProcessId) !== live) {
                return;
              }
              live.running = false;
              // Release any bytes the parser was holding back as a potential
              // partial marker prefix so a mid-escape exit doesn't drop them from
              // the log/replay (mirrors tmux's push+flush on replay).
              const trailing = parser.flush();
              if (trailing.length > 0) {
                appendBackendLog(input.logPath, trailing, input.ptyProcessId);
                live.attachment?.onOutput(trailing);
              }
              const exit = {
                exitCode: event.exitCode ?? null,
                signal: event.signal ? String(event.signal) : null,
              };
              live.attachment?.onExit(exit);
              liveSessions.delete(input.ptyProcessId);
              input.onExit(exit);
            });
            return {
              schemaVersion: 1,
              backend: 'node_pty',
              ptyProcessId: input.ptyProcessId,
              pid: pty.pid,
              shellIntegrationToken: input.shellIntegration?.token ?? null,
            } satisfies NodePtyBackendRef;
          },
          catch: (cause) =>
            new PtyStartError({
              ptyProcessId: input.ptyProcessId,
              command: input.command,
              cwd: input.cwd,
              cause,
            }),
        }),
      attach: (input) =>
        Effect.try({
          try: () => {
            if (input.ref.backend !== 'node_pty') {
              throw new Error(`Cannot attach node-pty backend to ${input.ref.backend} ref.`);
            }
            const ref = input.ref;
            const live = liveSessions.get(ref.ptyProcessId);
            if (!live?.running) {
              throw new Error(`node-pty process ${ref.ptyProcessId} is not live.`);
            }
            live.process.resize(input.cols, input.rows);
            const attachment = {
              id: Symbol(`node-pty-attachment-${ref.ptyProcessId}`),
              onOutput: input.onOutput,
              onExit: input.onSessionExit,
            } satisfies NodePtyAttachment;
            live.attachment = attachment;
            return {
              replayBytes: replayBytesForLog(live.logPath),
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
              detach: Effect.sync(() => {
                if (live.attachment?.id === attachment.id) {
                  live.attachment = null;
                }
              }),
            } satisfies BackendAttachment;
          },
          catch: (cause) =>
            new PtyStartError({
              ptyProcessId: input.ref.backend === 'node_pty' ? input.ref.ptyProcessId : undefined,
              command: 'node_pty_attach',
              cwd: '',
              cause,
            }),
        }),
      writeInput: (input) =>
        Effect.try({
          try: () => {
            if (input.ref.backend !== 'node_pty') {
              throw new Error(`Cannot write node-pty input to ${input.ref.backend} ref.`);
            }
            const ref = input.ref;
            const live = liveSessions.get(ref.ptyProcessId);
            if (!live?.running) {
              throw new Error(`node-pty process ${ref.ptyProcessId} is not live.`);
            }
            live.process.write(input.data);
          },
          catch: (cause) =>
            new PtyWriteError({
              ptyProcessId: input.ref.backend === 'node_pty' ? input.ref.ptyProcessId : undefined,
              cause,
            }),
        }),
      replay: (input) => replayBackendLog(input.logPath, input.bytes, input.send),
      inspect: (ref) =>
        Effect.succeed(
          ref.backend === 'node_pty' && liveSessions.get(ref.ptyProcessId)?.running
            ? { status: 'alive' as const }
            : { status: 'missing' as const },
        ),
      listSessions,
      collectGarbage: (input) => collectNodePtyGarbage(input, listSessions),
      terminate: (input) =>
        Effect.tryPromise({
          try: async () => {
            const ref = input.ref;
            if (ref.backend !== 'node_pty') {
              throw new Error(`Cannot terminate node-pty backend for ${ref.backend} ref.`);
            }
            const live = liveSessions.get(ref.ptyProcessId);
            if (!live) {
              return;
            }
            try {
              live.process.kill('SIGTERM');
            } catch {
              live.process.kill();
              return;
            }
            await delay(input.gracefulTimeoutMs);
            const current = liveSessions.get(ref.ptyProcessId);
            if (current?.running) {
              current.suppressExitCallback = true;
              liveSessions.delete(ref.ptyProcessId);
              current.process.kill('SIGKILL');
            }
          },
          catch: (cause) =>
            new PtyKillError({
              ptyProcessId: input.ref.backend === 'node_pty' ? input.ref.ptyProcessId : undefined,
              cause,
            }),
        }),
      kill: (ref) =>
        Effect.try({
          try: () => {
            if (ref.backend !== 'node_pty') {
              throw new Error(`Cannot kill node-pty backend for ${ref.backend} ref.`);
            }
            const nodeRef = ref;
            const live = liveSessions.get(nodeRef.ptyProcessId);
            if (!live) {
              return;
            }
            live.suppressExitCallback = true;
            liveSessions.delete(nodeRef.ptyProcessId);
            try {
              live.process.kill();
            } catch (error) {
              live.suppressExitCallback = false;
              if (live.running) {
                liveSessions.set(nodeRef.ptyProcessId, live);
              }
              throw error;
            }
          },
          catch: (cause) =>
            new PtyKillError({
              ptyProcessId: ref.backend === 'node_pty' ? ref.ptyProcessId : undefined,
              cause,
            }),
        }),
    } satisfies PtyBackendShape;
  }),
);

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type NodePtySpawn = typeof nodePty.spawn;

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

function appendBackendLog(path: string | null, data: string, ptyProcessId: number) {
  if (!path) {
    return;
  }
  try {
    appendFileSync(path, data, 'utf8');
  } catch (error) {
    console.error(`[runtime] Failed to append PTY output for session ${ptyProcessId}`, error);
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

function ensureNodePtyDarwinHelperExecutable() {
  if (process.platform !== 'darwin') {
    return;
  }

  try {
    const helper = findNodePtySpawnHelper();
    if (!helper) {
      return;
    }

    try {
      accessSync(helper, constants.X_OK);
      return;
    } catch {
      const mode = statSync(helper).mode;
      chmodSync(helper, mode | 0o111);
      console.warn(`[runtime] Repaired node-pty macOS spawn helper permissions: ${helper}`);
    }
  } catch (error) {
    console.warn(
      '[runtime] Could not inspect or repair node-pty macOS spawn helper permissions',
      error,
    );
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
