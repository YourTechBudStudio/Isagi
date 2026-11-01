/**
 * The content security policy of every web-UI response: the document, its assets and the SPA fallback. Proxied Code
 * Server responses never carry it.
 *
 * Twin of `rendererContentSecurityPolicy` in `apps/desktop/src/main/renderer-policy.ts`: the same directives, with
 * `'self'` standing for the runtime, because a runtime-served page's own origin is the runtime. Change both together.
 * The editor is framed at a runtime-relative path, so `frame-src 'self'` covers it, and `connect-src 'self'` admits
 * the same-host `ws:`/`wss:` sockets (CSP Level 3).
 */
export const webUiContentSecurityPolicy = [
  ['default-src', "'self'"],
  ['frame-src', "'self'"],
  ['img-src', "'self' data: blob:"],
  ['media-src', "'self' blob:"],
  ['font-src', "'self'"],
  ['style-src', "'self' 'unsafe-inline'"],
  ['script-src', "'self'"],
  ['connect-src', "'self'"],
  ['object-src', "'none'"],
  ['base-uri', "'none'"],
  ['form-action', "'none'"],
]
  .map(([directive, sources]) => `${directive} ${sources}`)
  .join('; ');
