import { expect, test, type Page } from '@playwright/test';

/**
 * The update surface's behavior, against the fixture. Interaction, focus, and
 * layout stability live here rather than in the server-rendered component tests,
 * because none of them are observable in static markup.
 */

const footer = '[data-interactive-rail] [data-update-footer]';

async function selectState(page: Page, id: string) {
  await page.click(`[data-state-option="${id}"]`);
  await expect(page.locator(footer)).toBeVisible();
}

async function selectActivity(page: Page, id: string) {
  await page.click(`[data-activity-option="${id}"]`);
}

test.beforeEach(async ({ page }) => {
  await page.goto('./');
});

test('a manual check is reachable from the version whisper and dispatches once', async ({
  page,
}) => {
  await selectState(page, 'idle');
  await page.click(`${footer} [data-version-control]`);

  await expect(page.locator('[data-actions]')).toHaveText('check');
});

test('states with work in flight offer no second entry point into it', async ({ page }) => {
  for (const id of ['checking', 'downloading-38', 'ready', 'installing']) {
    await selectState(page, id);
    await expect(page.locator(`${footer} [data-version-control]`)).toBeDisabled();
  }
});

test('the installing state has nothing left to press', async ({ page }) => {
  await selectState(page, 'installing');

  await expect(page.locator(`${footer} [data-restart-control]`)).toHaveCount(0);
  await expect(page.locator(`${footer} [data-retry-control]`)).toHaveCount(0);
  await expect(page.locator(`${footer} [data-version-control]`)).toBeDisabled();
});

test('the footer keeps the same height and position in every state', async ({ page }) => {
  const box = async () => (await page.locator(footer).boundingBox())!;

  await selectState(page, 'idle');
  const idle = await box();

  for (const id of ['checking', 'downloading-0', 'downloading-97', 'ready', 'check-failed']) {
    await selectState(page, id);
    const current = await box();
    // The whole point of the ambient treatment: a download starting must never
    // move the project list above it.
    expect(current.height).toBeCloseTo(idle.height, 0);
    expect(current.y).toBeCloseTo(idle.y, 0);
  }
});

test('download progress is a bounded fill that tracks the reported percentage', async ({
  page,
}) => {
  const track = page.locator(`${footer} [data-update-hairline="downloading"]`);

  await selectState(page, 'downloading-0');
  await expect(track).toHaveAttribute('aria-valuenow', '0');
  const trackBox = (await track.boundingBox())!;
  const emptyFill = (await track.locator('> div').boundingBox())!;
  expect(emptyFill.width).toBeLessThan(1);

  await selectState(page, 'downloading-97');
  await expect(track).toHaveAttribute('aria-valuenow', '97');
  // The fill eases to its new width on the surface curve, so settle before
  // measuring rather than catching it mid-transition.
  await expect
    .poll(async () => (await track.locator('> div').boundingBox())!.width)
    .toBeGreaterThan(trackBox.width * 0.9);
  expect((await track.locator('> div').boundingBox())!.width).toBeLessThan(trackBox.width);
});

test('the restart control is keyboard reachable and dispatches without confirmation when nothing is working', async ({
  page,
}) => {
  await selectState(page, 'ready');
  await selectActivity(page, 'none');

  await page.locator(`${footer} [data-restart-control]`).focus();
  await page.keyboard.press('Enter');

  await expect(page.locator('[data-actions]')).toHaveText('restart');
  await expect(page.locator('[data-restart-confirmation]')).toHaveCount(0);
});

for (const { id, expected } of [
  { id: 'working-1', expected: '1 agent is working right now.' },
  { id: 'working-3', expected: '3 agents are working right now.' },
  { id: 'unknown', expected: "Isagi couldn't check what's running." },
]) {
  test(`working-agent confirmation states the case for ${id}`, async ({ page }) => {
    await selectState(page, 'ready');
    await selectActivity(page, id);
    await page.click(`${footer} [data-restart-control]`);

    const popup = page.locator('[data-restart-confirmation]');
    await expect(popup).toContainText(expected);
    // Advisory, not a promise about what happens to the work.
    await expect(popup).not.toContainText(/lost|resume/i);
    await expect(page.locator('[data-actions]')).toHaveText('—');
  });
}

