import { dirname } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { runStackOwner } from './stack-owner.mjs';

const currentDirectory = dirname(fileURLToPath(import.meta.url));

try {
  process.exitCode = await runStackOwner({
    command: process.execPath,
    args: [fileURLToPath(new URL('./controller.mjs', import.meta.url))],
    cwd: dirname(currentDirectory),
  });
} catch (error) {
  console.error(`[dev] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
