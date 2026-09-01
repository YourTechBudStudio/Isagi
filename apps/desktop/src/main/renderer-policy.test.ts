import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  isAllowedRendererNavigation,
  navigationDenialCoordinate,
  rendererContentSecurityPolicy,
  rendererDocumentUrl,
  rendererHeadersReceivedDecision,
  rendererRuntimeOrigins,
  type RendererTarget,
} from './renderer-policy.js';

const packagedTarget: RendererTarget = {
  mode: 'packaged',
  indexPath: '/Applications/Isagi.app/Contents/Resources/web/index.html',
};
const developmentTarget: RendererTarget = {
  mode: 'development',
  devWebUrl: 'http://127.0.0.1:4173/',
};

function directives(policy: string) {
  return new Map(
    policy.split('; ').map((entry) => {
      const separator = entry.indexOf(' ');
      return [entry.slice(0, separator), entry.slice(separator + 1)] as const;
    }),
  );
}

function policyFor(target: RendererTarget, runtimeOrigins: readonly string[] = []) {
  return directives(rendererContentSecurityPolicy({ target, runtimeOrigins }));
}

test('the canonical renderer document URL is the URL the window is asked to load', () => {
  assert.equal(rendererDocumentUrl(packagedTarget), pathToFileURL(packagedTarget.indexPath).href);
  assert.match(rendererDocumentUrl(packagedTarget), /^file:\/\/\//u);
  // A dev URL without a path still round-trips to the URL Chromium reports.
  assert.equal(
    rendererDocumentUrl({ mode: 'development', devWebUrl: 'http://127.0.0.1:4173' }),
    'http://127.0.0.1:4173/',
  );
});

test('the packaged policy frames loopback and denies the ambient directives', () => {
  const policy = policyFor(packagedTarget);
  assert.equal(policy.get('frame-src'), 'http://127.0.0.1:*');
  assert.equal(policy.get('default-src'), "'self'");
  assert.equal(policy.get('script-src'), "'self'");
  assert.equal(policy.get('font-src'), "'self'");
  assert.equal(policy.get('img-src'), "'self' data: blob:");
  assert.equal(policy.get('connect-src'), "'self' http://127.0.0.1:* ws://127.0.0.1:*");
  for (const directive of ['object-src', 'base-uri', 'form-action'])
    assert.equal(policy.get(directive), "'none'", directive);
});

/**
 * `frame-src` is the only reason this policy exists, so its breadth is asserted
 * negatively as well: `localhost` is unused given the runtime's `127.0.0.1`
 * endpoint invariant, and an external runtime never earns the editor capability.
 */
test('frame-src admits neither localhost, a wildcard, nor an external runtime', () => {
  const policy = policyFor(developmentTarget, ['https://runtime.example', 'wss://runtime.example']);
  const sources = (policy.get('frame-src') ?? '').split(' ');
  // A wildcard *port* is the point; a wildcard *source* would defeat it.
  assert.ok(!sources.includes('*'));
  assert.ok(!sources.some((source) => source.includes('localhost')));
  assert.ok(!sources.some((source) => source.includes('runtime.example')));
  assert.ok(!sources.some((source) => /^[a-z]+:\/\/\*/u.test(source)));
  assert.deepEqual(sources, ['http://127.0.0.1:*']);
});

test('development adds only the dev WebSocket origin and the Vite script allowances', () => {
  const development = policyFor(developmentTarget);
  const packaged = policyFor(packagedTarget);

  assert.equal(development.get('script-src'), "'self' 'unsafe-inline' 'unsafe-eval'");
  assert.equal(
    development.get('connect-src'),
    "'self' http://127.0.0.1:* ws://127.0.0.1:* ws://127.0.0.1:4173",
  );
  // The dev document's own origin is already `'self'`; restating it would be
  // noise that hides which sources are genuinely additional.
  for (const directive of ['default-src', 'style-src', 'img-src', 'font-src'])
    assert.equal(development.get(directive), packaged.get(directive), directive);
  assert.doesNotMatch(development.get('default-src') ?? '', /4173/u);
});

test('an https dev origin contributes its wss form', () => {
  const policy = policyFor({ mode: 'development', devWebUrl: 'https://web.test:5173/' });
  assert.match(policy.get('connect-src') ?? '', /wss:\/\/web\.test:5173/u);
});

test('external runtime origins reach connect-src in http and ws form', () => {
  const external = rendererRuntimeOrigins({ externalRuntimeUrl: 'https://runtime.test:8443/base' });
  assert.deepEqual(external, {
    origins: ['https://runtime.test:8443', 'wss://runtime.test:8443'],
    rejected: false,
  });

  const policy = policyFor(packagedTarget, external.origins);
  assert.equal(
    policy.get('connect-src'),
    "'self' http://127.0.0.1:* ws://127.0.0.1:* https://runtime.test:8443 wss://runtime.test:8443",
  );
  assert.equal(policy.get('frame-src'), 'http://127.0.0.1:*');
});

test('a plain http external runtime contributes its ws form', () => {
  assert.deepEqual(rendererRuntimeOrigins({ externalRuntimeUrl: 'http://runtime.test:9000' }), {
    origins: ['http://runtime.test:9000', 'ws://runtime.test:9000'],
    rejected: false,
  });
});

test('an unusable external runtime URL degrades to loopback-only rather than to permissive', () => {
  for (const value of [
    'not a url',
    'ftp://runtime.test',
    'file:///runtime',
    'http://user:secret@runtime.test',
  ]) {
    assert.deepEqual(
      rendererRuntimeOrigins({ externalRuntimeUrl: value }),
      { origins: [], rejected: true },
      value,
    );
  }
  // Absent is not the same fact as rejected: there is nothing to warn about.
  assert.deepEqual(rendererRuntimeOrigins({ externalRuntimeUrl: undefined }), {
    origins: [],
    rejected: false,
  });
  assert.deepEqual(rendererRuntimeOrigins({ externalRuntimeUrl: '' }), {
    origins: [],
    rejected: false,
  });
});

test('navigation is allowed only to the renderer document itself', () => {
  const packagedUrl = rendererDocumentUrl(packagedTarget);
  assert.ok(isAllowedRendererNavigation({ url: packagedUrl, rendererDocumentUrl: packagedUrl }));

  for (const url of [
    'http://127.0.0.1:41287/',
    'http://127.0.0.1:41287',
    'https://example.test/',
    'file:///Applications/Isagi.app/Contents/Resources/web/other.html',
    'file:///etc/passwd',
    'javascript:alert(1)',
    `${packagedUrl}?next=1`,
  ])
    assert.equal(
      isAllowedRendererNavigation({ url, rendererDocumentUrl: packagedUrl }),
      false,
      url,
    );

  const developmentUrl = rendererDocumentUrl(developmentTarget);
  assert.ok(
    isAllowedRendererNavigation({ url: developmentUrl, rendererDocumentUrl: developmentUrl }),
  );
  assert.equal(
    isAllowedRendererNavigation({
      url: 'http://127.0.0.1:4173/other',
      rendererDocumentUrl: developmentUrl,
    }),
    false,
  );
});

test('a denial coordinate never carries the rejected URL beyond its origin or scheme', () => {
  assert.equal(
    navigationDenialCoordinate('https://example.test:8443/path?token=secret#frag'),
    'https://example.test:8443',
  );
  assert.equal(
    navigationDenialCoordinate('http://user:secret@example.test/'),
    'http://example.test',
  );
  assert.equal(navigationDenialCoordinate('javascript:alert(document.cookie)'), 'javascript:');
  assert.equal(navigationDenialCoordinate('file:///Users/someone/private/notes.md'), 'file:');
  assert.equal(navigationDenialCoordinate('data:text/html,<b>x</b>'), 'data:');
  assert.equal(navigationDenialCoordinate('not a url'), 'an unparseable URL');
});

const rendererWebContentsId = 7;
const rendererUrl = rendererDocumentUrl(packagedTarget);
const policy = rendererContentSecurityPolicy({ target: packagedTarget, runtimeOrigins: [] });
const headerContext = {
  rendererWebContentsId,
  rendererDocumentUrl: rendererUrl,
  policy,
};

function detailsFor(overrides: Record<string, unknown> = {}) {
  return {
    resourceType: 'mainFrame',
    url: rendererUrl,
    webContentsId: rendererWebContentsId,
    responseHeaders: { 'content-type': ['text/html'] },
    ...overrides,
  } as Parameters<typeof rendererHeadersReceivedDecision>[0];
}

test('the renderer document response is the only one that receives the policy', () => {
  const decision = rendererHeadersReceivedDecision(detailsFor(), headerContext);
  assert.equal(decision.kind, 'inject');
  assert.deepEqual(decision.response, {
    responseHeaders: {
      'content-type': ['text/html'],
      'Content-Security-Policy': [policy],
    },
  });
});

/**
 * The framed workbench's own document and every asset it pulls are observed by
 * the same session. Passing them an empty response is what keeps them out of
 * Electron's header-override path entirely.
 */
test('every other response is passed through with no header override at all', () => {
  for (const overrides of [
    { resourceType: 'subFrame', url: 'http://127.0.0.1:41287/' },
    { resourceType: 'script', url: 'http://127.0.0.1:41287/static/workbench.js' },
    { resourceType: 'xhr', url: 'http://127.0.0.1:41287/api/state' },
    { resourceType: 'stylesheet', url: 'http://127.0.0.1:41287/static/workbench.css' },
    { resourceType: 'webSocket', url: 'ws://127.0.0.1:41287/' },
    // A main-frame document in some other webContents is not ours.
    { webContentsId: 99 },
    // Electron marks `webContentsId` optional; an absent one must not match.
    { webContentsId: undefined },
    // A main-frame response in our webContents for a URL we did not load.
    { url: 'http://127.0.0.1:41287/' },
  ]) {
    const decision = rendererHeadersReceivedDecision(detailsFor(overrides), headerContext);
    assert.equal(decision.kind, 'pass', JSON.stringify(overrides));
    assert.deepEqual(decision.response, {}, JSON.stringify(overrides));
  }
});

test('an existing policy is replaced in any header casing rather than joined', () => {
  for (const header of [
    'Content-Security-Policy',
    'content-security-policy',
    'CONTENT-SECURITY-POLICY',
  ]) {
    const decision = rendererHeadersReceivedDecision(
      detailsFor({ responseHeaders: { [header]: ["default-src 'none'"], 'x-keep': ['1'] } }),
      headerContext,
    );
    assert.equal(decision.kind, 'inject');
    const injected = decision.kind === 'inject' ? decision.response.responseHeaders : {};
    const csp = Object.entries(injected).filter(
      ([name]) => name.toLowerCase() === 'content-security-policy',
    );
    assert.deepEqual(csp, [['Content-Security-Policy', [policy]]], header);
    assert.deepEqual(injected['x-keep'], ['1'], header);
  }
});

test('a response with no headers still receives exactly the policy', () => {
  const decision = rendererHeadersReceivedDecision(
    detailsFor({ responseHeaders: undefined }),
    headerContext,
  );
  assert.deepEqual(decision.response, {
    responseHeaders: { 'Content-Security-Policy': [policy] },
  });
});

test('the decision never mutates the details it was given', () => {
  const responseHeaders = { 'content-type': ['text/html'] };
  rendererHeadersReceivedDecision(detailsFor({ responseHeaders }), headerContext);
  assert.deepEqual(responseHeaders, { 'content-type': ['text/html'] });
});
