#!/usr/bin/env node
import { fileURLToPath } from 'node:url';

import { runCliProcess } from './process.js';

runCliProcess(process.argv.slice(2), {
  runtimeEntry: {
    // The runtime bundle beside this file in the serve distribution. Never bundled (`@vite-ignore`),
    // so nothing but `serve` loads it or its native modules.
    load: () => import(/* @vite-ignore */ new URL('./index.js', import.meta.url).href),
    cliEntryPath: fileURLToPath(import.meta.url),
  },
});
