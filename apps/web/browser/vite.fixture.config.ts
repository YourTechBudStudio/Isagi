import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The fixture bundle is multi-entry: `/` is the terminal harness, `/update/` is
 * the update-surface gallery, `/rail-reorder/` is the rail drag playground, and
 * `/command-palette/` is the configured-commands palette section, and `/editor/`
 * is the embedded-editor contact sheet. Each entry is
 * an isolated page built from the production sources, so nothing here reaches
 * the shipped app bundle.
 */
const entry = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  // Anchored to this file rather than the working directory, so the explicit
  // multi-entry inputs below are always inside the root Vite computes.
  root: entry('./fixture'),
  base: '/',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../../.browser-dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        terminal: entry('./fixture/index.html'),
        update: entry('./fixture/update/index.html'),
        railReorder: entry('./fixture/rail-reorder/index.html'),
        commandPalette: entry('./fixture/command-palette/index.html'),
        editor: entry('./fixture/editor/index.html'),
        // The stand-in workbench the editor pane frames, emitted so the iframe
        // has a real document to load.
        editorWorkbench: entry('./fixture/editor/workbench.html'),
      },
    },
  },
});
