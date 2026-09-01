import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';

/**
 * Authorizes an IPC sender down to the frame.
 *
 * The window check alone would not discriminate a subframe, and the renderer
 * now hosts one: an embedded Code Server workbench on a foreign loopback
 * origin. `nodeIntegrationInSubFrames` is off, so that frame has no bridge
 * today — but a property no code asserts is a property the next change can
 * silently remove, which is exactly what this check is for.
 *
 * `senderFrame` is `WebFrameMain | null` in Electron: it is null once the frame
 * has navigated or been destroyed, and a request that can no longer prove which
 * frame it came from is not authorized.
 */
export function assertAuthorizedIpcSender(
  mainWindow: BrowserWindow | undefined,
  event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>,
) {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
    throw new Error('IPC request did not originate from the active Isagi window.');
  }
  if (!event.senderFrame || event.senderFrame !== mainWindow.webContents.mainFrame) {
    throw new Error('IPC request did not originate from the main Isagi frame.');
  }
}
