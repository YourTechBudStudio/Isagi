// The Electron host exposes a tiny renderer bridge on `window.isagi`. A renderer
// cannot reliably close its own window, so the terminal startup surfaces ask the
// host to quit. In a plain browser there is no host bridge: `canQuit()` is false
// and those surfaces omit the Quit action rather than shipping a dead button.

export function canQuit(): boolean {
  return typeof window !== 'undefined' && typeof window.isagi?.quitApp === 'function';
}

export function requestQuit(): void {
  void window.isagi?.quitApp?.();
}
