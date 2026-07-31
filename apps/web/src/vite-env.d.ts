/// <reference types="vite/client" />

import type { DesktopUpdateSnapshot, HostRuntimeStatusSnapshot } from './lib/desktop-bridge.js';

declare global {
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
