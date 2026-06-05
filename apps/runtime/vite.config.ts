import { builtinModules } from 'node:module';

import { defineConfig } from 'vite';

export default defineConfig({
  ssr: {
    external: ['better-sqlite3'],
    noExternal: true,
  },
  build: {
    lib: {
      entry: 'src/index.ts',
      fileName: 'index',
      formats: ['es'],
    },
    rollupOptions: {
      external: [
        ...builtinModules,
        ...builtinModules.map((moduleName) => `node:${moduleName}`),
        'better-sqlite3',
      ],
    },
    ssr: true,
    target: 'node22',
  },
});
