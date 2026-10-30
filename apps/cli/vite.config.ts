import { builtinModules } from 'node:module';

import { defineConfig } from 'vite';

// One self-contained file, the serve distribution's process entry: every dependency is bundled and
// only Node builtins stay external. `serve` imports the sibling `./index.js` (the runtime bundle) at
// run time; it is never bundled here.
export default defineConfig({
  ssr: {
    noExternal: true,
  },
  build: {
    ssr: 'src/bin.ts',
    target: 'node24',
    rollupOptions: {
      external: [...builtinModules, ...builtinModules.map((moduleName) => `node:${moduleName}`)],
      output: {
        format: 'es',
        entryFileNames: 'isagi.mjs',
      },
    },
  },
});
