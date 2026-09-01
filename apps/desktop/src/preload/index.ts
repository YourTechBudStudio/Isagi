// Sandboxed Electron preloads run in a restricted CommonJS environment. Keep
// this dependency as a runtime require so Vite does not emit an ESM import that
// Chromium cannot evaluate before exposing the bridge.
const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');

import type {
  DesktopUpdateIntent,
  DesktopUpdateSnapshot,
  HostRuntimeStatusSnapshot,
} from '@isagi/contracts';

const RAIL_TOP_INSET = process.platform === 'darwin' ? '3rem' : '1rem';

// Electron runs a configured preload in *every* frame of the window, including
// cross-origin iframes; `nodeIntegrationInSubFrames: false` withholds Node from
// those frames but does not withhold this script. The embedded Code Server
// workbench is such a frame, so nothing below the guard may run there: the
// bridge is host-renderer capability, and a foreign origin must observe no
// `window.isagi` at all rather than one whose calls merely fail authorization.
if (process.isMainFrame) {
  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', applyHostChromeInsets, { once: true });
  } else {
    applyHostChromeInsets();
  }

  exposeHostBridge();
}

function applyHostChromeInsets() {
  document.documentElement.style.setProperty('--isagi-rail-top-inset', RAIL_TOP_INSET);
}

function exposeHostBridge() {
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

    getDesktopUpdate: () =>
      ipcRenderer.invoke('isagi:desktop-update') as Promise<DesktopUpdateSnapshot>,
    subscribeDesktopUpdate: (listener: (snapshot: DesktopUpdateSnapshot) => void) => {
      const receive = (_event: Electron.IpcRendererEvent, snapshot: DesktopUpdateSnapshot) =>
        listener(snapshot);
      ipcRenderer.on('isagi:desktop-update-changed', receive);
      // Subscribe first, then reconcile, exactly as the runtime status does: an
      // update published between the two cannot be lost, because the renderer
      // keeps the greatest revision it has observed.
      void ipcRenderer
        .invoke('isagi:desktop-update')
        .then((snapshot: DesktopUpdateSnapshot | undefined) => {
          if (snapshot) listener(snapshot);
        })
        .catch(() => {
          // The renderer may be destroyed between subscription and reconciliation.
        });
      return () => ipcRenderer.off('isagi:desktop-update-changed', receive);
    },

    // Each action is zero-argument and builds its own intent here. The renderer
    // never supplies an intent value, a version, a URL, or a channel name.
    checkForUpdates: () => sendUpdateIntent({ type: 'check_for_updates' }),
    requestUpdateRestart: () => sendUpdateIntent({ type: 'request_restart' }),
    confirmUpdateRestart: () => sendUpdateIntent({ type: 'confirm_restart' }),
    cancelUpdateRestart: () => sendUpdateIntent({ type: 'cancel_restart' }),
    openUpdateDownloadPage: () => sendUpdateIntent({ type: 'open_download_page' }),
  });
}

function sendUpdateIntent(intent: DesktopUpdateIntent): Promise<void> {
  return ipcRenderer.invoke('isagi:desktop-update-intent', intent) as Promise<void>;
}
