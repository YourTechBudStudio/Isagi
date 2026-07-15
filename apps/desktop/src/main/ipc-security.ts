import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';

export function assertAuthorizedIpcSender(
  mainWindow: BrowserWindow | undefined,
  event: Pick<IpcMainInvokeEvent, 'sender'>,
) {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
    throw new Error('IPC request did not originate from the active Isagi window.');
  }
}
