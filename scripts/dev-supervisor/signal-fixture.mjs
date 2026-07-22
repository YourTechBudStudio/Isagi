import { spawn } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { Effect } from 'effect';

import { createSupervisorSignalSource, superviseChildren } from './supervisor.mjs';

const fixture = fileURLToPath(new URL('./fixture-child.mjs', import.meta.url));
let acquisition = 0;
const children = [];
const presenter = (event) => {
  if (event.source === 'web' && event.payload.includes('ready at')) {
    setImmediate(() =>
      process.stdout.write(`READY ${children.map((child) => child.pid).join(' ')}\n`),
    );
  }
};
const signals = createSupervisorSignalSource();
const result = await Effect.runPromise(
  superviseChildren({
    root: process.cwd(),
    electronExecutable: process.execPath,
    readinessTimeoutMs: 500,
    presenter,
    signals,
    spawnChild: (_command, _args, options) => {
      const child = spawn(
        process.execPath,
        [fixture, acquisition++ === 0 ? 'web-ready' : 'desktop-wait'],
        options,
      );
      children.push(child);
      return child;
    },
  }),
);
signals.dispose();
process.exitCode = result;
