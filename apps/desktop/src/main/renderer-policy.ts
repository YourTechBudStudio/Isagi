import { pathToFileURL } from 'node:url';

import type { OnHeadersReceivedListenerDetails } from 'electron';

/**
 * The renderer's containment policy, kept pure so the interesting decisions are
 * testable without an Electron app.
 *
 * The one thing this module exists for is `frame-src`: Isagi frames a Code
 * Server workbench on loopback, and nothing else. Every other directive is the
 * conservative default that comes with introducing a policy at all.
 *
 * `index.ts` owns the Electron hooks and stays thin; the matching predicates,
 * the header rewrite, and the redaction all live here.
 */

/**
 * Where the renderer document comes from. Packaged and development are the only
 * two, and both resolve to a single canonical URL that is *also* the URL passed
 * to `loadURL`. Loading exactly the string we later compare against is what
 * makes the CSP scope check impossible to drift out of agreement with the load.
 */
export type RendererTarget =
  | { readonly mode: 'packaged'; readonly indexPath: string }
  | { readonly mode: 'development'; readonly devWebUrl: string };

/** The loopback the runtime pins its editor endpoint to. Deliberately not
 *  `localhost`: `editorLoopbackHost` in the runtime is `127.0.0.1`, so a
 *  `localhost` frame source would be breadth nothing can use. */
const loopbackFrameSource = 'http://127.0.0.1:*';
const loopbackConnectSources = ['http://127.0.0.1:*', 'ws://127.0.0.1:*'] as const;

const contentSecurityPolicyHeader = 'Content-Security-Policy';

/**
 * The exact document URL the renderer loads. `loadURL` is given this same
 * string, so `details.url` on the main-frame response and `details.url` on a
 * navigation attempt can both be compared to it verbatim.
 */
export function rendererDocumentUrl(target: RendererTarget): string {
  return target.mode === 'packaged'
    ? pathToFileURL(target.indexPath).href
    : new URL(target.devWebUrl).href;
}

/**
 * The origins the renderer may reach when Isagi was started against an external
 * runtime. Pure on purpose: a caller decides whether a rejection is worth a log
 * line, and the raw configured URL never reaches this module's output.
 *
 * A rejected value yields no origins, so a bad `ISAGI_RUNTIME_URL` degrades to
 * "loopback only" rather than to an unconstrained policy.
 */
export function rendererRuntimeOrigins(input: {
  readonly externalRuntimeUrl: string | undefined;
}): { readonly origins: readonly string[]; readonly rejected: boolean } {
  if (!input.externalRuntimeUrl) return { origins: [], rejected: false };
  let parsed;
  try {
    parsed = new URL(input.externalRuntimeUrl);
  } catch {
    return { origins: [], rejected: true };
  }
  if (!isHttpProtocol(parsed.protocol) || parsed.username || parsed.password) {
    return { origins: [], rejected: true };
  }
  return { origins: [parsed.origin, webSocketOrigin(parsed)], rejected: false };
}

/**
 * The renderer CSP. External runtime origins reach `connect-src` only: an
 * external runtime is never granted the editor capability, so `frame-src` stays
 * loopback-only regardless of what Isagi is attached to.
 *
 * In development the renderer *is served from* the dev origin, so `'self'`
 * already covers it in `default-src`, `script-src`, `style-src`, and the HTTP
 * half of `connect-src`. Only the genuinely missing pieces are added: the dev
 * origin's WebSocket form for HMR, and the script allowances Vite's transform
 * pipeline needs.
 */
export function rendererContentSecurityPolicy(input: {
  readonly target: RendererTarget;
  readonly runtimeOrigins: readonly string[];
}): string {
  const development =
    input.target.mode === 'development' ? new URL(input.target.devWebUrl) : undefined;
  const scriptSources = ["'self'", ...(development ? ["'unsafe-inline'", "'unsafe-eval'"] : [])];
  const connectSources = [
    "'self'",
    ...loopbackConnectSources,
    ...(development ? [webSocketOrigin(development)] : []),
    ...input.runtimeOrigins,
  ];

  return [
    ['default-src', "'self'"],
    ['frame-src', loopbackFrameSource],
    ['img-src', "'self' data: blob:"],
    ['font-src', "'self'"],
    ['style-src', "'self' 'unsafe-inline'"],
    ['script-src', scriptSources.join(' ')],
    ['connect-src', connectSources.join(' ')],
    ['object-src', "'none'"],
    ['base-uri', "'none'"],
    ['form-action', "'none'"],
  ]
    .map(([directive, sources]) => `${directive} ${sources}`)
    .join('; ');
}

