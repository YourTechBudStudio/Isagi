// `isagi serve` from source: the real CLI's `serve` command over `src/index.ts`, so "serve is the only way a runtime
// starts" holds in development and in `process-entry.test.ts`. Terminals of a source-mode runtime use the built CLI
// bundle, as they always have; it has no runtime beside it, so a nested `isagi serve` there reports
// `runtime_load_failed`.
import { fileURLToPath } from 'node:url';

import { runCliProcess } from '@isagi/cli/process';

runCliProcess(['serve', ...process.argv.slice(2)], {
  runtimeEntry: {
    load: () => import('../src/index.js'),
    cliEntryPath: fileURLToPath(new URL('../../cli/dist/isagi.mjs', import.meta.url)),
  },
});
