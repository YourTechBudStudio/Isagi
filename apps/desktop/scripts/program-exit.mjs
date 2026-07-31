import { Cause, Exit } from 'effect';

// The packaging entrypoint owns real resources — a spawned Electron Builder, a
// mounted DMG, temporary trees — so a termination signal must become fiber
// interruption rather than an immediate process death. These are the pure
// decisions that surrounds that bridge, kept here so they can be tested without
// importing the entrypoint's side effects.

const signalExitCodes = Object.freeze({ SIGINT: 130, SIGTERM: 143 });

export function signalExitCode(signal) {
  return signalExitCodes[signal] ?? 1;
}

// A run cancelled by a signal is not a packaging failure, so it reports the
// conventional signal exit code with no cause. Interruption that arrives
// alongside a real fault — a detachment that failed while unwinding — is still
// reported, because that fault is the operator's actionable evidence.
export function classifyProgramExit(exit, receivedSignal) {
  if (Exit.isSuccess(exit)) return { code: exit.value };
  if (Cause.isInterruptedOnly(exit.cause)) return { code: signalExitCode(receivedSignal) };
  return { cause: exit.cause, code: 1 };
}
