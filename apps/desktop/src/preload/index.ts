import { contextBridge, ipcRenderer } from 'electron';

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
  setHostChromeVisible: (visible: boolean) =>
    ipcRenderer.invoke('isagi:host-chrome-visible', visible) as Promise<void>,
});
