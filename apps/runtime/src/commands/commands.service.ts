import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';

import { Context, Data, Effect, Either, Layer } from 'effect';

import type {
  CommandActionOutput,
  CommandLogsOutput,
  CommandStatus,
  WorktreeCommandsOutput,
  WorktreeCommandsRejectionReason,
} from '@isagi/contracts';

import { DataDirectory, type DatabaseError } from '../persistence/index.js';
import type { WorktreeCommandConfig } from '../project-config/command-config.schema.js';
import { loadWorktreeCommandCatalog } from '../project-config/project-config.service.js';
import { PtyRepository, PtyService, type PtyServiceShape } from '../pty-processes/index.js';
import {
  nextRuntimeEventEnvelope,
  RuntimeEventBus,
  type RuntimeEventBusService,
} from '../runtime-events/event-bus.js';
import { InternalRuntimeEventBus } from '../runtime-events/internal-event-bus.js';
import { WorkspaceRepository } from '../workspace/index.js';
import { CommandRepository, type CommandRepositoryService } from './commands.repository.js';
import { parseDotenv } from './dotenv.js';

export class CommandError extends Data.TaggedError('CommandError')<{
  readonly code: WorktreeCommandsRejectionReason;
  readonly message: string;
  readonly worktreeId?: number | undefined;
  readonly commandName?: string | undefined;
  readonly cause?: unknown;
}> {}

export type CommandServiceError = CommandError | DatabaseError;

export interface CommandService {
  readonly listForWorktree: (
    worktreeId: number,
  ) => Effect.Effect<WorktreeCommandsOutput, CommandServiceError>;
  readonly readLatestLogs: (input: {
    readonly worktreeId: number;
    readonly commandName: string;
  }) => Effect.Effect<CommandLogsOutput, CommandServiceError>;
  readonly run: (input: {
    readonly worktreeId: number;
    readonly commandName: string;
  }) => Effect.Effect<CommandActionOutput, CommandServiceError>;
  readonly stop: (input: {
    readonly worktreeId: number;
    readonly commandName: string;
  }) => Effect.Effect<CommandActionOutput, CommandServiceError>;
  readonly restart: (input: {
    readonly worktreeId: number;
    readonly commandName: string;
  }) => Effect.Effect<CommandActionOutput, CommandServiceError>;
}

export const CommandService = Context.GenericTag<CommandService>('isagi/CommandService');

const commandStopGracefulTimeoutMs = 2_000;

