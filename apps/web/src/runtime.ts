export async function resolveRuntimeUrl() {
  const viteRuntimeUrl = import.meta.env.VITE_ISAGI_RUNTIME_URL;

  if (viteRuntimeUrl) {
    return viteRuntimeUrl;
  }

  if (window.isagi) {
    return window.isagi.getRuntimeUrl();
  }

  throw new Error(
    'No runtime URL configured. Set VITE_ISAGI_RUNTIME_URL or open Isagi through Electron.',
  );
}