test('keeping working cancels, returns focus to the restart control, and restarts nothing', async ({
  page,
}) => {
  await selectState(page, 'ready');
  await selectActivity(page, 'working-3');
  await page.click(`${footer} [data-restart-control]`);

  const popup = page.locator('[data-restart-confirmation]');
  // Cancel takes focus on open, so Enter is always the safe answer.
  await expect(popup.locator('[data-confirm-cancel]')).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(popup).toHaveCount(0);
  await expect(page.locator(`${footer} [data-restart-control]`)).toBeFocused();
  await expect(page.locator('[data-actions]')).toHaveText('—');
});

test('escape cancels the confirmation and returns focus to the restart control', async ({
  page,
}) => {
  await selectState(page, 'ready');
  await selectActivity(page, 'unknown');
  await page.click(`${footer} [data-restart-control]`);

  await page.keyboard.press('Escape');

  await expect(page.locator('[data-restart-confirmation]')).toHaveCount(0);
  await expect(page.locator(`${footer} [data-restart-control]`)).toBeFocused();
  await expect(page.locator('[data-actions]')).toHaveText('—');
});

test('confirming proceeds to the restart exactly once', async ({ page }) => {
  await selectState(page, 'ready');
  await selectActivity(page, 'working-1');
  await page.click(`${footer} [data-restart-control]`);
  await page.click('[data-confirm-proceed]');

  await expect(page.locator('[data-actions]')).toHaveText('restart');
  await expect(page.locator('[data-restart-confirmation]')).toHaveCount(0);
});

test('failures stay at the control that owns them and retry in place', async ({ page }) => {
  await selectState(page, 'check-failed');
  await page.click(`${footer} [data-retry-control]`);
  await expect(page.locator('[data-actions]')).toHaveText('check');

  await page.click('[data-clear-actions]');
  await selectState(page, 'download-failed');
  await page.click(`${footer} [data-retry-control]`);
  await expect(page.locator('[data-actions]')).toHaveText('retry-download');
});

test('a build that cannot replace itself opens the download page instead', async ({ page }) => {
  await selectState(page, 'manual-required');
  await page.click(`${footer} [data-manual-control]`);

  await expect(page.locator('[data-actions]')).toHaveText('open-download-page');
});

test('the narrow rail keeps every state on one line', async ({ page }) => {
  await page.click('[data-narrow-toggle]');
  const line = page.locator(`${footer} > div`).first();

  await selectState(page, 'idle');
  const single = (await line.boundingBox())!.height;

  for (const id of ['downloading-97', 'ready', 'check-failed', 'manual-required']) {
    await selectState(page, id);
    const current = (await line.boundingBox())!.height;
    expect(current, `${id} wrapped at 200px`).toBeCloseTo(single, 0);
  }
});

test('reduced motion drops the progress transition without hiding progress', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await selectState(page, 'downloading-38');

  const fill = page.locator(`${footer} [data-update-hairline="downloading"] > div`);
  // The bar stops animating, but it still reports where the download is — the
  // reduced-motion path drops the movement, not the information.
  await expect(fill).toHaveCSS('transition-property', 'none');
  expect((await fill.boundingBox())!.width).toBeGreaterThan(0);
});

test('the contact sheet renders every state including the absent one', async ({ page }) => {
  await expect(page.locator('[data-sheet-state]')).toHaveCount(13);
  // No desktop host means no footer at all, not an empty one.
  await expect(page.locator('[data-sheet-state="unsupported"] [data-update-footer]')).toHaveCount(
    0,
  );
  await expect(page.locator('[data-sheet-state="idle"] [data-update-footer]')).toHaveCount(1);
});
