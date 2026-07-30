import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';

import { RailUpdateFooter, type DesktopUpdateState } from './RailUpdateFooter.js';

const noop = () => undefined;

function render(state: DesktopUpdateState, installedVersion = '0.4.2') {
  return renderToStaticMarkup(
    <RailUpdateFooter
      state={state}
      installedVersion={installedVersion}
      onCheck={noop}
      onRestart={noop}
      onRetryDownload={noop}
      onOpenDownloadPage={noop}
    />,
  );
}

describe('RailUpdateFooter', () => {
  it('renders nothing at all without a desktop host', () => {
    // A hosted web build has no version to claim and no update to offer, so the
    // footer is absent rather than empty.
    assert.equal(render({ kind: 'unsupported' }), '');
  });

  it('shows the installed version but no update affordance on a disabled host', () => {
    const markup = render({ kind: 'disabled' });

    assert.match(markup, /v0\.4\.2/);
    assert.match(markup, /disabled=""/);
    assert.doesNotMatch(markup, /Check for updates/);
    // Nothing here may imply the app is talking to GitHub.
    assert.doesNotMatch(markup, /data-update-hairline="(?!none)/);
  });

  it('invites a manual check only when settled at idle', () => {
    assert.match(render({ kind: 'idle' }), /Check for updates/);

    for (const state of [
      { kind: 'checking' },
      { kind: 'downloading', version: '0.4.3', percent: 12 },
      { kind: 'ready', version: '0.4.3' },
      { kind: 'installing', version: '0.4.3' },
    ] satisfies DesktopUpdateState[]) {
      const markup = render(state);
      assert.doesNotMatch(markup, /Check for updates/, `${state.kind} offered a second check`);
      assert.match(markup, /data-version-control[^>]*disabled=""|disabled=""/);
    }
  });

  it('reports download progress as a bounded fill, never a sweep', () => {
    const markup = render({ kind: 'downloading', version: '0.4.3', percent: 38 });

    assert.match(markup, /role="progressbar"/);
    assert.match(markup, /aria-valuenow="38"/);
    assert.match(markup, /width:38%/);
    assert.match(markup, /Downloading Isagi 0\.4\.3 — 38% complete/);
    // The indeterminate bar would claim we do not know the length. We do.
    assert.doesNotMatch(markup, /command-sweep/);
  });

  it('keeps the footer the same height in every state', () => {
    // The hairline track is rendered even when it carries nothing; that is what
    // stops a download starting from nudging the project list above it.
    const heights = STATES.map((state) => render(state).match(/h-0\.5/g)?.length ?? 0);

    assert.deepEqual(
      heights,
      STATES.map(() => 1),
    );
  });

  it('offers the restart action with the target version in assistive text', () => {
    const markup = render({ kind: 'ready', version: '0.4.3' });

    assert.match(markup, /Restart to update/);
    assert.match(markup, /aria-label="Restart to update to Isagi 0\.4\.3"/);
    assert.match(markup, /data-update-hairline="ready"/);
  });

  it('leaves no action to press while the app is closing to install', () => {
    const markup = render({ kind: 'installing', version: '0.4.3' });

    assert.match(markup, /closing…/);
    assert.doesNotMatch(markup, /data-restart-control/);
    assert.doesNotMatch(markup, /data-retry-control/);
  });

  it('localizes failures at the control that owns them', () => {
    const check = render({ kind: 'check-failed' });
    assert.match(check, /data-retry-control/);
    assert.match(check, /Couldn&#x27;t check for updates\. Try again\./);

    const download = render({ kind: 'download-failed', version: '0.4.3' });
    assert.match(download, /Couldn&#x27;t download Isagi 0\.4\.3\. Try again\./);
  });

  it('sends a build that cannot replace itself to the download page', () => {
    const markup = render({ kind: 'manual-required', version: '0.4.3' });

    assert.match(markup, /update manually/);
    assert.match(markup, /data-manual-control/);
    // Amber, not red: nothing failed — this build just installs by hand.
    assert.match(markup, /data-update-hairline="manual-required"/);
    assert.doesNotMatch(markup, /text-error/);
  });

  it('spends red only on genuine failure', () => {
    for (const state of STATES) {
      const expectsRed = state.kind === 'check-failed' || state.kind === 'download-failed';
      const markup = render(state);
      assert.equal(
        /text-error|bg-error/.test(markup),
        expectsRed,
        `${state.kind} disagreed about red`,
      );
    }
  });
});

const STATES: readonly DesktopUpdateState[] = [
  { kind: 'disabled' },
  { kind: 'idle' },
  { kind: 'checking' },
  { kind: 'up-to-date' },
  { kind: 'downloading', version: '0.4.3', percent: 0 },
  { kind: 'downloading', version: '0.4.3', percent: 97 },
  { kind: 'ready', version: '0.4.3' },
  { kind: 'installing', version: '0.4.3' },
  { kind: 'check-failed' },
  { kind: 'download-failed', version: '0.4.3' },
  { kind: 'manual-required', version: '0.4.3' },
];
