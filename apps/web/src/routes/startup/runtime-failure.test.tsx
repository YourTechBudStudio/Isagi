import assert from 'node:assert/strict';
import test from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';

import { startupCopy } from '../../copy/index.js';
import type { RuntimeFailureDiagnostic } from './runtime-failure.js';
import { runtimeFailureRows } from './runtime-failure.js';
import { BootSurface } from './StartupSurfaces.js';

const noop = () => undefined;

// Undo the entities `renderToStaticMarkup` escapes, so comparisons against the
// web-owned copy constants (which contain apostrophes) hold.
const decode = (value: string) =>
  value
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

// Text content with tags removed, so `label · value` reads contiguously across the
// label <span> boundary.
const text = (html: string) => decode(html.replace(/<[^>]+>/g, ''));

// Non-overlapping occurrences of a substring — used to prove a diagnostic fact
// appears exactly once (only in the chip), never duplicated into voiced copy.
const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;

// The decoded text inside each <button>, in render order. Local to this test on
// purpose: it encodes the current BootActions/Button markup, not a general helper.
// It also avoids colliding with the body copy, which itself contains "Restart Isagi".
const buttonLabels = (html: string) =>
  [...html.matchAll(/<button[^>]*>(.*?)<\/button>/gs)].map((match) => decode(match[1] ?? ''));

const renderFailure = (diagnostic: RuntimeFailureDiagnostic) =>
  renderToStaticMarkup(
    <BootSurface view={{ kind: 'runtime_failed', diagnostic, onRestart: noop, onQuit: noop }} />,
  );

// --- Diagnostic-row logic (pure) ---

test('runtimeFailureRows keeps a clean exit code of 0', () => {
  assert.deepEqual(runtimeFailureRows({ exitCode: 0 }), [{ key: 'exitCode', value: '0' }]);
});

test('runtimeFailureRows includes every present fact in a stable order', () => {
  const rows = runtimeFailureRows({ message: 'boom', exitCode: 137, signal: 'SIGKILL' });
  assert.deepEqual(
    rows.map((row) => row.key),
    ['message', 'exitCode', 'signal'],
  );
  assert.deepEqual(
    rows.map((row) => row.value),
    ['boom', '137', 'SIGKILL'],
  );
});

test('runtimeFailureRows drops absent and empty facts', () => {
  assert.deepEqual(runtimeFailureRows({}), []);
  assert.deepEqual(runtimeFailureRows({ message: '   ', signal: '', exitCode: null }), []);
  assert.deepEqual(runtimeFailureRows({ signal: 'SIGTERM' }), [
    { key: 'signal', value: 'SIGTERM' },
  ]);
});

test('runtimeFailureRows trims outer whitespace but preserves internal multiline formatting', () => {
  const [row] = runtimeFailureRows({ message: '\n  Error: boom\n    at foo\n' });
  assert.equal(row?.value, 'Error: boom\n    at foo');
});

// --- Rendered surface ---

test('runtime_failed renders terminal copy and every diagnostic fact', () => {
  const content = text(
    renderFailure({ message: 'Fatal: stalled', exitCode: 137, signal: 'SIGKILL' }),
  );
  assert.ok(content.includes(startupCopy.runtimeFailed.title));
  assert.ok(content.includes(startupCopy.runtimeFailed.body));
  assert.ok(content.includes(`${startupCopy.runtimeFailed.rows.message} · Fatal: stalled`));
  assert.ok(content.includes(`${startupCopy.runtimeFailed.rows.exitCode} · 137`));
  assert.ok(content.includes(`${startupCopy.runtimeFailed.rows.signal} · SIGKILL`));
});

test('runtime_failed renders exactly two actions, Restart before Quit', () => {
  const labels = buttonLabels(renderFailure({ exitCode: 1 }));
  assert.equal(labels.length, 2);
  assert.ok(labels[0]?.includes(startupCopy.runtimeFailed.restart));
  assert.ok(labels[1]?.includes(startupCopy.runtimeFailed.quit));
});

test('runtime_failed never offers a retry affordance', () => {
  const content = text(renderFailure({ exitCode: 1 }));
  assert.ok(!content.includes(startupCopy.runtimeUnreachable.retry));
  assert.ok(!content.includes(startupCopy.runtimeUnreachable.retrying));
});

test('runtime_failed with no facts shows the unavailable line and no fact rows', () => {
  const html = renderFailure({});
  const content = text(html);
  assert.ok(content.includes(startupCopy.runtimeFailed.unavailable));
  // Actions remain even with no diagnostic — inspect the buttons, not the body
  // sentence, which itself contains "Restart Isagi".
  const labels = buttonLabels(html);
  assert.equal(labels.length, 2);
  assert.ok(labels[0]?.includes(startupCopy.runtimeFailed.restart));
  assert.ok(labels[1]?.includes(startupCopy.runtimeFailed.quit));
  // No exit-code/signal rows leak in (the message label word also appears inside
  // the unavailable sentence, so it is not a meaningful absence check here).
  assert.ok(!content.includes(`${startupCopy.runtimeFailed.rows.exitCode} ·`));
  assert.ok(!content.includes(`${startupCopy.runtimeFailed.rows.signal} ·`));
});

test('the raw diagnostic message stays confined to the diagnostic chip', () => {
  const sentinel = 'DIAG_SENTINEL_XYZ';
  const html = renderFailure({ message: sentinel });

  // Appears exactly once across the whole surface — never duplicated into copy.
  assert.equal(occurrences(html, sentinel), 1);

  // Heading and body are exactly the web-owned copy; the body carries no diagnostic.
  const heading = decode(html.match(/<h1[^>]*>(.*?)<\/h1>/s)?.[1] ?? '');
  const body = decode(html.match(/<\/h1>\s*<p[^>]*>(.*?)<\/p>/s)?.[1] ?? '');
  assert.equal(heading, startupCopy.runtimeFailed.title);
  assert.equal(body, startupCopy.runtimeFailed.body);
  assert.ok(!body.includes(sentinel));

  // The single occurrence lives inside the mono diagnostic chip.
  const chip = decode(html.match(/<p[^>]*data-slot="diagnostic-chip"[^>]*>(.*?)<\/p>/s)?.[1] ?? '');
  assert.ok(chip.includes(sentinel));
});

test('runtime_unreachable still renders its retry affordance (unchanged)', () => {
  const content = text(
    renderToStaticMarkup(
      <BootSurface
        view={{
          kind: 'runtime_unreachable',
          error: 'ECONNREFUSED',
          retrying: false,
          onRetry: noop,
        }}
      />,
    ),
  );
  assert.ok(content.includes(startupCopy.runtimeUnreachable.title));
  assert.ok(content.includes(startupCopy.runtimeUnreachable.retry));
  assert.ok(content.includes('ECONNREFUSED'));
});
