import { spawn, spawnSync } from 'node:child_process';
import process from 'node:process';

import { developmentProtocolVersion } from './dev-protocol.mjs';
import { exitCodeForResult } from './policy.mjs';

const defaultShutdownGraceMs = 10_000;
const ownedTreeExitTimeoutMs = 30_000;

export function runStackOwner({
  command,
  args,
  cwd,
  env = process.env,
  spawnChild = spawn,
  signalProcess = process,
  stdio = ['pipe', 'inherit', 'inherit', 'ipc'],
  shutdownGraceMs = defaultShutdownGraceMs,
  terminateOwnedTree = killOwnedTree,
}) {
  return new Promise((resolve, reject) => {
    const controller = spawnChild(command, args, {
      cwd,
      detached: process.platform !== 'win32',
      env,
      stdio,
    });
    let selectedExitCode;
    let hardKillTimer;
    let terminationPromise;
    const ownedProcessIds = new Set();

    const terminate = () => {
      terminationPromise ??= Promise.resolve().then(() =>
        terminateOwnedTree(controller, ownedProcessIds),
      );
      // The controller exit handler awaits and reports this promise. Attach a
      // handler immediately so a fast termination failure is never unhandled.
      void terminationPromise.catch(() => {});
      return terminationPromise;
    };

    const stop = (signal, exitCode) => {
      selectedExitCode ??= exitCode;
      signalController(controller, signal);
      hardKillTimer ??= setTimeout(() => void terminate(), shutdownGraceMs);
      hardKillTimer.unref();
    };
    let interruptCount = 0;
    const onInterrupt = () => {
      interruptCount += 1;
      if (interruptCount > 1) {
        void terminate();
        return;
      }
      stop('SIGINT', 130);
      signalProcess.once('SIGINT', onInterrupt);
    };
    const onTerminate = () => stop('SIGTERM', 143);
    signalProcess.once('SIGINT', onInterrupt);
    signalProcess.once('SIGTERM', onTerminate);
    controller.on('message', (message) => observeOwnedProcessMessage(message, ownedProcessIds));

    controller.once('error', (error) => {
      void finish(() => reject(error));
    });
    controller.once('exit', (code, signal) => {
      // The controller is the process-group leader on POSIX. Killing the group
      // after it exits is the crash fallback that removes descendants which did
      // not participate in graceful shutdown.
      void finish(() => resolve(selectedExitCode ?? exitCodeForResult({ code, signal })));
    });

    async function finish(complete) {
      try {
        await terminate();
        cleanup();
        complete();
      } catch (error) {
        cleanup();
        reject(error);
      }
    }

    function cleanup() {
      if (hardKillTimer) clearTimeout(hardKillTimer);
      signalProcess.off('SIGINT', onInterrupt);
      signalProcess.off('SIGTERM', onTerminate);
      controller.stdin?.destroy();
    }
  });
}

function signalController(controller, signal) {
  if (!controller.pid || controller.exitCode !== null || controller.signalCode !== null) return;
  try {
    controller.kill(signal);
  } catch (error) {
    if (!isMissingProcess(error)) throw error;
  }
}

async function killOwnedTree(controller, ownedProcessIds) {
  if (!controller.pid) return;
  const plan = ownedTreeTerminationPlan(controller.pid, ownedProcessIds, process.platform);
  try {
    if (plan.kind === 'windows-pid-trees') {
      // Windows has no POSIX process group. The controller registers each
      // top-level child over its private IPC channel so the owner can terminate
      // every tree even after the controller itself has crashed.
      for (const args of plan.taskkillArguments) {
        spawnSync('taskkill', args, { stdio: 'ignore' });
      }
    } else {
      process.kill(plan.processGroupPid, 'SIGKILL');
    }
  } catch (error) {
    if (!isMissingProcess(error)) throw error;
  }
  const survivingProcessIds = await waitForOwnedTreeExit(plan);
  if (survivingProcessIds.length > 0) {
    console.error(
      `[dev] owned processes survived SIGKILL after ${ownedTreeExitTimeoutMs}ms: ${survivingProcessIds.join(', ')}`,
    );
  }
}

export async function waitForOwnedTreeExit(
  plan,
  {
    timeoutMs = ownedTreeExitTimeoutMs,
    now = Date.now,
    poll = () => new Promise((resolvePromise) => setTimeout(resolvePromise, 25)),
    aliveProcessIds = ownedTreeAliveProcessIds,
  } = {},
) {
  const deadline = now() + timeoutMs;
  let survivingProcessIds = aliveProcessIds(plan);
  while (survivingProcessIds.length > 0 && now() < deadline) {
    await poll();
    survivingProcessIds = aliveProcessIds(plan);
  }
  return survivingProcessIds;
}

function ownedTreeAliveProcessIds(plan) {
  const pids =
    plan.kind === 'windows-pid-trees'
      ? plan.taskkillArguments.map((args) => Number(args[1]))
      : [plan.processGroupPid];
  return pids.filter((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if (isMissingProcess(error)) return false;
      // Signal-0 process-group probes can transiently report EPERM on macOS
      // while killed members are being reaped. The group still exists, so keep
      // the owner alive and retry instead of treating that as confirmation.
      if (isPermissionDenied(error)) return true;
      throw error;
    }
  });
}

export function ownedTreeTerminationPlan(controllerPid, ownedProcessIds, platform) {
  if (platform === 'win32') {
    return {
      kind: 'windows-pid-trees',
      taskkillArguments: [controllerPid, ...ownedProcessIds].map((pid) => [
        '/PID',
        String(pid),
        '/T',
        '/F',
      ]),
    };
  }
  return { kind: 'posix-process-group', processGroupPid: -controllerPid };
}

function observeOwnedProcessMessage(message, ownedProcessIds) {
  if (
    typeof message !== 'object' ||
    message === null ||
    message.protocolVersion !== developmentProtocolVersion ||
    !Number.isSafeInteger(message.pid) ||
    message.pid <= 0
  ) {
    return;
  }
  if (message.type === 'owned_process_started') ownedProcessIds.add(message.pid);
  if (message.type === 'owned_process_exited') ownedProcessIds.delete(message.pid);
}

function isMissingProcess(error) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH';
}

function isPermissionDenied(error) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EPERM';
}
