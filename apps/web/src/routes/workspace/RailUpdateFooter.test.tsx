import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';

import { RailUpdateFooter, type DesktopUpdateState } from './RailUpdateFooter.js';

const noop = () => undefined;

function render(
  state: DesktopUpdateState,
  options: { readonly installedVersion?: string; readonly restartPending?: boolean } = {},
) {
  return renderToStaticMarkup(
    <RailUpdateFooter
      state={state}
      installedVersion={options.installedVersion ?? '0.4.2'}
      restartPending={options.restartPending ?? false}
      onCheck={noop}
      onRestart={noop}
      onCancelRestart={noop}
      onConfirmRestart={noop}
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
    const markup = render({ kind: 'manual-required', openFailed: false });

    assert.match(markup, /update manually/);
    assert.match(markup, /data-manual-control/);
    // Amber, not red: nothing failed — this build just installs by hand.
    assert.match(markup, /data-update-hairline="manual-required"/);
    assert.doesNotMatch(markup, /text-error/);
    // This state is decided before any provider is contacted, so there is no
    // available version and the copy must not invent one.
    assert.match(markup, /This installation has to be updated manually/);
    assert.doesNotMatch(markup, /Isagi 0\.4\.3/);
  });

  it('reports a launch that never reached a browser without moving the action', () => {
    const markup = render({ kind: 'manual-required', openFailed: true });

    // The same control, still pressable — the remedy did not change, and a
    // retry is exactly the right thing to do.
    assert.match(markup, /data-manual-control/);
    assert.doesNotMatch(markup, /data-manual-control[^>]*disabled=""/);
    assert.match(markup, /couldn&#x27;t open/);
    assert.match(markup, /Couldn&#x27;t open the download page in a browser\. Try again\./);
    // A user-asked-for action that did nothing is a failure, so it reads as one.
    assert.match(markup, /text-error/);
    assert.doesNotMatch(markup, /update manually/);
  });

  it('disables the restart control while the host is deciding', () => {
    const pending = render({ kind: 'ready', version: '0.4.3' }, { restartPending: true });
    assert.match(
      pending,
      /data-restart-control[^>]*disabled=""|disabled=""[^>]*data-restart-control/,
    );

    // It must be enabled again by the time a confirmation could close, or focus
    // cannot be returned to it.
    const settled = render({ kind: 'ready', version: '0.4.3' });
    assert.doesNotMatch(settled, /data-restart-control[^>]*disabled=""/);
  });

  it('drops the version from every sentence when the provider did not name one', () => {
    // A provider event can omit the version. The sentence stops claiming the
    // fact rather than printing a blank where it should have been.
    assert.match(
      render({ kind: 'download-failed', version: '' }),
      /Couldn&#x27;t download the update\. Try again\./,
    );
    assert.match(render({ kind: 'ready', version: '  ' }), /aria-label="Restart to update"/);
    assert.match(
      render({ kind: 'downloading', version: '', percent: 12 }),
      /Downloading the update — 12% complete/,
    );
    assert.match(
      render({ kind: 'installing', version: '' }),
      /Closing Isagi to install the update/,
    );
  });

  it('spends red only on genuine failure', () => {
    for (const state of STATES) {
      const expectsRed =
        state.kind === 'check-failed' ||
        state.kind === 'download-failed' ||
        (state.kind === 'manual-required' && state.openFailed);
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
  { kind: 'manual-required', openFailed: false },
  { kind: 'manual-required', openFailed: true },
];