export const CommandServiceLive = Layer.scoped(
  CommandService,
  Effect.gen(function* () {
    const workspaceRepository = yield* WorkspaceRepository;
    const commandRepository = yield* CommandRepository;
    const ptyRepository = yield* PtyRepository;
    const pty = yield* PtyService;
    const dataDirectory = yield* DataDirectory;
    const publicEvents = yield* RuntimeEventBus;
    const internalEvents = yield* InternalRuntimeEventBus;
    const commandLogsPath = join(dataDirectory.paths.root, 'command-logs');
    const locks = new Map<string, Promise<void>>();

    mkdirSync(commandLogsPath, { recursive: true });
    yield* cleanupOrphanCommandLogs(commandRepository, commandLogsPath).pipe(Effect.ignore);

    const subscription = yield* internalEvents.subscribe({
      types: ['pty_process_exited', 'pty_process_failed', 'pty_process_killed'],
    });
    yield* Effect.addFinalizer(() => subscription.unsubscribe);
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.gen(function* () {
          const event = yield* subscription.take;
          if (
            event.type !== 'pty_process_exited' &&
            event.type !== 'pty_process_failed' &&
            event.type !== 'pty_process_killed'
          ) {
            return;
          }
          const status =
            event.type === 'pty_process_exited'
              ? 'exited'
              : event.type === 'pty_process_killed' && event.statusReason === 'user_requested'
                ? 'stopped'
                : 'failed';
          const run = yield* commandRepository.completeRunByPtyProcess({
            ptyProcessId: event.ptyProcessId,
            status,
            exitCode: event.type === 'pty_process_exited' ? event.exitCode : null,
            signal: event.type === 'pty_process_exited' ? event.signal : null,
          });
          if (!run) return;
          const state = yield* commandRepository.findState({
            worktreeId: run.worktreeId,
            commandName: run.commandName,
          });
          if (state?.activePtyProcessId === event.ptyProcessId) {
            yield* commandRepository.transitionState({
              worktreeId: run.worktreeId,
              commandName: run.commandName,
              status,
              activePtyProcessId: null,
            });
          }
          yield* publishCommandChanged(publicEvents, run.worktreeId, run.commandName);
        }).pipe(
          Effect.catchAll((error) =>
            Effect.sync(() => {
              console.warn('[runtime] Command process event reconciliation failed', error);
            }),
          ),
        ),
      ),
    );

    const service = {
      listForWorktree: (worktreeId) =>
        Effect.gen(function* () {
          const target = yield* loadCommandTarget(workspaceRepository, worktreeId);
          const catalog = yield* loadWorktreeCommandCatalog({
            worktreeRootPath: target.worktree.path,
          });

          if (catalog.status === 'config_error') {
            return {
              status: 'config_error',
              worktreeId,
              diagnostic: catalog.diagnostic,
            } satisfies WorktreeCommandsOutput;
          }

          const states = yield* commandRepository.listStatesForWorktree(worktreeId);
          const stateByName = new Map(states.map((state) => [state.commandName, state]));
          return {
            status: 'configured',
            worktreeId,
            commands: catalog.config.commands.map((command) => ({
              name: command.name,
              status: stateByName.get(command.name)?.status ?? 'idle',
              ports: stateByName.get(command.name)?.status === 'running' ? [...command.ports] : [],
            })),
          } satisfies WorktreeCommandsOutput;
        }),
      readLatestLogs: (input) =>
        Effect.gen(function* () {
          yield* resolveConfiguredCommand(workspaceRepository, input);
          const state = yield* commandRepository.findState(input);
          const run = yield* commandRepository.findLatestRun(input);
          return {
            worktreeId: input.worktreeId,
            commandName: input.commandName,
            status: state?.status ?? 'idle',
            latestRun: run
              ? {
                  startedAt: run.startedAt,
                  completedAt: run.completedAt,
                  command: run.commandText,
                  cwd: run.cwd,
                  text: readLogText(run.logPath),
                }
              : null,
          } satisfies CommandLogsOutput;
        }),
      run: (input) =>
        withCommandLock(
          locks,
          input,
          runCommand({
            commandRepository,
            ptyRepository,
            pty,
            publicEvents,
            workspaceRepository,
            commandLogsPath,
            input,
            trigger: 'manual_run',
          }),
        ),
      stop: (input) =>
        withCommandLock(
          locks,
          input,
          stopCommand({
            commandRepository,
            pty,
            publicEvents,
            workspaceRepository,
            input,
          }),
        ),
      restart: (input) =>
        withCommandLock(
          locks,
          input,
          stopCommand({
            commandRepository,
            pty,
            publicEvents,
            workspaceRepository,
            input,
            suppressChangedEvent: true,
          }).pipe(
            Effect.zipRight(
              runCommand({
                commandRepository,
                ptyRepository,
                pty,
                publicEvents,
                workspaceRepository,
                commandLogsPath,
                input,
                trigger: 'manual_restart',
              }),
            ),
          ),
        ),
    } satisfies CommandService;

    return service;
  }),
);

function runCommand(input: {
  readonly commandRepository: CommandRepositoryService;
  readonly ptyRepository: import('../pty-processes/pty.repository.js').PtyRepositoryService;
  readonly pty: PtyServiceShape;
  readonly publicEvents: RuntimeEventBusService;
  readonly workspaceRepository: import('../workspace/index.js').WorkspaceRepositoryService;
  readonly commandLogsPath: string;
  readonly input: { readonly worktreeId: number; readonly commandName: string };
  readonly trigger: 'manual_run' | 'manual_restart';
}) {
  return Effect.gen(function* () {
    const target = yield* resolveConfiguredCommand(input.workspaceRepository, input.input);
    const current = yield* input.commandRepository.findState(input.input);
    if (current?.status === 'running') {
      return actionOutput(target.command, current.status, target.worktree.id);
    }

    const cwd = resolve(target.worktree.path, target.command.cwd ?? '.');
    if (!directoryExists(cwd)) {
      return yield* failedRun(
        input,
        target,
        `[isagi] Missing command cwd: ${target.command.cwd ?? '.'}\n`,
      );
    }

    const envResult = yield* buildCommandEnv(target.worktree.path, target.command).pipe(
      Effect.either,
    );
    if (Either.isLeft(envResult)) {
      return yield* failedRun(input, target, `[isagi] ${envResult.left.message}\n`);
    }

    const run = yield* input.commandRepository.createRun({
      worktreeId: target.worktree.id,
      commandName: target.command.name,
      commandText: target.command.command,
      cwd,
      trigger: input.trigger,
      status: 'running',
    });
    yield* input.commandRepository.transitionState({
      worktreeId: target.worktree.id,
      commandName: target.command.name,
      status: 'running',
      activePtyProcessId: null,
    });

    const shell = process.env.SHELL && process.env.SHELL.trim() ? process.env.SHELL : '/bin/sh';
    const launch = yield* input.pty
      .launch({
        command: shell,
        args: ['-lc', target.command.command],
        cwd,
        env: envResult.right,
        shellIntegration: false,
      })
      .pipe(Effect.either);

    if (Either.isLeft(launch)) {
      const logPath = commandLogPath(input.commandLogsPath, run.id);
      appendFileSync(logPath, `[isagi] Command launch failed before PTY metadata was available.\n`);
      yield* input.commandRepository.completeRun({ runId: run.id, status: 'failed' });
      yield* input.commandRepository.transitionState({
        worktreeId: target.worktree.id,
        commandName: target.command.name,
        status: 'failed',
        activePtyProcessId: null,
      });
      yield* publishCommandChanged(input.publicEvents, target.worktree.id, target.command.name);
      return actionOutput(target.command, 'failed', target.worktree.id);
    }

    yield* input.commandRepository.updateRunPty({
      runId: run.id,
      ptyProcessId: launch.right.ptyProcessId,
      logPath: launch.right.logPath,
    });
    const processRow = yield* input.ptyRepository.findProcess(launch.right.ptyProcessId);
    if (processRow?.status === 'failed') {
      yield* input.commandRepository.completeRun({
        runId: run.id,
        status: 'failed',
        exitCode: processRow.exitCode,
        signal: processRow.signal,
      });
      yield* input.commandRepository.transitionState({
        worktreeId: target.worktree.id,
        commandName: target.command.name,
        status: 'failed',
        activePtyProcessId: null,
      });
      yield* publishCommandChanged(input.publicEvents, target.worktree.id, target.command.name);
      return actionOutput(target.command, 'failed', target.worktree.id);
    }

    yield* input.commandRepository.transitionState({
      worktreeId: target.worktree.id,
      commandName: target.command.name,
      status: 'running',
      activePtyProcessId: launch.right.ptyProcessId,
    });
    yield* publishCommandChanged(input.publicEvents, target.worktree.id, target.command.name);
    return actionOutput(target.command, 'running', target.worktree.id);
  });
}

