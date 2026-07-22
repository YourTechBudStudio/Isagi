import process from 'node:process';

import { Cause, Effect, Exit } from 'effect';

import { prepareRuntimeStage } from './runtime-stage/stage.mjs';

const allowedArguments = new Set(['--', '--force-native', '--skip-runtime-build']);
const unknown = process.argv.slice(2).filter((argument) => !allowedArguments.has(argument));
if (unknown.length > 0) {
  console.error(`Unknown runtime stage option: ${unknown.join(', ')}`);
  process.exit(2);
}

const exit = await Effect.runPromiseExit(
  prepareRuntimeStage({
    buildRuntime: !process.argv.includes('--skip-runtime-build'),
    forceNative: process.argv.includes('--force-native'),
  }),
);

if (Exit.isFailure(exit)) {
  console.error(Cause.pretty(exit.cause, { renderErrorCause: true }));
  process.exitCode = 1;
}
