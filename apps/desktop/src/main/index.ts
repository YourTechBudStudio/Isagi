import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { app, BrowserWindow, ipcMain } from 'electron';

import { waitForRuntimeHealth, waitForWebServer } from './boot.js';
import { getRuntimeUrl, stopRuntime } from './runtime.js';

const currentDirectory = dirname(fileURLToPath(import.meta.url));
let runtimeUrl = '';

async function createWindow() {
  const window = new BrowserWindow({
    backgroundColor: '#24273a',
    height: 900,
    minHeight: 600,
    minWidth: 900,
    show: false,
    title: 'Isagi',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(currentDirectory, '../preload/index.js'),
    },
    width: 1280,
  });

  window.once('ready-to-show', () => {
    window.show();
  });

  await window.loadFile(getSplashPath());
  await runBootSequence(window);
}

async function runBootSequence(window: BrowserWindow) {
  try {
    await setBootStatus(window, 'Starting runtime...', 'Resolving local or remote runtime.');
    runtimeUrl = await getRuntimeUrl();

    await setBootStatus(window, 'Checking runtime...', runtimeUrl);
    await waitForRuntimeHealth(runtimeUrl);

    if (app.isPackaged) {
      await setBootStatus(window, 'Loading app...', 'Opening packaged renderer.');
      await window.loadFile(join(process.resourcesPath, 'web/index.html'));
      return;
    }

    const webUrl = process.env.ISAGI_WEB_URL ?? 'http://127.0.0.1:5173';

    await setBootStatus(window, 'Waiting for web renderer...', webUrl);
    await waitForWebServer(webUrl);

    await setBootStatus(window, 'Loading app...', webUrl);
    await window.loadURL(webUrl);
  } catch (error) {
    await setBootStatus(
      window,
      'Could not start Isagi.',
      error instanceof Error ? error.message : 'Unknown boot error',
      'failed',
    );
  }
}

async function setBootStatus(
  window: BrowserWindow,
  message: string,
  detail?: string,
  state: 'booting' | 'failed' = 'booting',
) {
  await window.webContents.executeJavaScript(
    `window.setBootStatus?.(${JSON.stringify({ detail, message, state })})`,
  );
}

function getSplashPath() {
  return join(currentDirectory, '../../static/splash.html');
}

ipcMain.handle('isagi:runtime-url', () => runtimeUrl);

app.once('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.once('before-quit', () => {
  stopRuntime();
});

app
  .whenReady()
  .then(createWindow)
  .catch((error: unknown) => {
    console.error(error);
    app.quit();
  });

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow();
  }
});
