import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { join } from 'node:path';

import fastifyStatic from '@fastify/static';
import { Data, Effect } from 'effect';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { SourcedValue } from '@isagi/cli/serve-launch';

import { webUiContentSecurityPolicy } from './policy.js';

const documentFile = 'index.html';

/**
 * `server.serveWebUi` is true but the web root cannot be served: none was given, or it holds no readable
 * `index.html`. The message is the startup failure line, so it names the setting, the path and its source, and the
 * fix. The runtime never falls back to serving the API only.
 */
export class WebRootUnusable extends Data.TaggedError('WebRootUnusable')<{
  readonly webRoot: SourcedValue<string> | undefined;
  /** The filesystem error, when there was a path to check. */
  readonly detail: string | null;
}> {
  override get message() {
    if (this.webRoot === undefined) {
      return (
        'server.serveWebUi is true, but this runtime was started without a web root. ' +
        'Pass isagi serve --web-root <directory of a built web workbench>, or set server.serveWebUi to false.'
      );
    }
    const source =
      this.webRoot.source === 'flag' ? `from ${this.webRoot.name}` : 'the copy bundled with isagi';
    return (
      `server.serveWebUi is true, but the web root ${this.webRoot.value} (${source}) has no readable ${documentFile}` +
      `${this.detail === null ? '' : ` (${this.detail})`}. ` +
      'Point --web-root at a built web workbench, such as apps/web/dist after building the web app, ' +
      'or set server.serveWebUi to false.'
    );
  }
}

/** The web root, checked to hold a readable `index.html` file. Called only when `serveWebUi` is true. */
export function requireWebRoot(
  webRoot: SourcedValue<string> | undefined,
): Effect.Effect<string, WebRootUnusable> {
  if (webRoot === undefined) {
    return Effect.fail(new WebRootUnusable({ webRoot, detail: null }));
  }
  const document = join(webRoot.value, documentFile);
  return Effect.tryPromise({
    try: async () => {
      if (!(await stat(document)).isFile()) {
        throw new Error(`${document} is not a file`);
      }
      await access(document, constants.R_OK);
      return webRoot.value;
    },
    catch: (error) =>
      new WebRootUnusable({
        webRoot,
        detail: error instanceof Error ? error.message : String(error),
      }),
  });
}

/**
 * Static serving over `root`: wildcard `GET`/`HEAD` routes, `index.html` at `/`, and the CSP on every file sent. A
 * missing file goes to the not-found handler through `reply.callNotFound()`, where `isWebUiDocumentRequest` decides
 * between the document and the JSON contract error.
 */
export async function registerWebUi(fastify: FastifyInstance, root: string): Promise<void> {
  await fastify.register(fastifyStatic, {
    root,
    wildcard: true,
    index: documentFile,
    setHeaders: (reply) => {
      reply.header('content-security-policy', webUiContentSecurityPolicy);
    },
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

/** Answers with the web document; deep paths get it so the app can load. */
export function sendWebUiDocument(reply: FastifyReply): FastifyReply {
  return reply.sendFile(documentFile);
}
