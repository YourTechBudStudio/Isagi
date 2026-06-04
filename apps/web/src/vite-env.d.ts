/// <reference types="vite/client" />

interface Window {
  isagi?: {
    getRuntimeUrl: () => Promise<string>;
    setHostChromeVisible?: (visible: boolean) => Promise<void>;
  };
}
