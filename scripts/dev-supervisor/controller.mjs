import process from 'node:process';

import { Cause, Effect, Exit } from 'effect';

import { runDevelopmentSupervisor, SupervisorFailure } from './supervisor.mjs';

// The outer stack owner keeps this pipe open for the controller's lifetime. If
// the owner disappears unexpectedly, the kernel closes the pipe and the
// controller enters the same structured shutdown path as SIGTERM.
const onOwnerEnd = () => process.kill(process.pid, 'SIGTERM');
process.stdin.resume();
process.stdin.once('end', onOwnerEnd);

const exit = await Effect.runPromiseExit(runDevelopmentSupervisor());
if (Exit.isSuccess(exit)) {
  process.exitCode = exit.value;
} else {
  const failure = Cause.failureOption(exit.cause);
  if (failure._tag === 'Some' && failure.value instanceof SupervisorFailure) {
    console.error(`[dev] ${failure.value.message}`);
    process.exitCode = failure.value.exitCode;
  } else {
    console.error(Cause.pretty(exit.cause, { renderErrorCause: true }));
    process.exitCode = 1;
  }
}

process.stdin.off('end', onOwnerEnd);
process.stdin.pause();
if (process.connected) process.disconnect();
