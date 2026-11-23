/// <reference types="vite/client" />

import type { DesktopUpdateSnapshot } from './lib/desktop-bridge.js';

declare global {
  interface ImportMetaEnv {
    /**
     * An operator's build-time assertion that the runtime serving this browser
     * build runs on the same machine as the browser, and therefore that a
     * composed `http://localhost:<port>` URL is actionable.
     *
     * Consulted only outside the desktop app, whose own managed runtime is local
     * by construction. Only the exact literal `'true'` asserts co-location —
     * anything else is treated as not local, because a wrong assertion offers
     * URLs that point at the wrong machine.
     */
    readonly VITE_ISAGI_RUNTIME_LOCAL?: string;
  }

  /** The desktop bridge, present only in the UI the desktop loaded from its managed runtime. */
  interface Window {
    isagi?: {
      setHostChromeVisible?: (visible: boolean) => Promise<void>;
      quitApp?: () => Promise<void>;
      getDesktopUpdate?: () => Promise<DesktopUpdateSnapshot>;
      subscribeDesktopUpdate?: (listener: (snapshot: DesktopUpdateSnapshot) => void) => () => void;
      checkForUpdates?: () => Promise<void>;
      downloadUpdate?: () => Promise<void>;
      requestUpdateRestart?: () => Promise<void>;
      confirmUpdateRestart?: () => Promise<void>;
      cancelUpdateRestart?: () => Promise<void>;
      openUpdateDownloadPage?: () => Promise<void>;
    };
  }
}

export {};
