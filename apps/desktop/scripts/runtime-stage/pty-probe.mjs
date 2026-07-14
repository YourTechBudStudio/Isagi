import { createRequire } from 'node:module';
import process from 'node:process';

const stagedManifest = process.argv[2];
if (!stagedManifest) throw new Error('Expected the staged package.json path.');

const require = createRequire(stagedManifest);
const pty = require('node-pty');
const command = probeCommand();

await new Promise((resolve, reject) => {
  const child = pty.spawn(command.file, command.args, {
    cols: 80,
    cwd: process.cwd(),
    env: process.env,
    name: 'xterm-color',
    rows: 24,
  });
  const timeout = setTimeout(() => {
    try {
      child.kill();
    } finally {
      reject(new Error(`Staged node-pty probe timed out for ${command.file}.`));
    }
  }, 10_000);

  child.onExit(({ exitCode, signal }) => {
    clearTimeout(timeout);
    if (exitCode === 0) resolve();
    else reject(new Error(`Staged node-pty exited with code ${exitCode} and signal ${signal}.`));
  });
});

console.log('ISAGI_RUNTIME_PTY_PROBE_READY');

function probeCommand() {
  if (process.platform === 'win32') {
    const file = process.env.ComSpec;
    if (!file) throw new Error('ComSpec is required for the Windows node-pty smoke probe.');
    return { file, args: ['/d', '/s', '/c', 'exit 0'] };
  }
  if (process.platform === 'darwin' || process.platform === 'linux') {
    return { file: '/bin/sh', args: ['-c', 'exit 0'] };
  }
  throw new Error(`The node-pty smoke probe does not support ${process.platform}.`);
}
