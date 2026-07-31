import { Effect, Schema } from 'effect';

import { desktopUpdateIntentSchema, type DesktopUpdateIntent } from '@isagi/contracts';

import type { DesktopUpdaterService } from './coordinator.js';
import { openDownloadPage } from './download-page.js';

// Excess properties are rejected rather than silently stripped. This channel is
// a trust boundary, and "closed union" should mean the payload is exactly one of
// these shapes — not that unexpected fields were quietly dropped on the way in.
const decodeIntent = Schema.decodeUnknownSync(desktopUpdateIntentSchema, {
  onExcessProperty: 'error',
});

/**
 * The renderer never supplies an intent value — preload constructs each one
 * internally from a zero-argument method. This decode is the boundary's own
 * check rather than a defense against the web app: it makes the channel's
 * accepted shape the closed contract union and nothing else, so the dispatch
 * below can be exhaustive and a malformed payload becomes a rejected invoke
 * instead of a silently ignored one.
 */
export function decodeDesktopUpdateIntent(payload: unknown): DesktopUpdateIntent {
  return decodeIntent(payload);
}

/**
 * Every intent is awaited to completion, not merely accepted. That is what lets
 * the renderer bind its transient `Restart to update` disabled state to the
 * invoke promise: `request_restart` settles once the runtime activity read has
 * resolved, which is the operation the user is actually waiting on.
 *
 * `open_download_page` is the one intent the updater service does not perform.
 * Launching a browser is a main-process concern, so it is handled here and the
 * service only records the outcome — which it publishes, so this intent answers
 * the user through the snapshot like every other one rather than through the
 * invoke's resolution.
 */
export async function dispatchDesktopUpdateIntent(
  intent: DesktopUpdateIntent,
  dependencies: {
    readonly service: DesktopUpdaterService;
    readonly openExternal: (url: string) => Promise<void>;
  },
): Promise<void> {
  const { service } = dependencies;
  switch (intent.type) {
    case 'check_for_updates':
      return Effect.runPromise(service.checkForUpdates());
    case 'request_restart':
      return Effect.runPromise(service.requestRestart());
    case 'confirm_restart':
      return Effect.runPromise(service.confirmRestart());
    case 'cancel_restart':
      return Effect.runPromise(service.cancelRestart());
    case 'open_download_page':
      return openDownloadPage({
        openExternal: dependencies.openExternal,
        beginAttempt: () => service.beginDownloadPageAttempt(),
      });
  }
}
