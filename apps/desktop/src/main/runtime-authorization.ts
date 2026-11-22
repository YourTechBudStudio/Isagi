/**
 * The request headers for one window request: adds `Authorization: Bearer <launcher token>` only to `http:` and
 * `ws:` requests for one of `runtime.hosts` (hostname and port), and leaves every other request, and any URL that
 * does not parse, unchanged.
 *
 * The hosts are the managed runtime's own, and in development also the Vite dev server's, which proxies `/api` and
 * `/editor` to the runtime and forwards the header: the window's requests go to Vite there. Both are loopback and
 * plain HTTP, so `https:` and `wss:` never match.
 *
 * Pure, so the hook in `index.ts` stays a one-line adapter. The renderer, the preload bridge and the web app never see
 * the token.
 */
export function runtimeRequestHeaders(
  details: { readonly url: string; readonly requestHeaders: Record<string, string> },
  runtime: { readonly hosts: readonly string[]; readonly authorization: string },
): Record<string, string> {
  let url: URL;
  try {
    url = new URL(details.url);
  } catch {
    return details.requestHeaders;
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'ws:') || !runtime.hosts.includes(url.host)) {
    return details.requestHeaders;
  }
  // Header names are case-insensitive: drop any spelling the request carries so the bearer is never doubled.
  const others = Object.entries(details.requestHeaders).filter(
    ([name]) => name.toLowerCase() !== 'authorization',
  );
  return { ...Object.fromEntries(others), Authorization: runtime.authorization };
}
