import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, searchForWorkspaceRoot } from 'vite';

/**
 * The linked Fluidcast packages resolve their own copies of these from the Fluidcast checkout, so
 * the bundle would otherwise carry a second React (and atom runtime) next to Isagi's. Shared with
 * the browser fixture config.
 */
export const dedupe = ['react', 'react-dom', 'scheduler', 'effect', '@effect/atom-react'];

/** The Fluidcast checkout behind the gitignored `.fluidcast` link, served by the dev server. */
const fluidcastLink = fileURLToPath(new URL('../../.fluidcast', import.meta.url));

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: { dedupe },
  server: {
    fs: {
      allow: [
        searchForWorkspaceRoot(process.cwd()),
        ...(existsSync(fluidcastLink) ? [realpathSync(fluidcastLink)] : []),
      ],
    },
  },
});