function stopCommand(input: {
  readonly commandRepository: CommandRepositoryService;
  readonly pty: PtyServiceShape;
  readonly publicEvents: RuntimeEventBusService;
  readonly workspaceRepository: import('../workspace/index.js').WorkspaceRepositoryService;
  readonly input: { readonly worktreeId: number; readonly commandName: string };
  readonly suppressChangedEvent?: boolean | undefined;
}) {
  return Effect.gen(function* () {
    const target = yield* resolveConfiguredCommand(input.workspaceRepository, input.input);
    const state = yield* input.commandRepository.findState(input.input);
    if (!state || state.status !== 'running' || !state.activePtyProcessId) {
      return actionOutput(target.command, state?.status ?? 'idle', target.worktree.id);
    }

    const terminate = yield* input.pty
      .terminate({
        ptyProcessId: state.activePtyProcessId,
        gracefulTimeoutMs: commandStopGracefulTimeoutMs,
      })
      .pipe(Effect.either);
    if (Either.isLeft(terminate)) {
      return yield* Effect.fail(
        new CommandError({
          code: 'command_action_failed',
          message: `Could not stop command ${target.command.name}.`,
          worktreeId: target.worktree.id,
          commandName: target.command.name,
          cause: terminate.left,
        }),
      );
    }

    yield* input.commandRepository.completeRunByPtyProcess({
      ptyProcessId: state.activePtyProcessId,
      status: 'stopped',
    });
    yield* input.commandRepository.transitionState({
      worktreeId: target.worktree.id,
      commandName: target.command.name,
      status: 'stopped',
      activePtyProcessId: null,
    });
    if (!input.suppressChangedEvent) {
      yield* publishCommandChanged(input.publicEvents, target.worktree.id, target.command.name);
    }
    return actionOutput(target.command, 'stopped', target.worktree.id);
  });
}

function failedRun(
  input: {
    readonly commandRepository: CommandRepositoryService;
    readonly publicEvents: RuntimeEventBusService;
    readonly commandLogsPath: string;
    readonly trigger: 'manual_run' | 'manual_restart';
  },
  target: CommandTarget,
  message: string,
) {
  return Effect.gen(function* () {
    const logPath = commandLogPath(input.commandLogsPath);
    appendFileSync(logPath, message);
    yield* input.commandRepository.createRun({
      worktreeId: target.worktree.id,
      commandName: target.command.name,
      commandText: target.command.command,
      cwd: resolve(target.worktree.path, target.command.cwd ?? '.'),
      trigger: input.trigger,
      status: 'failed',
      logPath,
      completedAt: new Date().toISOString(),
    });
    yield* input.commandRepository.transitionState({
      worktreeId: target.worktree.id,
      commandName: target.command.name,
      status: 'failed',
      activePtyProcessId: null,
    });
    yield* publishCommandChanged(input.publicEvents, target.worktree.id, target.command.name);
    return actionOutput(target.command, 'failed', target.worktree.id);
  });
}

