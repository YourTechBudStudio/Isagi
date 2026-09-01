import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';

import type { EditorProvisioningFailureReason, EditorProvisioningState } from '@isagi/contracts';

import { editorProvisioningCopy } from '../../copy/index.js';
import { editorProvisioningManifestLine } from '../../lib/editor/provisioning.js';
import { EditorProvisioningNotice } from './EditorProvisioningNotice.js';
import { BootSurface } from './StartupSurfaces.js';

const REASONS: readonly EditorProvisioningFailureReason[] = [
  'unsupported_platform',
  'release_unavailable',
  'download_failed',
  'integrity_mismatch',
  'extract_failed',
  'install_unusable',
];

const failed = (
  reason: EditorProvisioningFailureReason,
  diagnostic: string | null = null,
): Extract<EditorProvisioningState, { status: 'failed' }> => ({
  status: 'failed',
  version: '4.135.0',
  reason,
  diagnostic,
});

const notice = (
  reason: EditorProvisioningFailureReason,
  options: { readonly diagnostic?: string | null; readonly retrying?: boolean } = {},
): string =>
  renderToStaticMarkup(
    <EditorProvisioningNotice
      state={failed(reason, options.diagnostic ?? null)}
      retrying={options.retrying ?? false}
      onRetry={() => undefined}
    />,
  );

describe('EditorProvisioningNotice', () => {
  it('says something specific for every failure reason', () => {
    const seen = new Set<string>();
    for (const reason of REASONS) {
      const markup = notice(reason);
      const title = editorProvisioningCopy.failure.title[reason];
      seen.add(title);
      // The reason itself is the diagnostic anchor a user can quote.
      assert.match(markup, new RegExp(reason));
      assert.ok(title.length > 0);
    }
    assert.equal(seen.size, REASONS.length, 'every reason needs its own sentence');
  });

  it('offers a retry only where retrying could change the answer', () => {
    // An unsupported platform would fail identically forever. Saying so and
    // offering a button that cannot help would be dishonest chrome.
    assert.doesNotMatch(notice('unsupported_platform'), /<button/);
    for (const reason of REASONS.filter((candidate) => candidate !== 'unsupported_platform')) {
      assert.match(notice(reason), />Try again</);
    }
  });

  it('holds the retry inert while one is already running', () => {
    const markup = notice('download_failed', { retrying: true });
    assert.match(markup, />Trying again…</);
    assert.match(markup, /disabled=""/);
  });

  it('frames the runtime diagnostic as evidence beside the reason', () => {
    const markup = notice('integrity_mismatch', { diagnostic: 'expected 9f2c, got 3b70' });
    assert.match(markup, /integrity_mismatch · expected 9f2c, got 3b70/);
    assert.match(markup, /font-mono/);
  });
});

/** The visible words, with the markup that carries them stripped away. */
const textOf = (markup: string): string => markup.replace(/<[^>]*>/g, ' ');

describe('provisioning on the boot surface', () => {
  const boot = (state: EditorProvisioningState, retrying = false): string =>
    renderToStaticMarkup(
      <BootSurface
        view={{ kind: 'editor_provisioning', state, retrying, onRetry: () => undefined }}
      />,
    );

  it('gives every transient phase a status line and nothing more', () => {
    for (const status of ['checking', 'downloading', 'verifying', 'extracting'] as const) {
      const markup = boot({ status, version: '4.135.0' });
      assert.match(markup, new RegExp(editorProvisioningCopy.status[status]));
      // No title, no body, no button — and above all no byte counter or
      // percentage. Read from the rendered text, not the markup, so the track's
      // own `width:88%` does not answer the question being asked.
      assert.doesNotMatch(markup, /<button/);
      assert.doesNotMatch(textOf(markup), /\bMB\b|\d+\s*%/);
    }
  });

  it('keeps the track alive while working and stops it red on a failure', () => {
    assert.match(boot({ status: 'downloading', version: '4.135.0' }), /animate-ray/);

    const stopped = boot(failed('download_failed'));
    assert.doesNotMatch(stopped, /animate-ray/);
    assert.match(stopped, /bg-error/);

    // A retry puts it back to running and live rather than leaving it red.
    const retrying = boot(failed('download_failed'), true);
    assert.match(retrying, /animate-ray/);
  });

  it('holds the fill at the provisioning beat rather than restarting the track', () => {
    assert.match(boot({ status: 'downloading', version: '4.135.0' }), /width:88%/);
  });

  it('widens the column only for a failure, which is the state carrying a diagnostic', () => {
    assert.match(boot(failed('extract_failed')), /max-w-2xl/);
    assert.doesNotMatch(boot({ status: 'extracting', version: '4.135.0' }), /max-w-2xl/);
  });
});

describe('editorProvisioningManifestLine', () => {
  // Onboarding reports the failure and nothing else: a download the user did not
  // ask for and cannot steer does not get to interrupt setup.
  it('is silent for every state except a failure', () => {
    const quiet: readonly EditorProvisioningState[] = [
      { status: 'not_applicable' },
      { status: 'ready', version: '4.135.0' },
      { status: 'checking', version: '4.135.0' },
      { status: 'downloading', version: '4.135.0' },
      { status: 'verifying', version: '4.135.0' },
      { status: 'extracting', version: '4.135.0' },
    ];
    for (const state of quiet) {
      assert.equal(editorProvisioningManifestLine(state), null);
    }
  });

  it('speaks the manifest lowercase, so it reads as a config comment', () => {
    for (const reason of REASONS) {
      const line = editorProvisioningManifestLine(failed(reason));
      assert.ok(line, `${reason} needs a manifest line`);
      assert.equal(line[0], line[0]?.toLowerCase());
      assert.doesNotMatch(line, /^#/, 'the component adds the leading #');
    }
  });
});
