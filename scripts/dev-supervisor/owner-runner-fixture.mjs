import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { runStackOwner } from './stack-owner.mjs';

process.exitCode = await runStackOwner({
  command: process.execPath,
  args: [fileURLToPath(new URL('./owner-controller-fixture.mjs', import.meta.url))],
  cwd: process.cwd(),
});
