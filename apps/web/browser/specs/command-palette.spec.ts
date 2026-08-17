import { expect, test, type Page } from '@playwright/test';

/**
 * The `Commands` palette section, against the production `EntryList` over a
 * hardcoded catalog.
 *
 * Phase 01 owns presentation, so this spec proves what presentation can be wrong
 * about: which group the rows land in and where that group sits, whether a
 * running row can be mistaken for a startable one, whether error tone stays on
 * genuine catalog failures, and whether selecting a row does the two things it
 * claims in the order it claims. Everything about real data, mutations, the
 * drawer, focus, and polling is out of scope until phase 05 replaces the mock
 * wiring underneath this page.
 *
 * Rows are located through their label text rather than through markers added
 * for testing, because the label *is* the command name — a selector that stops
 * matching means the row stopped saying what it runs.
 */

const PALETTE = '[data-fixture-palette]';

const row = (page: Page, label: string) =>
  page.locator(`${PALETTE} button`).filter({ has: page.locator(`span:text-is("${label}")`) });

/** Group headers in DOM order — the palette renders one per contiguous group. */
const groupHeaders = (page: Page) => page.locator(`${PALETTE} p.uppercase`);

async function selectVariant(page: Page, id: string) {
  await page.evaluate((value) => window.commandPaletteFixture!.selectVariant(value), id);
  await expect(page.locator(`[data-variant-option="${id}"]`)).toHaveAttribute(
    'aria-pressed',
    'true',
  );
}

const actions = (page: Page) => page.evaluate(() => window.commandPaletteFixture!.actions());

/** The icon is the first child of the row; its tone is the running/error cue. */
const iconClass = (page: Page, label: string) =>
  row(page, label).locator('svg').getAttribute('class');

test.beforeEach(async ({ page }) => {
  await page.goto('./');
  await expect(page.locator(PALETTE)).toBeVisible();
});

test('the fixture page routes to the command palette section', async ({ page }) => {
  await expect(page.locator(PALETTE)).toBeVisible();
  await expect(groupHeaders(page)).toContainText(['Commands']);
});

test('Commands sits between Workflows and This worktree', async ({ page }) => {
  await selectVariant(page, 'mixed');
  const headers = await groupHeaders(page).allTextContents();
  expect(headers).toEqual(['Workflows', 'Commands', 'This worktree']);
});

test('a running row reads as details, a startable row reads as a launch', async ({ page }) => {
  await selectVariant(page, 'mixed');

  await expect(row(page, 'dev')).toContainText('run command');
  await expect(row(page, 'api')).toContainText('open details');
  // The distinction has to survive being read quickly: the running row must not
  // contain the launch verb at all.
  await expect(row(page, 'api')).not.toContainText('run command');

  // Ports are part of the running sub, in the drawer's notation.
  await expect(row(page, 'api')).toContainText(':8080');
  await expect(row(page, 'storybook')).toContainText('open details');
  await expect(row(page, 'storybook')).not.toContainText(':');
});

test('running rows carry the working tone and startable rows do not', async ({ page }) => {
  await selectVariant(page, 'mixed');
  expect(await iconClass(page, 'api')).toContain('text-working');
  expect(await iconClass(page, 'dev')).not.toContain('text-working');
  // A state tint, never an error tint — the command is fine, it is just up.
  expect(await iconClass(page, 'api')).not.toContain('text-error');
});

test('a failed last run is still an ordinary startable row', async ({ page }) => {
  await selectVariant(page, 'startable');
  await page.locator('[data-fixture-query]').fill('migrate');

  await expect(row(page, 'migrate')).toContainText('run command');
  const icon = await iconClass(page, 'migrate');
  expect(icon).not.toContain('text-error');
  expect(icon).not.toContain('text-working');
});

test('selecting a startable row runs first, then opens details', async ({ page }) => {
  await selectVariant(page, 'mixed');
  await row(page, 'dev').click();
  await expect.poll(() => actions(page)).toEqual(['run:dev', 'open:dev']);
});

test('selecting a running row opens details without running', async ({ page }) => {
  await selectVariant(page, 'mixed');
  await row(page, 'api').click();
  await expect.poll(() => actions(page)).toEqual(['open:api']);
});

test('the keyboard reaches a command row and selects it', async ({ page }) => {
  await selectVariant(page, 'mixed');
  const input = page.locator('[data-fixture-query]');
  await input.focus();

  // Selection starts on the first row, which is the workflow above the section;
  // one step down reaches the first command without touching the mouse.
  await input.press('ArrowDown');
  await input.press('Enter');
  await expect.poll(() => actions(page)).toEqual(['run:dev', 'open:dev']);

  // And the list wraps, so the section is reachable from either direction.
  await input.press('ArrowUp');
  await input.press('Enter');
  await expect.poll(() => actions(page)).toEqual(['run:dev', 'open:dev', 'neighbour:workflow']);
});

test('an invalid config shows one error row and leaves other groups alone', async ({ page }) => {
  await selectVariant(page, 'config-error');

  const headers = await groupHeaders(page).allTextContents();
  expect(headers).toEqual(['Workflows', 'Commands', 'This worktree']);

  const failure = row(page, 'Command config needs a look.');
  await expect(failure).toBeVisible();
  expect(await failure.locator('svg').getAttribute('class')).toContain('text-error');
  await expect(failure).toContainText('Select for details.');

  // No command rows accompany it, and the neighbours are untouched.
  await expect(row(page, 'dev')).toHaveCount(0);
  await expect(row(page, 'Start terminal')).toBeVisible();
});

test('an unreadable catalog shows the drawer’s own failure sentence', async ({ page }) => {
  await selectVariant(page, 'unavailable');
  const failure = row(page, 'Commands are unavailable.');
  await expect(failure).toBeVisible();
  expect(await failure.locator('svg').getAttribute('class')).toContain('text-error');

  await failure.click();
  // Details open with no command focused: the drawer keeps whatever the user
  // had selected, and its diagnostic surface renders regardless.
  await expect.poll(() => actions(page)).toEqual(['open:']);
});

test('an empty catalog renders no Commands header at all', async ({ page }) => {
  await selectVariant(page, 'empty');
  const headers = await groupHeaders(page).allTextContents();
  expect(headers).toEqual(['Workflows', 'This worktree']);
});

test('no active worktree removes the section entirely', async ({ page }) => {
  await selectVariant(page, 'no-worktree');
  const headers = await groupHeaders(page).allTextContents();
  expect(headers).not.toContain('Commands');
});

test('the empty query caps the group at three, and typing lifts the cap', async ({ page }) => {
  await selectVariant(page, 'startable');
  const commandRows = page.locator(`${PALETTE} button`).filter({ hasText: 'run command' });
  await expect(commandRows).toHaveCount(3);

  await page.locator('[data-fixture-query]').fill('r');
  await expect(row(page, 'migrate')).toBeVisible();
  await expect(commandRows).toHaveCount(4);
});
