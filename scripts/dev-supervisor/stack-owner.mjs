import { spawn, spawnSync } from 'node:child_process';
import process from 'node:process';

import { developmentProtocolVersion } from './dev-protocol.mjs';
import { exitCodeForResult } from './policy.mjs';

const shutdownGraceMs = 10_000;

export function runStackOwner({
  command,
  args,
  cwd,
  env = process.env,
  spawnChild = spawn,
  signalProcess = process,
  stdio = ['pipe', 'inherit', 'inherit', 'ipc'],
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
    const ownedProcessIds = new Set();

    const stop = (signal, exitCode) => {
      selectedExitCode ??= exitCode;
      signalController(controller, signal);
      hardKillTimer ??= setTimeout(
        () => killOwnedTree(controller, ownedProcessIds),
        shutdownGraceMs,
      );
      hardKillTimer.unref();
    };
    let interruptCount = 0;
    const onInterrupt = () => {
      interruptCount += 1;
      if (interruptCount > 1) {
        killOwnedTree(controller, ownedProcessIds);
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
      cleanup();
      reject(error);
    });
    controller.once('exit', (code, signal) => {
      cleanup();
      // The controller is the process-group leader on POSIX. Killing the group
      // after it exits is the crash fallback that removes descendants which did
      // not participate in graceful shutdown.
      killOwnedTree(controller, ownedProcessIds);
      resolve(selectedExitCode ?? exitCodeForResult({ code, signal }));
    });

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

function killOwnedTree(controller, ownedProcessIds) {
  if (!controller.pid) return;
  try {
    if (process.platform === 'win32') {
      // Windows has no POSIX process group. The controller registers each
      // top-level child over its private IPC channel so the owner can terminate
      // every tree even after the controller itself has crashed.
      for (const pid of [controller.pid, ...ownedProcessIds]) {
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
      }
    } else {
      process.kill(-controller.pid, 'SIGKILL');
    }
  } catch (error) {
    if (!isMissingProcess(error)) throw error;
  }
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
