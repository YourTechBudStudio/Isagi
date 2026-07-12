import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    // Workspace consumers can build in parallel while runtime refreshes the SDK package.
    emptyOutDir: false,
    lib: {
      entry: 'src/index.ts',
      fileName: 'index',
      formats: ['es'],
    },
  },
});
