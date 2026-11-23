export function destroyRendererForExit(
  window: { readonly isDestroyed: () => boolean; readonly destroy: () => void } | undefined,
) {
  if (window && !window.isDestroyed()) window.destroy();
}
