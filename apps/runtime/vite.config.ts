import { builtinModules } from 'node:module';

import { defineConfig } from 'vite';

import { runtimePackageExternals } from './runtime-externals.mjs';

export default defineConfig({
  ssr: {
    external: [...runtimePackageExternals],
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
        ...runtimePackageExternals,
      ],
    },
    ssr: true,
    target: 'node24',
  },
});
