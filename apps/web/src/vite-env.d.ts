/// <reference types="vite/client" />

import type { HostRuntimeStatusSnapshot } from './lib/desktop-bridge.js';

declare global {
  interface Window {
    isagi?: {
      getRuntimeUrl: () => Promise<string>;
      getRuntimeStatus?: () => Promise<HostRuntimeStatusSnapshot>;
      subscribeRuntimeStatus?: (
        listener: (snapshot: HostRuntimeStatusSnapshot) => void,
      ) => () => void;
      setHostChromeVisible?: (visible: boolean) => Promise<void>;
      relaunchApp?: () => Promise<void>;
      quitApp?: () => Promise<void>;
    };
  }
}

export {};
