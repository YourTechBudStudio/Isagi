import { builtinModules } from 'node:module';
import { resolve } from 'node:path';

import { defineConfig } from 'vite';

const external = [
  'electron',
  ...builtinModules,
  ...builtinModules.map((moduleName) => `node:${moduleName}`),
];

export default defineConfig({
  build: {
    emptyOutDir: true,
    outDir: 'dist-electron',
    rollupOptions: {
      external,
      input: {
        main: resolve(__dirname, 'src/main/index.ts'),
        preload: resolve(__dirname, 'src/preload/index.ts'),
      },
      output: {
        entryFileNames: '[name]/index.js',
      },
    },
    target: 'node24',
  },
});
