import process from 'node:process';

import { Cause, Effect, Exit } from 'effect';

import { smokeRuntimeStage } from './runtime-stage/smoke.mjs';

const exit = await Effect.runPromiseExit(smokeRuntimeStage());
if (Exit.isFailure(exit)) {
  console.error(Cause.pretty(exit.cause, { renderErrorCause: true }));
  process.exitCode = 1;
}
