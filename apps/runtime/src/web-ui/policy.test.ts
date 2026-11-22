import assert from 'node:assert/strict';
import test from 'node:test';

import { webUiContentSecurityPolicy } from './policy.js';

function directives(policy: string) {
  return new Map(
    policy.split('; ').map((entry) => {
      const separator = entry.indexOf(' ');
      return [entry.slice(0, separator), entry.slice(separator + 1)] as const;
    }),
  );
}

/**
 * The editor frame's navigation envelope: the runtime itself, and the `blob:` URLs the workbench
 * navigates the frame to when it downloads a file in Firefox. Proved against this exact directive
 * in `apps/web/browser/specs/editor-frame-blob-navigation.spec.ts`; if it changes, update that
 * spec's copy and re-run it.
 */
test('frame-src admits the runtime and blob: downloads, nothing broader', () => {
  const policy = directives(webUiContentSecurityPolicy);
  assert.deepEqual((policy.get('frame-src') ?? '').split(' '), ["'self'", 'blob:']);
  // `child-src` would also widen what workers may load; `frame-src` is the narrower lever.
  assert.equal(policy.has('child-src'), false);
});

/**
 * The whole policy, as `apps/web/browser/specs/sandboxed-html-preview.spec.ts` reproduces it to prove a sandboxed
 * `srcdoc` preview loads under it in Chromium. If this changes, update that spec's copy and re-run it.
 */
test('the policy is exactly the one the sandboxed-preview spec proves', () => {
  assert.equal(
    webUiContentSecurityPolicy,
    [
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
    ].join('; '),
  );
});
