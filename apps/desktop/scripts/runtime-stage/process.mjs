import { spawn } from 'node:child_process';

import { Effect } from 'effect';

import { StageCommandError, StageOperationError } from './errors.mjs';

export function runCommand(command, args, options = {}) {
  return Effect.async((resume) => {
    let settled = false;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    if (options.capture) {
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
    }

    const timeout = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
          setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
        }, options.timeoutMs)
      : undefined;

    const settle = (effect) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resume(effect);
    };

    child.once('error', (cause) => {
      settle(Effect.fail(new StageOperationError({ operation: 'command start', cause })));
    });
    child.once('exit', (exitCode, signal) => {
      if (exitCode === 0) {
        settle(Effect.succeed({ stdout, stderr }));
      } else {
        settle(
          Effect.fail(
            new StageCommandError({
              command,
              args,
              exitCode,
              signal,
              timedOut,
              stdout,
              stderr,
            }),
          ),
        );
      }
    });

    return Effect.sync(() => {
      if (!settled) child.kill('SIGTERM');
    });
  });
}
