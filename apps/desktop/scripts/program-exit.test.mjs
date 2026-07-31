import assert from 'node:assert/strict';
import test from 'node:test';

import { Cause, Exit } from 'effect';

import { classifyProgramExit, signalExitCode } from './program-exit.mjs';

test('termination signals map to their conventional exit codes', () => {
  assert.equal(signalExitCode('SIGINT'), 130);
  assert.equal(signalExitCode('SIGTERM'), 143);
  assert.equal(signalExitCode(undefined), 1);
});

test('a successful program reports the exit code it produced', () => {
  assert.deepEqual(classifyProgramExit(Exit.succeed(0), undefined), { code: 0 });
  assert.deepEqual(classifyProgramExit(Exit.succeed(7), undefined), { code: 7 });
});

test('a program cancelled by a signal reports the signal code without a cause', () => {
  const exit = Exit.failCause(Cause.interrupt(0));
  assert.deepEqual(classifyProgramExit(exit, 'SIGINT'), { code: 130 });
  assert.deepEqual(classifyProgramExit(exit, 'SIGTERM'), { code: 143 });
});

test('a fault that arrives while unwinding an interruption is still reported', () => {
  const detachFailure = new Error('hdiutil detach failed');
  const cause = Cause.sequential(Cause.interrupt(0), Cause.die(detachFailure));
  const outcome = classifyProgramExit(Exit.failCause(cause), 'SIGINT');
  assert.equal(outcome.code, 1);
  assert.deepEqual([...Cause.defects(outcome.cause)], [detachFailure]);
});

test('an ordinary packaging failure keeps its cause and fails with one', () => {
  const failure = new Error('verification failed');
  const outcome = classifyProgramExit(Exit.fail(failure), undefined);
  assert.equal(outcome.code, 1);
  assert.deepEqual([...Cause.failures(outcome.cause)], [failure]);
});
