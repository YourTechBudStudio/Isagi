import { expect, test } from '@playwright/test';

/**
 * Whether the embedded editor frame may navigate itself to a `blob:` URL under the runtime-served
 * web UI's content security policy.
 *
 * The workbench's Explorer → Download builds a `blob:` URL and clicks an `<a download>` for it
 * inside the editor frame. Firefox handles that click as a navigation of the frame before turning
 * it into a download, and a frame's navigations are checked against the *embedding* document's
 * `frame-src`, so `frame-src 'self'` blocked every download there. Chromium treats the same click
 * as a download outright, so it cannot exercise that path; a frame that navigates itself to a
 * `blob:` URL is the same check in an engine this suite runs.
 *
 * **This spec does not import the runtime policy.** The web package keeps the runtime out, so the
 * link is made from the other side: `apps/runtime/src/web-ui/policy.test.ts` pins the exact
 * `frame-src` this spec reproduces, and names this file.
 */

/** Exactly the directives `webUiContentSecurityPolicy` emits. */
const webUiPolicy = [
  "default-src 'self'",
  "frame-src 'self' blob:",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const host = `<!doctype html>
<html><body>
<script src="/host.js"></script>
<iframe id="editor" src="/editor/ctx-1/" allow="" referrerpolicy="no-referrer"></iframe>
</body></html>`;

/** Served as its own file, because the web UI policy forbids inline script in the host. */
const hostScript = `window.cspViolations = [];
document.addEventListener('securitypolicyviolation', (event) => {
  window.cspViolations.push({ directive: event.violatedDirective, blocked: event.blockedURI });
});`;

/** Code Server's workbench sends no policy of its own, and the runtime's proxy adds none. */
const workbench = `<!doctype html>
<html><body>
<script>
  location.href = URL.createObjectURL(
    new Blob(['<p id="downloaded">blob contents</p>'], { type: 'text/html' }),
  );
</script>
</body></html>`;

test('the editor frame may navigate to a blob: URL under the web UI policy', async ({ page }) => {
  await page.route('http://127.0.0.1:1/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/host.js')
      return route.fulfill({ status: 200, contentType: 'text/javascript', body: hostScript });
    if (path === '/editor/ctx-1/')
      return route.fulfill({ status: 200, contentType: 'text/html', body: workbench });
    return route.fulfill({
      status: 200,
      contentType: 'text/html',
      headers: { 'Content-Security-Policy': webUiPolicy },
      body: host,
    });
  });
  await page.goto('http://127.0.0.1:1/');

  await expect(page.frameLocator('#editor').locator('#downloaded')).toHaveText('blob contents');

  const violations = await page.evaluate(
    () => (window as never as Record<string, unknown[]>).cspViolations ?? [],
  );
  expect(violations).toEqual([]);
});
