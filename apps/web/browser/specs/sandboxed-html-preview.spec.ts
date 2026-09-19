import { expect, test } from '@playwright/test';

/**
 * Whether a sandboxed `srcdoc` preview survives the desktop shell's content security policy.
 *
 * The question is a property of the browser engine, not of Isagi's code: does Chromium match an
 * `about:srcdoc` frame against `frame-src`, or does it treat it as a local scheme that inherits the
 * embedder's policy? That is answerable here, in the same engine Electron ships, and answering it
 * here rather than by asking a person to watch a console is strictly better — it becomes a
 * regression test instead of an observation somebody made once.
 *
 * **This spec does not import the desktop policy.** The web package keeps Electron out, so the link
 * is made from the other side: `apps/desktop/src/main/renderer-policy.test.ts` pins the exact
 * `frame-src` this spec reproduces, and names this file. If the shipped directive ever changes,
 * that test fails and points here.
 *
 * The `sandbox` attribute — not this policy — is the control that matters. Nothing may weaken it to
 * make a preview work.
 */

/** Exactly the directives `buildContentSecurityPolicy` emits for a packaged window. */
const packagedPolicy = [
  "default-src 'self'",
  'frame-src http://127.0.0.1:*',
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const host = `<!doctype html>
<html><body>
<script>
  window.cspViolations = [];
  document.addEventListener('securitypolicyviolation', (event) => {
    window.cspViolations.push(event.violatedDirective);
  });
</script>
<iframe id="preview" sandbox="" referrerpolicy="no-referrer"
  srcdoc="&lt;p id=&quot;kept&quot;&gt;captured html&lt;/p&gt;&lt;script&gt;parent.sandboxEscaped = true;&lt;/script&gt;"></iframe>
</body></html>`;

test('a sandboxed srcdoc preview loads under the packaged content security policy', async ({
  page,
}) => {
  await page.route('**/csp-probe', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      headers: { 'Content-Security-Policy': packagedPolicy },
      body: host,
    }),
  );
  await page.goto('http://127.0.0.1:1/csp-probe');

  // The frame loads. `about:srcdoc` is a local scheme that inherits the embedder's policy and is
  // never matched against `frame-src`, so the loopback-only directive does not reach it.
  await expect(page.frameLocator('#preview').locator('#kept')).toHaveText('captured html');

  const violations = await page.evaluate(() => [
    ...((window as never as Record<string, string[]>).cspViolations ?? []),
  ]);
  expect(violations).toEqual([]);

  // And the sandbox is doing its job: the script inside the document did not run, so the preview
  // cannot reach the host page even though the policy let the frame exist.
  const escaped = await page.evaluate(
    () => (window as never as Record<string, unknown>).sandboxEscaped ?? false,
  );
  expect(escaped).toBe(false);
});
