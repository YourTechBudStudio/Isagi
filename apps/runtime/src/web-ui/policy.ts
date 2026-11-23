/**
 * The content security policy of every web-UI response: the document, its assets and the SPA fallback. Proxied Code
 * Server responses never carry it.
 *
 * The single policy of the UI everywhere: browsers and the desktop both load the UI from the runtime, so `'self'` is
 * the runtime. (The desktop's own loader page carries its own policy in a meta tag; it loads nothing from here.)
 * The editor is framed at a runtime-relative path, so `'self'` in `frame-src` covers it, and `connect-src 'self'`
 * admits the same-host `ws:`/`wss:` sockets (CSP Level 3).
 *
 * `frame-src` governs every navigation of the editor frame, not only its `src`. The workbench's Explorer → Download
 * clicks an `<a download>` for a `blob:` URL inside the frame, which Firefox handles as a navigation of the frame, so
 * `blob:` is admitted too. Pinned by `policy.test.ts` and reproduced in
 * `apps/web/browser/specs/editor-frame-blob-navigation.spec.ts`.
 */
export const webUiContentSecurityPolicy = [
  ['default-src', "'self'"],
  ['frame-src', "'self' blob:"],
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
