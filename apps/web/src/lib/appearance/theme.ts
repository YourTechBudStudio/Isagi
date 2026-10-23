import { type AppearanceTheme, appearanceSettingsDefaults } from '@isagi/contracts';

/**
 * The document's color theme.
 *
 * The runtime owns the theme (`appearance.theme` in its `config.yaml`, served
 * with the client settings). The web only paints it: `data-theme` on the root
 * element selects the token set in `styles.css`, and nothing else in the app
 * branches on the theme.
 *
 * The runtime answers only once it is reachable, so the last applied theme is
 * also kept in local storage as a first-paint hint, and the first launch paints
 * the default theme. Neither is a source of truth: the runtime's value replaces
 * them as soon as client settings arrive.
 */

const HINT_KEY = 'isagi.appearance.theme';

export function applyDocumentTheme(theme: AppearanceTheme): void {
  document.documentElement.dataset.theme = theme;
  try {
    window.localStorage.setItem(HINT_KEY, theme);
  } catch {
    // Storage can be unavailable; the next launch paints the default until settings arrive.
  }
}

/** Paints the remembered theme, or the default, before the first frame. Call once, before rendering. */
export function applyThemeHint(): void {
  document.documentElement.dataset.theme =
    readThemeHint(() => window.localStorage.getItem(HINT_KEY)) ?? appearanceSettingsDefaults.theme;
}

export function readThemeHint(read: () => string | null): AppearanceTheme | null {
  try {
    const value = read();
    return value === 'dark' || value === 'light' ? value : null;
  } catch {
    return null;
  }
}
