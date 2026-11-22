import { type AppearanceTheme, appearanceSettingsDefaults } from '@isagi/shared/contracts';

/**
 * The document's color theme.
 *
 * The runtime owns the theme (`appearance.theme` in its `config.yaml`) and writes it into the document it serves, as
 * `data-theme` on the root element, so the first frame already has it and nothing is kept in browser storage. In Vite
 * development the dev server writes it the same way. The web only paints it: `data-theme` selects the token set in
 * `styles.css`, and nothing else in the app branches on the theme. The theme changes only when the runtime restarts,
 * which reloads the page.
 */

/** The theme the document was served with, or `undefined` when the attribute is absent or not a theme. */
export function readDocumentTheme(root: {
  readonly dataset: DOMStringMap;
}): AppearanceTheme | undefined {
  const value = root.dataset.theme;
  return value === 'dark' || value === 'light' ? value : undefined;
}

/**
 * Keeps the served theme; paints the default only when the document carries none (a page not served by a runtime or
 * the dev server, such as a test fixture). Call once, before rendering.
 */
export function ensureDocumentTheme(root: HTMLElement = document.documentElement): void {
  if (readDocumentTheme(root) === undefined) root.dataset.theme = appearanceSettingsDefaults.theme;
}
