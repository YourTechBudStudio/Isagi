import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';

import { DESKTOP_UPDATE_PROTOCOL_VERSION, type DesktopUpdateSnapshot } from '@isagi/contracts';

import { UpdateFooter } from './Rail.js';
import { RailUpdateFooter } from './RailUpdateFooter.js';
import { resolveDesktopUpdateView, type DesktopUpdateHandlers } from './useDesktopUpdate.js';

/**
 * The seam between the host bridge and the reviewed footer. The footer's own
 * rendering is covered in `RailUpdateFooter.test.tsx` and its interaction in the
 * browser fixture; what matters here is that host presence decides what the rail
 * puts at its foot, and that a host snapshot arrives at the footer intact.
 */
const globalWithWindow = globalThis as { window?: unknown };

afterEach(() => {
  delete globalWithWindow.window;
});

describe('Rail update footer seam', () => {
  it('renders no desktop chrome in a hosted web build', () => {
    globalWithWindow.window = {};

    assert.equal(renderToStaticMarkup(<UpdateFooter />), '');
  });

  it('reserves the footer geometry while a present host has not yet answered', () => {
    globalWithWindow.window = {
      isagi: { getDesktopUpdate: () => Promise.resolve(), subscribeDesktopUpdate: () => () => {} },
    };
    const markup = renderToStaticMarkup(<UpdateFooter />);

    // The same metrics as the populated footer — the row and the hairline track
    // — so the rail does not move when the first snapshot lands.
    assert.match(markup, /data-update-state="unresolved"/);
    assert.match(markup, /h-9/);
    assert.match(markup, /h-0\.5/);
    // Nothing invented to fill it: no version, no status token, no skeleton.
    assert.doesNotMatch(markup, /v\d|animate-|checking|Restart/);
  });

  it('carries a host snapshot through to the rendered footer', () => {
    const view = resolveView({
      protocolVersion: DESKTOP_UPDATE_PROTOCOL_VERSION,
      revision: 4,
      installedVersion: '0.4.2',
      state: 'downloading',
      targetVersion: '0.4.3',
      progressPercent: 41,
    });
    assert.equal(view.presence, 'resolved');
    const markup = renderToStaticMarkup(<RailUpdateFooter {...view} />);

    assert.match(markup, /v0\.4\.2/);
    assert.match(markup, /aria-valuenow="41"/);
    assert.match(markup, /Downloading Isagi 0\.4\.3 — 41% complete/);
  });

  it('renders a host confirmation as the ready control with the question attached', () => {
    const view = resolveView({
      protocolVersion: DESKTOP_UPDATE_PROTOCOL_VERSION,
      revision: 5,
      installedVersion: '0.4.2',
      state: 'restart_confirmation',
      targetVersion: '0.4.3',
      activity: { kind: 'working', workingAgentCount: 2 },
    });
    assert.equal(view.presence, 'resolved');
    const markup = renderToStaticMarkup(<RailUpdateFooter {...view} />);

    // Still the restart control in the same place — the host owns the question,
    // and the footer does not move to ask it.
    assert.match(markup, /data-restart-control/);
    assert.match(markup, /Restart to update/);
  });

  it('routes a download retry to the check intent, which is what resumes the lifecycle', () => {
    const called: string[] = [];
    const view = resolveView(
      {
        protocolVersion: DESKTOP_UPDATE_PROTOCOL_VERSION,
        revision: 6,
        installedVersion: '0.4.2',
        state: 'failed',
        operation: 'download',
        code: 'download_failed',
        targetVersion: '0.4.3',
      },
      handlersRecording(called),
    );
    assert.equal(view.presence, 'resolved');

    view.onRetryDownload();
    view.onRestart();
    view.onCancelRestart();
    view.onConfirmRestart();
    view.onOpenDownloadPage();

    // There is no separate resume operation: a retry restarts the whole
    // check/download lifecycle, and the updater downloads again on its own.
    assert.deepEqual(called, ['check', 'restart', 'cancel', 'confirm', 'download-page']);
  });
});

function resolveView(snapshot: DesktopUpdateSnapshot, handlers = handlersRecording([])) {
  return resolveDesktopUpdateView(true, { snapshot, restartPending: false }, handlers);
}

function handlersRecording(called: string[]): DesktopUpdateHandlers {
  return {
    onCheck: () => called.push('check'),
    onRestart: () => called.push('restart'),
    onCancelRestart: () => called.push('cancel'),
    onConfirmRestart: () => called.push('confirm'),
    onOpenDownloadPage: () => called.push('download-page'),
  };
}