/**
 * True only for the renderer's own document URL. Everything else is denied,
 * which is what makes the navigation boundary a structural property rather than
 * a behavior nobody happened to exercise.
 *
 * An exact comparison is enough: Electron does not emit `will-navigate` for
 * programmatic `loadURL`, for `window.history` navigation, or for reference
 * fragments, so every URL this sees is a real document navigation attempt.
 */
export function isAllowedRendererNavigation(input: {
  readonly url: string;
  readonly rendererDocumentUrl: string;
}): boolean {
  return input.url === input.rendererDocumentUrl;
}

/**
 * What a denial log is allowed to say about the URL it denied. A rejected URL
 * can carry credentials, a filesystem path, query parameters, a fragment, or
 * `javascript:` source, none of which belong in a log the user may hand to us.
 * An HTTP(S) origin is a safe coordinate; anything else degrades to its scheme.
 */
export function navigationDenialCoordinate(url: string): string {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return 'an unparseable URL';
  }
  return isHttpProtocol(parsed.protocol) ? parsed.origin : parsed.protocol;
}

/**
 * What the `onHeadersReceived` hook should do with one response.
 *
 * `pass` carries an empty response because that is the only true no-op:
 * supplying `responseHeaders` tells Electron the server responded with those
 * headers and routes the response through its override path, which would put
 * every Code Server workbench response through a rewrite it has no reason to
 * take. The Isagi renderer's own document is the sole response we touch.
 *
 * The discriminant exists so the caller can log an injection without repeating
 * the matching predicate, and so this module never learns about callbacks.
 */
export type RendererHeadersDecision =
  | { readonly kind: 'pass'; readonly response: Record<string, never> }
  | {
      readonly kind: 'inject';
      readonly response: { readonly responseHeaders: Record<string, string[]> };
    };

/**
 * Injects the policy for the main window's own main-frame document and nothing
 * else. The session observes every request the renderer makes, the framed
 * workbench's document and subresources included; applying Isagi's CSP to those
 * would impose `script-src 'self'` on Code Server and break it.
 *
 * `webContentsId` and `responseHeaders` are both optional on Electron's details
 * object, so an absent id fails the match rather than matching loosely, and an
 * absent header map starts empty rather than throwing.
 */
export function rendererHeadersReceivedDecision(
  details: Pick<
    OnHeadersReceivedListenerDetails,
    'resourceType' | 'url' | 'webContentsId' | 'responseHeaders'
  >,
  context: {
    readonly rendererWebContentsId: number;
    readonly rendererDocumentUrl: string;
    readonly policy: string;
  },
): RendererHeadersDecision {
  if (
    details.resourceType !== 'mainFrame' ||
    details.webContentsId !== context.rendererWebContentsId ||
    details.url !== context.rendererDocumentUrl
  ) {
    return { kind: 'pass', response: {} };
  }

  const responseHeaders: Record<string, string[]> = {};
  for (const [name, value] of Object.entries(details.responseHeaders ?? {})) {
    // Replaced, never appended: two policies intersect into something neither
    // author intended, and the intersection is the one nobody reviewed.
    if (name.toLowerCase() === contentSecurityPolicyHeader.toLowerCase()) continue;
    responseHeaders[name] = value;
  }
  responseHeaders[contentSecurityPolicyHeader] = [context.policy];
  return { kind: 'inject', response: { responseHeaders } };
}

function isHttpProtocol(protocol: string) {
  return protocol === 'http:' || protocol === 'https:';
}

function webSocketOrigin(url: URL) {
  return `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}`;
}
