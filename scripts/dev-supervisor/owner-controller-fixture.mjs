import { spawn } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const fixture = fileURLToPath(new URL('./fixture-child.mjs', import.meta.url));
const child = spawn(process.execPath, [fixture, 'desktop-wait'], {
  detached: false,
  stdio: 'ignore',
});

process.stdout.write(`OWNER_READY ${process.pid} ${child.pid}\n`);
process.stdin.resume();
process.stdin.once('end', () => process.kill(process.pid, 'SIGTERM'));
process.once('SIGTERM', () => {
  child.kill('SIGTERM');
  child.once('exit', () => process.exit(143));
});
setInterval(() => {}, 1_000);
