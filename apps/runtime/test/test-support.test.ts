import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';

import { Effect } from 'effect';

import { expectNoProcessMatching } from './test-support.js';

describe('expectNoProcessMatching', () => {
  // A node child whose command line carries the marker (a shell could exec away its own argv).
  const spawnMarked = (marker: string) =>
    spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', marker], { stdio: 'ignore' });

  test('passes once the marked process has exited', async () => {
    const marker = `isagi-test-support-${randomUUID()}`;
    const child = spawnMarked(marker);
    const exited = new Promise((resolve) => child.once('exit', resolve));
    setTimeout(() => child.kill('SIGTERM'), 100);
    await Effect.runPromise(expectNoProcessMatching(marker));
    await exited;
  });

  test('fails with the survivor pid and command line when the process outlives the window', async () => {
    const marker = `isagi-test-support-${randomUUID()}`;
    const child = spawnMarked(marker);
    try {
      await new Promise((resolve) => child.once('spawn', resolve));
      await assert.rejects(
        Effect.runPromise(expectNoProcessMatching(marker, { withinMs: 200 })),
        (error: unknown) =>
          error instanceof Error &&
          error.message.includes(`still running after 200 ms`) &&
          error.message.includes(String(child.pid)) &&
          error.message.includes(marker),
      );
    } finally {
      child.kill('SIGKILL');
    }
  });

  test('matches the marker literally, not as a pattern', async () => {
    const marker = `isagi-test-support-${randomUUID()}`;
    const child = spawnMarked(marker);
    try {
      await new Promise((resolve) => child.once('spawn', resolve));
      // As a regex, `.` would match any character and find the running process.
      await Effect.runPromise(expectNoProcessMatching(marker.replace('-', '.'), { withinMs: 0 }));
    } finally {
      child.kill('SIGKILL');
    }
  });
});
