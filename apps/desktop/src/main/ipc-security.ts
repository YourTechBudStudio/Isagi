import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';

/**
 * Authorizes an IPC sender down to the frame and the document.
 *
 * The window check alone would not discriminate a subframe, and the UI hosts
 * one: the embedded Code Server workbench, same-origin with the UI since both
 * come from the runtime. `nodeIntegrationInSubFrames` is off and the preload
 * exposes nothing there, but a property no code asserts is a property the next
 * change can silently remove, which is exactly what this check is for.
 *
 * The window shows two documents, the loader and the UI, and each channel
 * serves one or both of them: `document` says which, from the sending frame's
 * URL, so the loader can never reach the update channels and the UI never the
 * loader's.
 *
 * `senderFrame` is `WebFrameMain | null` in Electron: it is null once the frame
 * has navigated or been destroyed, and a request that can no longer prove which
 * frame it came from is not authorized.
 */
export function assertAuthorizedIpcSender(
  mainWindow: BrowserWindow | undefined,
  event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>,
  document: (url: string) => boolean,
) {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
    throw new Error('IPC request did not originate from the active Isagi window.');
  }
  if (!event.senderFrame || event.senderFrame !== mainWindow.webContents.mainFrame) {
    throw new Error('IPC request did not originate from the main Isagi frame.');
  }
  if (!document(event.senderFrame.url)) {
    throw new Error('IPC request did not originate from a document allowed this channel.');
  }
}
