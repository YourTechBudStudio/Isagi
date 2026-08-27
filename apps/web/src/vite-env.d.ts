/// <reference types="vite/client" />

import type { DesktopUpdateSnapshot, HostRuntimeStatusSnapshot } from './lib/desktop-bridge.js';

declare global {
  interface ImportMetaEnv {
    /**
     * The runtime origin for the plain-browser development surface. Ignored when
     * the Electron bridge is present, which owns runtime discovery.
     */
    readonly VITE_ISAGI_RUNTIME_URL?: string;
    /**
     * An operator's build-time assertion that the runtime at
     * `VITE_ISAGI_RUNTIME_URL` runs on the same machine as this browser, and
     * therefore that a composed `http://localhost:<port>` URL is actionable.
     *
     * Consulted only when the desktop bridge is absent; its ownership fact always
     * wins. Only the exact literal `'true'` asserts co-location — anything else is
     * treated as not local, because a wrong assertion offers URLs that point at
     * the wrong machine.
     */
    readonly VITE_ISAGI_RUNTIME_LOCAL?: string;
  }

  interface Window {
    isagi?: {
      getRuntimeUrl: () => Promise<string>;
      getRuntimeStatus?: () => Promise<HostRuntimeStatusSnapshot>;
      subscribeRuntimeStatus?: (
        listener: (snapshot: HostRuntimeStatusSnapshot) => void,
      ) => () => void;
      setHostChromeVisible?: (visible: boolean) => Promise<void>;
      quitApp?: () => Promise<void>;
      getDesktopUpdate?: () => Promise<DesktopUpdateSnapshot>;
      subscribeDesktopUpdate?: (listener: (snapshot: DesktopUpdateSnapshot) => void) => () => void;
      checkForUpdates?: () => Promise<void>;
      requestUpdateRestart?: () => Promise<void>;
      confirmUpdateRestart?: () => Promise<void>;
      cancelUpdateRestart?: () => Promise<void>;
      openUpdateDownloadPage?: () => Promise<void>;
    };
  }
}

export {};
