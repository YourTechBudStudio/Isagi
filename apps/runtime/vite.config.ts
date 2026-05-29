import { builtinModules } from 'node:module';

import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    lib: {
      entry: 'src/index.ts',
      fileName: 'index',
      formats: ['es'],
    },
    rollupOptions: {
      external: [...builtinModules, ...builtinModules.map((moduleName) => `node:${moduleName}`)],
    },
    ssr: true,
    target: 'node22',
  },
});
