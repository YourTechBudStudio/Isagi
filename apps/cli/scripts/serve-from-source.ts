// `isagi serve` from source: this CLI's own `serve` command over the runtime's source (`@isagi/runtime`), so "serve is
// the only way a runtime starts" holds in development and in `src/serve/process-entry.test.ts`. Terminals of a
// source-mode runtime use the built CLI bundle, as they always have; it has no runtime beside it, so a nested
// `isagi serve` there reports `runtime_load_failed`.
import { fileURLToPath } from 'node:url';

import { runCliProcess } from '../src/process.js';

runCliProcess(['serve', ...process.argv.slice(2)], {
  runtimeEntry: {
    load: () => import('@isagi/runtime'),
    cliEntryPath: fileURLToPath(new URL('../dist/isagi.mjs', import.meta.url)),
  },
});
