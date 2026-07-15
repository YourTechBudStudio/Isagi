export function resolveRuntimeUrlForIpc(
  getRuntimeUrl: () => Promise<string>,
  isExitRequested: () => boolean,
): Promise<string> {
  if (isExitRequested()) return pendingUntilRendererExit();
  return getRuntimeUrl().catch((error: unknown) => {
    if (isExitRequested()) return pendingUntilRendererExit();
    throw error;
  });
}

export function destroyRendererForExit(
  window: { readonly isDestroyed: () => boolean; readonly destroy: () => void } | undefined,
) {
  if (window && !window.isDestroyed()) window.destroy();
}

function pendingUntilRendererExit(): Promise<never> {
  return new Promise(() => {});
}
