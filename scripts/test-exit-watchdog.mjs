#!/usr/bin/env node
// Runs a test command that must exit on its own (no `--test-force-exit`).
//
//   node scripts/test-exit-watchdog.mjs <seconds> -- <command...>
//
// If the command is still running after <seconds>, the watchdog sends SIGUSR2 so a
// preloaded `dump-handles-on-signal.mjs` can print what keeps the event loop alive,
// then kills the command and exits with 124. A suite that hangs therefore names its
// leaked timer, socket, or child process instead of being force-exited silently.
import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import process from 'node:process';

const separator = process.argv.indexOf('--');
const seconds = Number(process.argv[2]);
const [command, ...args] = separator === -1 ? [] : process.argv.slice(separator + 1);
if (!Number.isFinite(seconds) || seconds <= 0 || !command) {
  process.stderr.write('Usage: node scripts/test-exit-watchdog.mjs <seconds> -- <command...>\n');
  process.exit(2);
}

const child = spawn(command, args, { stdio: 'inherit' });
let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  process.stderr.write(
    `test-exit-watchdog: still running after ${seconds}s; a timer, socket, or child process probably leaked\n`,
  );
  child.kill('SIGUSR2');
  setTimeout(() => child.kill('SIGKILL'), 1_000).unref();
}, seconds * 1_000);

// A terminal Ctrl-C reaches the whole foreground process group, but a supervisor that
// terminates only this process must not orphan the test run.
process.on('SIGTERM', () => child.kill('SIGTERM'));

child.on('error', (error) => {
  clearTimeout(timer);
  process.stderr.write(`test-exit-watchdog: could not start ${command}: ${error.message}\n`);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  clearTimeout(timer);
  if (timedOut) process.exit(124);
  process.exit(signal ? 128 + (constants.signals[signal] ?? 0) : (code ?? 1));
});
