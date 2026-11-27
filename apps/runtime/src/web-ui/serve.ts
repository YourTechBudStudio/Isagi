import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import fastifyStatic from '@fastify/static';
import { Data, Effect } from 'effect';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { AppearanceTheme } from '@isagi/shared/contracts';

import { publicRoute } from '../access/index.js';
import type { SourcedValue } from '../launch-contract.js';
import { webUiContentSecurityPolicy } from './policy.js';

const documentFile = 'index.html';

/**
 * The web root cannot be served: none was given, it holds no readable `index.html`, or that file has no `<html>` tag
 * to carry the theme. Every runtime serves the web UI, so this fails startup; the message is the startup failure
 * line and names the path, its source and the fix. The runtime never falls back to serving the API only.
 */
export class WebRootUnusable extends Data.TaggedError('WebRootUnusable')<{
  readonly webRoot: SourcedValue<string> | undefined;
  /** The filesystem or document error, when there was a path to check. */
  readonly detail: string | null;
}> {
  override get message() {
    if (this.webRoot === undefined) {
      return (
        'This runtime was started without a web root, and every runtime serves the web UI. ' +
        'Pass isagi serve --web-root <directory of a built web workbench>.'
      );
    }
    const source =
      this.webRoot.source === 'flag' ? `from ${this.webRoot.name}` : 'the copy bundled with isagi';
    return (
      `The web root ${this.webRoot.value} (${source}) has no usable ${documentFile}` +
      `${this.detail === null ? '' : ` (${this.detail})`}. ` +
      'Point --web-root at a built web workbench, such as apps/web/dist after building the web app.'
    );
  }
}

/** The checked web root and its document, read once at startup. */
export interface WebUi {
  readonly root: string;
  /** `index.html` with `data-theme` set on `<html>`; served for `/`, `/index.html` and every deep page path. */
  readonly document: string;
}

/**
 * Reads the web root's `index.html` once and renders it for `theme`. The theme is the runtime's loaded
 * `appearance.theme`, which only changes on restart, so the rendered document is fixed for the process.
 */
export function prepareWebUi(
  webRoot: SourcedValue<string> | undefined,
  theme: AppearanceTheme,
): Effect.Effect<WebUi, WebRootUnusable> {
  if (webRoot === undefined) {
    return Effect.fail(new WebRootUnusable({ webRoot, detail: null }));
  }
  const documentPath = join(webRoot.value, documentFile);
  return Effect.tryPromise({
    try: async () => {
      if (!(await stat(documentPath)).isFile()) {
        throw new Error(`${documentPath} is not a file`);
      }
      const source = await readFile(documentPath, 'utf8');
      return { root: webRoot.value, document: renderWebUiDocument(source, theme) };
    },
    catch: (error) =>
      new WebRootUnusable({
        webRoot,
        detail: error instanceof Error ? error.message : String(error),
      }),
  });
}

const htmlOpenTag = /<html\b[^>]*>/i;
const dataThemeAttribute = /\sdata-theme\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i;

/**
 * `source` with `data-theme="<theme>"` on its `<html>` tag, replacing one already there. The served document thereby
 * carries the theme on its first frame, with no client storage. Throws when there is no `<html>` tag.
 */
export function renderWebUiDocument(source: string, theme: AppearanceTheme): string {
  const match = htmlOpenTag.exec(source);
  if (!match) throw new Error(`${documentFile} has no <html> tag`);
  const tag = match[0];
  const withoutTheme = tag.replace(dataThemeAttribute, '');
  const themed = `${withoutTheme.slice(0, 5)} data-theme="${theme}"${withoutTheme.slice(5)}`;
  return source.slice(0, match.index) + themed + source.slice(match.index + tag.length);
}

/**
 * Static serving over the web root, plus the rendered document at `/` and `/index.html`. Static files keep
 * `@fastify/static`'s normal caching; the raw `index.html` is never sent (`index: false`, and the explicit document
 * routes win over the wildcard). A missing file goes to the not-found handler through `reply.callNotFound()`, where
 * `isWebUiDocumentRequest` decides between the document and the JSON contract error.
 *
 * The web UI's routes are public to the access guard (they serve only files under the web root and the document),
 * so they are registered inside their own encapsulated scope whose `onRoute` hook marks exactly them; routes
 * registered later are not marked.
 */
export async function registerWebUi(fastify: FastifyInstance, webUi: WebUi): Promise<void> {
  await fastify.register(async (scope) => {
    scope.addHook('onRoute', (routeOptions) => {
      // Merged, not replaced: `@fastify/static` writes its own config in non-wildcard mode.
      routeOptions.config = { ...routeOptions.config, ...publicRoute };
    });
    for (const url of ['/', `/${documentFile}`]) {
      scope.get(url, (_request, reply) => sendWebUiDocument(reply, webUi));
    }
    await scope.register(fastifyStatic, {
      root: webUi.root,
      wildcard: true,
      index: false,
      setHeaders: (reply) => {
        reply.header('content-security-policy', webUiContentSecurityPolicy);
      },
    });
  });
}

/**
 * A `GET` or `HEAD` whose path is outside the API and the editor proxy, matched by path segment: `/api`, `/api/…` and
 * `/editor/…` stay contract errors, so an API miss never returns HTML.
 */
export function isWebUiDocumentRequest(request: FastifyRequest): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  const queryStart = request.url.indexOf('?');
  const path = queryStart === -1 ? request.url : request.url.slice(0, queryStart);
  return !(path === '/api' || path.startsWith('/api/') || path.startsWith('/editor/'));
}

/**
 * Answers with the rendered document; deep paths get it so the app can load. `no-store`, because it carries the
 * theme of the runtime that served it, and a runtime restarted with another theme must not be painted from a cache.
 */
export function sendWebUiDocument(reply: FastifyReply, webUi: WebUi): FastifyReply {
  return reply
    .code(200)
    .header('content-security-policy', webUiContentSecurityPolicy)
    .header('cache-control', 'no-store')
    .type('text/html; charset=utf-8')
    .send(webUi.document);
}