interface CommandTarget {
  readonly worktree: { readonly id: number; readonly path: string };
  readonly command: WorktreeCommandConfig;
}

function resolveConfiguredCommand(
  workspaceRepository: import('../workspace/index.js').WorkspaceRepositoryService,
  input: { readonly worktreeId: number; readonly commandName: string },
): Effect.Effect<CommandTarget, CommandServiceError> {
  return Effect.gen(function* () {
    const target = yield* loadCommandTarget(workspaceRepository, input.worktreeId);
    const catalog = yield* loadWorktreeCommandCatalog({ worktreeRootPath: target.worktree.path });
    if (catalog.status === 'config_error') {
      return yield* Effect.fail(
        new CommandError({
          code: 'command_config_invalid',
          message: catalog.diagnostic.message,
          worktreeId: input.worktreeId,
          commandName: input.commandName,
        }),
      );
    }
    const command = catalog.config.commands.find(
      (candidate) => candidate.name === input.commandName,
    );
    if (!command) {
      return yield* Effect.fail(
        new CommandError({
          code: 'command_not_found',
          message: `Command ${input.commandName} was not found.`,
          worktreeId: input.worktreeId,
          commandName: input.commandName,
        }),
      );
    }
    return { worktree: target.worktree, command };
  });
}

function loadCommandTarget(
  workspaceRepository: import('../workspace/index.js').WorkspaceRepositoryService,
  worktreeId: number,
) {
  return Effect.gen(function* () {
    const worktree = yield* workspaceRepository.findWorktree(worktreeId);
    if (!worktree) {
      return yield* Effect.fail(
        new CommandError({
          code: 'worktree_not_found',
          message: `Worktree ${worktreeId} was not found.`,
          worktreeId,
        }),
      );
    }
    return { worktree };
  });
}

function buildCommandEnv(worktreeRoot: string, command: WorktreeCommandConfig) {
  return Effect.gen(function* () {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const envFile of command.envFiles) {
      const path = resolve(worktreeRoot, envFile);
      if (!existsSync(path)) {
        return yield* Effect.fail(new Error(`Missing env file: ${envFile}`));
      }
      const contents = yield* Effect.tryPromise({
        try: () => readFile(path, 'utf8'),
        catch: (cause) => new Error(`Could not read env file ${envFile}: ${String(cause)}`),
      });
      Object.assign(env, parseDotenv(contents));
    }
    Object.assign(env, command.env);
    return env;
  });
}

function withCommandLock<A, E, R>(
  locks: Map<string, Promise<void>>,
  input: { readonly worktreeId: number; readonly commandName: string },
  effect: Effect.Effect<A, E, R>,
) {
  const key = `${input.worktreeId}\u0000${input.commandName}`;
  return Effect.acquireUseRelease(
    Effect.promise(async () => {
      const previous = locks.get(key) ?? Promise.resolve();
      let release!: () => void;
      const current = new Promise<void>((resolveRelease) => {
        release = resolveRelease;
      });
      locks.set(
        key,
        previous.then(() => current),
      );
      await previous;
      return { release, current };
    }),
    () => effect,
    ({ release, current }) =>
      Effect.sync(() => {
        release();
        if (locks.get(key) === current) {
          locks.delete(key);
        }
      }),
  );
}

function actionOutput(
  command: WorktreeCommandConfig,
  status: CommandStatus,
  worktreeId: number,
): CommandActionOutput {
  return {
    worktreeId,
    commandName: command.name,
    summary: {
      name: command.name,
      status,
      ports: status === 'running' ? [...command.ports] : [],
    },
  };
}

function publishCommandChanged(
  publicEvents: RuntimeEventBusService,
  worktreeId: number,
  commandName: string,
) {
  return publicEvents.publish({
    ...nextRuntimeEventEnvelope(),
    type: 'command_changed',
    payload: { worktreeId, commandName },
  });
}

function directoryExists(path: string) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function commandLogPath(commandLogsPath: string, runId?: number) {
  return join(commandLogsPath, `${runId ?? randomUUID()}.log`);
}

function readLogText(path: string | null) {
  if (!path) return '';
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '[isagi] Command log is missing.\n';
  }
}

function cleanupOrphanCommandLogs(
  commandRepository: CommandRepositoryService,
  commandLogsPath: string,
) {
  return Effect.gen(function* () {
    const referenced = new Set(yield* commandRepository.listReferencedCommandLogPaths);
    const entries = readdirSync(commandLogsPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.log')) continue;
      const path = join(commandLogsPath, entry.name);
      if (referenced.has(path)) continue;
      try {
        unlinkSync(path);
      } catch (error) {
        console.warn(`[runtime] Could not delete orphan command log ${entry.name}`, error);
      }
    }
  });
}
