// Sandboxed Electron preloads run in a restricted CommonJS environment. Keep
// this dependency as a runtime require so Vite does not emit an ESM import that
// Chromium cannot evaluate before exposing the bridge.
const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');

import type { HostRuntimeStatusSnapshot } from '@isagi/contracts';

const RAIL_TOP_INSET = process.platform === 'darwin' ? '3rem' : '1rem';

function applyHostChromeInsets() {
  document.documentElement.style.setProperty('--isagi-rail-top-inset', RAIL_TOP_INSET);
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', applyHostChromeInsets, { once: true });
} else {
  applyHostChromeInsets();
}

contextBridge.exposeInMainWorld('isagi', {
  getRuntimeUrl: () => ipcRenderer.invoke('isagi:runtime-url') as Promise<string>,
  getRuntimeStatus: () =>
    ipcRenderer.invoke('isagi:runtime-status') as Promise<HostRuntimeStatusSnapshot>,
  subscribeRuntimeStatus: (listener: (snapshot: HostRuntimeStatusSnapshot) => void) => {
    const receive = (_event: Electron.IpcRendererEvent, snapshot: HostRuntimeStatusSnapshot) =>
      listener(snapshot);
    ipcRenderer.on('isagi:runtime-status-changed', receive);
    // Subscribe first, then reconcile the current monotonically versioned snapshot.
    // A transition between these operations is harmless because the renderer keeps
    // the greatest revision it has observed.
    void ipcRenderer
      .invoke('isagi:runtime-status')
      .then((snapshot: HostRuntimeStatusSnapshot) => listener(snapshot))
      .catch(() => {
        // The renderer may be destroyed between subscription and reconciliation.
      });
    return () => ipcRenderer.off('isagi:runtime-status-changed', receive);
  },
  setHostChromeVisible: (visible: boolean) =>
    ipcRenderer.invoke('isagi:host-chrome-visible', visible) as Promise<void>,
  quitApp: () => ipcRenderer.invoke('isagi:quit-app') as Promise<void>,
});
