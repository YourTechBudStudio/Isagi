/**
 * The request headers for one window request: adds `Authorization: Bearer <launcher token>` only to
 * `http:` and `ws:` requests for the managed runtime's own host (hostname and port), and leaves every
 * other request, and any URL that does not parse, unchanged.
 *
 * Pure, so the hook in `index.ts` stays a one-line adapter. The renderer, the preload bridge and the
 * web app never see the token; the managed runtime is always plain HTTP on loopback, so `https:` and
 * `wss:` never match.
 */
export function runtimeRequestHeaders(
  details: { readonly url: string; readonly requestHeaders: Record<string, string> },
  runtime: { readonly host: string; readonly authorization: string },
): Record<string, string> {
  let url: URL;
  try {
    url = new URL(details.url);
  } catch {
    return details.requestHeaders;
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'ws:') || url.host !== runtime.host) {
    return details.requestHeaders;
  }
  // Header names are case-insensitive: drop any spelling the request carries so the bearer is never doubled.
  const others = Object.entries(details.requestHeaders).filter(
    ([name]) => name.toLowerCase() !== 'authorization',
  );
  return { ...Object.fromEntries(others), Authorization: runtime.authorization };
}
