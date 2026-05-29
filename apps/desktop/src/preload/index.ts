import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('isagi', {
  getRuntimeUrl: () => ipcRenderer.invoke('isagi:runtime-url') as Promise<string>,
});
