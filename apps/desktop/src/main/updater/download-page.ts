/**
 * The manual-install remedy. Only one composition can reach it — a packaged
 * Linux build that is not a writable AppImage — and its only possible
 * destination is Isagi's own releases page.
 *
 * The URL is a fixed constant compiled into main. It is never supplied by the
 * renderer, never derived from a snapshot, and has no fallback destination or
 * alternate browser command: a build that cannot open a browser cannot be
 * repaired by guessing a second way to open one.
 */
export const RELEASE_DOWNLOAD_PAGE_URL =
  'https://github.com/YourTechBudStudio/Isagi/releases/latest';

/** Whether the browser launch happened. There is no third answer to report. */
export type DownloadPageOutcome = 'opened' | 'failed';

/**
 * Opening a browser is main's own operation, so it does not belong to the
 * updater coordinator. The recorder is injected rather than reimplemented here
 * because the outcome is still updater state and still an updater diagnostic.
 *
 * The outcome is reported either way. A failure that only reached the log would
 * leave the user pressing `update manually` and watching nothing happen, with no
 * way to tell a slow browser from a dead one; a success has to be reported for
 * the symmetric reason, since it is what retracts an earlier failure.
 *
 * The attempt is claimed before the launch is awaited, never after. That is the
 * only point at which this function knows where its press sits relative to the
 * others: presses arrive in order, launches finish in whatever order the OS
 * decides, and the claim is what lets a superseded one be ignored.
 *
 * This never rejects. The user's remedy is unchanged and still worth pressing
 * again, so the intent has nothing to fail with — what changed is that the
 * snapshot now says so.
 */
export async function openDownloadPage(dependencies: {
  readonly openExternal: (url: string) => Promise<void>;
  readonly beginAttempt: () => (outcome: DownloadPageOutcome) => Promise<void>;
}): Promise<void> {
  const report = dependencies.beginAttempt();
  let outcome: DownloadPageOutcome = 'failed';
  try {
    await dependencies.openExternal(RELEASE_DOWNLOAD_PAGE_URL);
    outcome = 'opened';
  } catch {
    // The raw rejection never leaves this function: it can quote provider URLs
    // and shell detail. What crosses the boundary is the fixed outcome, and the
    // recorder writes the fixed sanitized summary.
  }
  await report(outcome).catch(() => undefined);
}
