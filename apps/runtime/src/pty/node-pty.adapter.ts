import {
  accessSync,
  appendFileSync,
  chmodSync,
  closeSync,
  constants,
  openSync,
  readSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import process from 'node:process';

import { Context, Effect, Layer } from 'effect';
import * as nodePty from 'node-pty';

import type {
  BackendAttachment,
  NodePtyBackendRef,
  PtyBackend as PtyBackendShape,
} from './types.js';
import {
  PtyKillError,
  PtyResizeError,
  PtyServiceError,
  PtyStartError,
  PtyWriteError,
} from './types.js';

const replayChunkBytes = 64 * 1024;

interface LiveNodePtySession {
  readonly ptySessionId: number;
  readonly process: nodePty.IPty;
  readonly logPath: string | null;
  attachment: NodePtyAttachment | null;
  running: boolean;
}

interface NodePtyAttachment {
  readonly id: symbol;
  readonly onOutput: (data: string) => void;
  readonly onExit: (exit: {
    readonly exitCode: number | null;
    readonly signal: string | null;
  }) => void;
}

export const PtyBackend = Context.GenericTag<PtyBackendShape>('isagi/PtyBackend');

export const NodePtyBackendLive = Layer.effect(
  PtyBackend,
  Effect.sync(() => {
    ensureNodePtyDarwinHelperExecutable();
    const liveSessions = new Map<number, LiveNodePtySession>();

    return {
      name: 'node_pty',
      available: Effect.succeed(true),
      launch: (input) =>
        Effect.try({
          try: () => {
            const pty = nodePty.spawn(input.command, [], {
              name: 'xterm-256color',
              cols: input.cols,
              rows: input.rows,
              cwd: input.cwd,
              env: input.env,
            });
            const live: LiveNodePtySession = {
              ptySessionId: input.ptySessionId,
              process: pty,
              logPath: input.logPath,
              attachment: null,
              running: true,
            };
            liveSessions.set(input.ptySessionId, live);
            pty.onData((data) => {
              appendBackendLog(input.logPath, data, input.ptySessionId);
              live.attachment?.onOutput(data);
            });
            pty.onExit((event) => {
              live.running = false;
              const exit = {
                exitCode: event.exitCode ?? null,
                signal: event.signal ? String(event.signal) : null,
              };
              live.attachment?.onExit(exit);
              liveSessions.delete(input.ptySessionId);
              input.onExit(exit);
            });
            return {
              schemaVersion: 1,
              backend: 'node_pty',
              ptySessionId: input.ptySessionId,
              pid: pty.pid,
            } satisfies NodePtyBackendRef;
          },
          catch: (cause) =>
            new PtyStartError({
              ptySessionId: input.ptySessionId,
              command: input.command,
              cwd: input.cwd,
              cause,
            }),
        }),
      attach: (input) =>
        Effect.try({
          try: () => {
            const live = liveSessions.get(input.ref.ptySessionId);
            if (!live?.running) {
              throw new Error(`node-pty session ${input.ref.ptySessionId} is not live.`);
            }
            live.process.resize(input.cols, input.rows);
            const attachment = {
              id: Symbol(`node-pty-attachment-${input.ref.ptySessionId}`),
              onOutput: input.onOutput,
              onExit: input.onExit,
            } satisfies NodePtyAttachment;
            live.attachment = attachment;
            return {
              write: (data) =>
                Effect.try({
                  try: () => live.process.write(data),
                  catch: (cause) =>
                    new PtyWriteError({ ptySessionId: input.ref.ptySessionId, cause }),
                }),
              resize: (size) =>
                Effect.try({
                  try: () => live.process.resize(size.cols, size.rows),
                  catch: (cause) =>
                    new PtyResizeError({ ptySessionId: input.ref.ptySessionId, cause }),
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
              ptySessionId: input.ref.ptySessionId,
              command: 'node_pty_attach',
              cwd: '',
              cause,
            }),
        }),
      replay: (input) => replayBackendLog(input.logPath, input.bytes, input.send),
      inspect: (ref) =>
        Effect.succeed({
          alive: Boolean(liveSessions.get(ref.ptySessionId)?.running),
        }),
      kill: (ref) =>
        Effect.try({
          try: () => {
            const live = liveSessions.get(ref.ptySessionId);
            if (!live) {
              return;
            }
            live.process.kill();
            liveSessions.delete(ref.ptySessionId);
          },
          catch: (cause) => new PtyKillError({ ptySessionId: ref.ptySessionId, cause }),
        }),
    } satisfies PtyBackendShape;
  }),
);

function appendBackendLog(path: string | null, data: string, ptySessionId: number) {
  if (!path) {
    return;
  }
  try {
    appendFileSync(path, data, 'utf8');
  } catch (error) {
    console.error(`[runtime] Failed to append PTY output for session ${ptySessionId}`, error);
  }
}

function replayBackendLog(
  path: string | null,
  limitBytes: number | null,
  send: (message: import('@isagi/contracts').PtyWebSocketOutputMessage) => void,
) {
  return Effect.try({
    try: () => {
      const bytes = path ? (limitBytes ?? statSync(path).size) : 0;
      send({ type: 'replay_start', bytes });
      if (path && bytes > 0) {
        const fd = openSync(path, 'r');
        try {
          const buffer = Buffer.allocUnsafe(Math.min(replayChunkBytes, bytes));
          let offset = 0;
          while (offset < bytes) {
            const toRead = Math.min(buffer.byteLength, bytes - offset);
            const read = readSync(fd, buffer, 0, toRead, offset);
            if (read <= 0) {
              break;
            }
            offset += read;
            send({ type: 'output', data: buffer.toString('utf8', 0, read), replay: true });
          }
        } finally {
          closeSync(fd);
        }
      }
      send({ type: 'replay_end' });
    },
    catch: (cause) =>
      new PtyServiceError({
        code: 'log_read_failed',
        message: 'Could not replay this session log.',
        cause,
      }),
  });
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
