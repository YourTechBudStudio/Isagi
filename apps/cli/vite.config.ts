import { builtinModules } from 'node:module';

import { defineConfig } from 'vite';

// One self-contained file: the runtime ships `dist/isagi.mjs` as an asset and the shim runs it with
// the runtime's own executable, so every dependency is bundled and only Node builtins stay external.
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
