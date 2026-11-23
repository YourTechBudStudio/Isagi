import { useEffect, useRef } from 'react';

import { isMacPlatform } from '../platform.js';
import {
  createShortcutDispatcher,
  type ShortcutBinding,
  type ShortcutDispatcher,
} from './dispatcher.js';
import { appKeymap, type AppShortcutId } from './keymap.js';

export type { ShortcutBinding } from './dispatcher.js';
export type { AppShortcutId } from './keymap.js';

let app: ShortcutDispatcher<AppShortcutId> | null = null;

/**
 * The app's one dispatcher, listening on the top window for the life of the page. Created on first
 * use, so importing this module from a non-browser test does not touch `window`.
 */
function appShortcuts(): ShortcutDispatcher<AppShortcutId> {
  if (app === null) {
    app = createShortcutDispatcher({ keymap: appKeymap, isMac: isMacPlatform });
    app.install(window);
  }
  return app;
}

/**
 * Bind the command for an app shortcut while the calling component is mounted. The binding always
 * sees the latest `enabled` and `run`, so callers pass plain closures.
 */
export function useShortcut(id: AppShortcutId, binding: ShortcutBinding): void {
  const latest = useRef(binding);
  latest.current = binding;
  useEffect(
    () =>
      appShortcuts().bind(id, {
        enabled: (event) => latest.current.enabled?.(event) ?? true,
        run: (event) => latest.current.run(event),
      }),
    [id],
  );
}

/**
 * Feed a same-origin embedded document into the app shortcuts (priority entries, trusted events
 * only). Returns the detach function. Throws a `SecurityError` if `win` is cross-origin.
 */
export function attachShortcutSource(win: Window): () => void {
  return appShortcuts().attachSource(win);
}
