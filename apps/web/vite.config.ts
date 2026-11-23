import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/*
 * Development makes the Vite origin behave like a runtime-served UI: one origin for the page, the API and the editor.
 * Two variables, both set by the dev supervisor (`scripts/dev-supervisor/`):
 *
 * - `ISAGI_DEV_RUNTIME_URL`: the runtime Vite proxies `/api` and `/editor` (HTTP and websockets) to. Unset: no proxy,
 *   and the page shows the runtime-unreachable view, which is the honest result.
 * - `ISAGI_DEV_DATA_DIR`: the data directory whose `config.yaml` gives the dev document its `data-theme`, read through
 *   the same shared reader the runtime and the desktop use. Unset: the default theme, the same default the runtime
 *   applies to a missing config. The reader is TypeScript source in a workspace package, so it is imported only when
 *   the dev server renders the document, under `node --import tsx` (the `dev` script and the supervisor run Vite so);
 *   loading this config (`vite build`, the browser fixtures) never touches it.
 *
 * Web-only development without the supervisor: start the runtime with a fixed `ISAGI_PORT` (and `--web-root`), then
 * start Vite with `ISAGI_DEV_RUNTIME_URL=http://127.0.0.1:<that port>` and `ISAGI_DEV_DATA_DIR=<its data directory>`.
 * This file runs in Node, which is why it alone in the web package may import `global-config`.
 */
const runtimeUrl = process.env.ISAGI_DEV_RUNTIME_URL;
const dataDirectory = process.env.ISAGI_DEV_DATA_DIR;

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss(), developmentDocumentTheme()],
  ...(runtimeUrl
    ? {
        server: {
          proxy: {
            // `changeOrigin` makes the Host header the runtime's own, so its Host guard admits it; the Origin header
            // stays the Vite origin, which the desktop passes to the runtime as an allowed origin.
            '/api': { target: runtimeUrl, changeOrigin: true, ws: true },
            '/editor': { target: runtimeUrl, changeOrigin: true, ws: true },
          },
        },
      }
    : {}),
});

/**
 * Sets `data-theme` on the dev document, as the runtime does on the document it serves
 * (`apps/runtime/src/web-ui/serve.ts`). Read per request, so a restarted dev runtime's theme shows on reload. `'light'`
 * is `appearanceSettingsDefaults.theme`, written out so loading this config never imports the workspace sources.
 */
function developmentDocumentTheme(): Plugin {
  return {
    name: 'isagi-development-document-theme',
    apply: 'serve',
    async transformIndexHtml(html) {
      const theme = await readTheme();
      const opening = '<html lang="en">';
      if (!html.includes(opening)) {
        throw new Error(`index.html no longer opens with ${opening}; update the dev theme hook.`);
      }
      return html.replace(opening, `<html lang="en" data-theme="${theme}">`);
    },
  };
}

async function readTheme(): Promise<string> {
  if (!dataDirectory) return 'light';
  try {
    const { parseAppearance, readGlobalConfig } = await import('@isagi/shared/global-config');
    const file = readGlobalConfig(dataDirectory);
    if (file.status !== 'loaded') return 'light';
    const appearance = parseAppearance(file.value);
    return appearance.status === 'decoded' ? appearance.appearance.theme : 'light';
  } catch (error) {
    // Vite started without `--import tsx` cannot load the TypeScript reader: paint the default, and say why.
    console.warn(
      `[isagi] could not read the dev theme from ${dataDirectory}; painting the default. Run Vite through the dev script (node --import tsx). ${String(error)}`,
    );
    return 'light';
  }
}
