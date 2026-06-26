import assert from 'node:assert/strict';
import test from 'node:test';

import { formatWorktreeSetupFailureDetails, type WorktreeSetupFailure } from './setup-failure.js';

type FailedSetup = Extract<WorktreeSetupFailure['setup'], { status: 'failed' }>;

function failed(overrides: Partial<FailedSetup> = {}): FailedSetup {
  return {
    status: 'failed',
    runId: 1,
    failedHookIndex: 1,
    failedHookType: 'command',
    message: 'Command exited with 1.',
    ...overrides,
  };
}

test('command-hook failure renders invocation, then output, then the exit summary', () => {
  const detail = formatWorktreeSetupFailureDetails(
    failed({
      command: 'pnpm install',
      outputExcerpt: 'undefined\n ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL  Command "install" not found',
      message: 'Command exited with 1.',
    }),
  );

  assert.match(detail, /^\$ pnpm install/);
  assert.ok(detail.includes('ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL'));
  // The runtime exit summary is the footer, not part of the output body.
  assert.ok(
    detail.indexOf('$ pnpm install') < detail.indexOf('ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL'),
  );
  assert.ok(
    detail.indexOf('ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL') < detail.indexOf('Command exited with 1.'),
  );
});

test('command-hook failure with empty output omits the blank output block', () => {
  const detail = formatWorktreeSetupFailureDetails(
    failed({ command: 'true', outputExcerpt: '   \n  ', message: 'Command exited with 1.' }),
  );

  // No stray empty section between the command and its exit summary.
  assert.doesNotMatch(detail, /\n\n\n/);
  assert.equal(detail, '$ true\n\nCommand exited with 1.');
});

test('command-hook failure without a captured command never renders "$ undefined"', () => {
  const detail = formatWorktreeSetupFailureDetails(
    failed({
      failedHookType: 'command',
      command: undefined,
      outputExcerpt: 'boom',
      message: 'Command exited with 1.',
    }),
  );

  assert.ok(!detail.includes('undefined'));
  assert.ok(!detail.includes('$ '));
  assert.equal(detail, 'boom\n\nCommand exited with 1.');
});

test('copy/symlink failure renders the reason and paths, with no shell invocation line', () => {
  const detail = formatWorktreeSetupFailureDetails(
    failed({
      failedHookType: 'copy',
      command: undefined,
      message: 'copy.src must stay inside its root.',
      src: 'config',
      dest: 'copied-config',
    }),
  );

  assert.ok(detail.includes('copy.src must stay inside its root.'));
  assert.ok(detail.includes('src: config'));
  assert.ok(detail.includes('dest: copied-config'));
  assert.ok(!detail.includes('$ '));
});
