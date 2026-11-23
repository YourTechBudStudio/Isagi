// What the window shows, and where it may navigate. Pure, so every decision is testable without an Electron app;
// `index.ts` owns the hooks and stays thin.
//
// The window shows one of two documents. The desktop-owned loader (a packaged `file://` page) while the managed runtime
// starts and whenever it, or its page, has failed; and the web UI, loaded from the runtime's own origin (or, in
// development, the Vite dev server that proxies to it) exactly as a browser loads it. The UI's content security policy
// is the runtime's (`apps/runtime/src/web-ui/policy.ts`); the loader carries its own in a meta tag.
import { pathToFileURL } from 'node:url';

import type {
  AppearanceTheme,
  HostRuntimeDiagnostic,
  HostRuntimeFailureReason,
  HostRuntimeStatusSnapshot,
} from '@isagi/shared/contracts';

/** A window document that failed to load: the UI page, not the runtime. */
export type LoaderFailureReason = HostRuntimeFailureReason | 'page_load_failed';

export type LoaderState =
  | { readonly state: 'starting' }
  | {
      readonly state: 'failed';
      readonly reason: LoaderFailureReason;
      readonly diagnostic: HostRuntimeDiagnostic;
    };

export type WindowContent =
  | { readonly kind: 'loader'; readonly loader: LoaderState }
  | { readonly kind: 'ui' };

/**
 * The document for a runtime status. A page that failed to load outranks a ready runtime; a failed runtime outranks
 * everything, including a page failure noticed while it was going down.
 */
export function windowContent(
  status: HostRuntimeStatusSnapshot,
  pageFailure: HostRuntimeDiagnostic | undefined,
): WindowContent {
  switch (status.state) {
    case 'connecting':
      return { kind: 'loader', loader: { state: 'starting' } };
    case 'failed':
      return {
        kind: 'loader',
        loader: { state: 'failed', reason: status.reason, diagnostic: status.diagnostic ?? {} },
      };
    case 'ready':
      return pageFailure
        ? {
            kind: 'loader',
            loader: { state: 'failed', reason: 'page_load_failed', diagnostic: pageFailure },
          }
        : { kind: 'ui' };
  }
}

/** The loader's base URL, without a query: what navigation and IPC checks compare against. */
export function loaderBaseUrl(loaderHtmlPath: string): string {
  return pathToFileURL(loaderHtmlPath).href;
}

/**
 * The loader URL for `state`, its state in the query. Never log it: the diagnostic message travels inside it and can
 * name local paths. Log `navigationDenialCoordinate`-style coordinates only.
 */
export function loaderUrl(base: string, theme: AppearanceTheme, loader: LoaderState): string {
  const url = new URL(base);
  url.searchParams.set('theme', theme);
  url.searchParams.set('state', loader.state);
  if (loader.state === 'failed') {
    url.searchParams.set('reason', loader.reason);
    const { message, exitCode, signal } = loader.diagnostic;
    if (message) url.searchParams.set('message', message);
    if (exitCode !== undefined && exitCode !== null)
      url.searchParams.set('exitCode', String(exitCode));
    if (signal) url.searchParams.set('signal', signal);
  }
  return url.href;
}

/** True for the loader document in any state: the same file URL, whatever its query or fragment. */
export function isLoaderDocument(url: string, base: string): boolean {
  const parsed = parse(url);
  return parsed !== undefined && withoutQuery(parsed) === withoutQuery(new URL(base));
}

/** True for any document of the UI's origin (the runtime's, or the Vite dev server's in development). */
export function isUiDocument(url: string, uiOrigin: string): boolean {
  const parsed = parse(url);
  return parsed !== undefined && isHttpProtocol(parsed.protocol) && parsed.origin === uiOrigin;
}

/**
 * The window may navigate only between its two documents: the loader and the UI's origin. Everything else is denied,
 * which keeps the navigation boundary a structural property rather than a behaviour nobody happened to exercise.
 * Electron does not emit `will-navigate` for main's own `loadURL`, so this only sees navigations a page started.
 */
export function isAllowedWindowNavigation(input: {
  readonly url: string;
  readonly loaderBaseUrl: string;
  readonly uiOrigin: string;
}): boolean {
  return (
    isLoaderDocument(input.url, input.loaderBaseUrl) || isUiDocument(input.url, input.uiOrigin)
  );
}

/** Electron's `ERR_ABORTED`: a load superseded by another (main loading the next state) or stopped. Not a failure. */
const abortedLoad = -3;

/**
 * The diagnostic for a main-frame load of the UI that failed, or `undefined` when the event is not one: a subframe, an
 * aborted load, or a document other than the UI. Carries the UI origin only, never the URL's path or query.
 */
export function pageLoadFailure(input: {
  readonly errorCode: number;
  readonly errorDescription: string;
  readonly url: string;
  readonly isMainFrame: boolean;
  readonly uiOrigin: string;
}): HostRuntimeDiagnostic | undefined {
  if (!input.isMainFrame || input.errorCode === abortedLoad) return undefined;
  if (!isUiDocument(input.url, input.uiOrigin)) return undefined;
  return { message: `${input.errorDescription} (${input.errorCode}) · ${input.uiOrigin}` };
}

/**
 * What a log is allowed to say about a URL. A URL can carry credentials, a filesystem path, query parameters (the
 * loader's diagnostic among them), a fragment, or `javascript:` source, none of which belong in a log the user may
 * hand to us. An HTTP(S) origin is a safe coordinate; anything else degrades to its scheme.
 */
export function navigationDenialCoordinate(url: string): string {
  const parsed = parse(url);
  if (!parsed) return 'an unparseable URL';
  return isHttpProtocol(parsed.protocol) ? parsed.origin : parsed.protocol;
}

function parse(url: string) {
  return URL.canParse(url) ? new URL(url) : undefined;
}

function withoutQuery(url: URL) {
  return `${url.protocol}//${url.host}${url.pathname}`;
}

function isHttpProtocol(protocol: string) {
  return protocol === 'http:' || protocol === 'https:';
}
