import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';

/**
 * Story #39, phase 02 — the fixture-only path preview at `?pathPreview=1`.
 *
 * **This spec is temporary and dies with its subject.** Phase 03 deletes
 * `PathCompletionPreview.tsx`, its `main.tsx` branch, the `path-preview`
 * Playwright project, and this file, and re-asserts the surviving behaviour
 * against the production palette. Nothing here may be left pointing at a deleted
 * surface, and nothing here is evidence about `useKeyboardSelection`: the preview
 * carries a local key adapter, so what these tests pin is the *policy* in
 * `src/lib/palette/path-step.ts` driving a real DOM, not the shared hook that
 * phase 03 will wire up.
 *
 * The three things worth a browser rather than a unit test, per the phase brief:
 * real key movement, acceptance as distinct from submission, and the focus/ARIA
 * relationships — all of which are properties of keys and elements, not of pure
 * functions the phase 01 suite already covers.
 */

const PANEL = '[data-path-preview-panel]';
const INPUT = '[data-path-preview-input]';
const LIST = '[data-path-preview-list]';
const HINT = '[data-path-preview-hint]';
const SUBMISSIONS = '[data-path-preview-submissions]';

const row = (page: Page, index: number) => page.locator(`[data-path-preview-row="${index}"]`);

/** The approved highlight cue: a painted accent border on the row's left edge. */
const HIGHLIGHT = /border-blue/;

interface PreviewState {
  readonly query: string;
  readonly highlightedIndex: number | null;
  readonly intent: string;
  readonly stale: boolean;
  readonly loading: boolean;
  readonly error: string | null;
  readonly selectableCount: number;
}

const state = (page: Page) =>
  page.evaluate(() => window.pathPreviewFixture!.state()) as Promise<PreviewState>;

const submissions = (page: Page) =>
  page.evaluate(() => window.pathPreviewFixture!.submissions()) as Promise<readonly string[]>;

/**
 * Wait for the request to land. A *successful* listing must also be fresh, because
 * only a fresh result has actionable rows. A **failed** one never becomes fresh:
 * the error branch replaces the rows without adopting the query, so
 * `pathSuggestionsAreStale` stays true and waiting on it would hang forever.
 * Staleness is a property of rows, and an error has none.
 */
async function settled(page: Page) {
  await expect
    .poll(async () => {
      const current = await state(page);
      if (current.loading) return false;
      return current.error !== null || current.stale === false;
    })
    .toBe(true);
}

/** Type into the buffer with real keystrokes, then let the simulated listing land. */
async function type(page: Page, text: string) {
  await page.locator(INPUT).fill(text);
  await settled(page);
}

test.beforeEach(async ({ page }) => {
  // Explicit rather than `./`: resolving a relative path against the project's
  // baseURL would drop its query string, and the query *is* which page this is.
  await page.goto('?pathPreview=1');
  await expect(page.locator(PANEL)).toBeVisible();
  // Collapse the simulated round trip: these tests are about the interaction, not
  // about the slider a reviewer left at 2 seconds.
  await page.evaluate(() => {
    window.pathPreviewFixture!.setLatency(0);
    window.pathPreviewFixture!.reset();
  });
  await settled(page);
});

test('results arrive with nothing highlighted, and Enter targets the typed text', async ({
  page,
}) => {
  await type(page, '~/work/projects/');
  const current = await state(page);

  // The whole story in one assertion: arrival never selects a row.
  expect(current.highlightedIndex).toBeNull();
  expect(current.selectableCount).toBeGreaterThan(1);
  expect(current.intent).toBe('submit');
  await expect(page.locator(HINT)).toHaveText(/Press enter to use this path\./);
  await expect(row(page, 0)).not.toHaveClass(HIGHLIGHT);
});

test('Tab and the arrows move a real highlight without touching the buffer', async ({ page }) => {
  await type(page, '~/work/projects/');
  const before = await state(page);

  await page.keyboard.press('Tab');
  expect((await state(page)).highlightedIndex).toBe(0);
  await expect(row(page, 0)).toHaveClass(HIGHLIGHT);
  await expect(page.locator(HINT)).toHaveText(/Press enter to fill the highlighted folder\./);

  await page.keyboard.press('ArrowDown');
  expect((await state(page)).highlightedIndex).toBe(1);

  // Backward from the first row wraps to the last; forward from the last wraps home.
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Shift+Tab');
  expect((await state(page)).highlightedIndex).toBe(before.selectableCount - 1);
  await page.keyboard.press('ArrowDown');
  expect((await state(page)).highlightedIndex).toBe(0);

  // Movement is inert on everything except the highlight.
  const after = await state(page);
  expect(after.query).toBe(before.query);
  expect(await submissions(page)).toEqual([]);
});

test('Enter fills the highlighted folder, and the next Enter submits it exactly once', async ({
  page,
}) => {
  await type(page, '~/work/projects/');
  await page.keyboard.press('Tab');
  const target = (await state(page)).query;

  await page.keyboard.press('Enter');
  await settled(page);
  const filled = await state(page);

  // Acceptance is a fill, not a submission — this is the distinction the whole
  // preview exists to make visible.
  expect(filled.query).toBe('~/work/projects/alpha');
  expect(filled.query).not.toBe(target);
  expect(filled.highlightedIndex).toBeNull();
  expect(await submissions(page)).toEqual([]);
  await expect(page.locator(HINT)).toHaveText(/Press enter to use this path\./);

  await page.keyboard.press('Enter');
  await expect(page.locator(SUBMISSIONS)).toBeVisible();
  expect(await submissions(page)).toEqual(['~/work/projects/alpha']);
});

test('editing after an acceptance retargets Enter at the edited text', async ({ page }) => {
  await type(page, '~/work/projects/');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await settled(page);

  await type(page, '~/work/scratch');
  expect((await state(page)).highlightedIndex).toBeNull();

  await page.keyboard.press('Enter');
  // No accepted-path history survives an edit.
  await expect.poll(() => submissions(page)).toEqual(['~/work/scratch']);
});

test('Enter over an equal path accepts first, while a click on an equal row submits', async ({
  page,
}) => {
  // Enter branch: the buffer already *is* the highlighted row's path.
  await type(page, '~/work/projects/alpha');
  await page.keyboard.press('Tab');
  expect((await state(page)).intent).toBe('accept');
  await page.keyboard.press('Enter');
  await settled(page);
  expect(await submissions(page)).toEqual([]);

  await page.keyboard.press('Enter');
  await expect.poll(() => submissions(page)).toEqual(['~/work/projects/alpha']);

  // Click branch: one click on a row whose path equals the buffer submits it.
  await type(page, '~/work/projects/beta');
  await row(page, 0).click();
  await expect
    .poll(() => submissions(page))
    .toEqual(['~/work/projects/alpha', '~/work/projects/beta']);
});

test('a differing-row click fills the buffer and leaves focus in the input', async ({ page }) => {
  await type(page, '~/work/projects/');
  await row(page, 1).click();
  await settled(page);

  expect((await state(page)).query).toBe('~/work/projects/beta');
  expect(await submissions(page)).toEqual([]);
  // The click filled the buffer and expects the next keystroke to land there.
  await expect(page.locator(INPUT)).toBeFocused();
});

test('slash descends into a highlighted folder and its children arrive unhighlighted', async ({
  page,
}) => {
  await type(page, '~/work/projects/');
  await page.keyboard.press('Tab');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('/');
  await settled(page);

  const descended = await state(page);
  expect(descended.query).toBe('~/work/projects/beta/');
  expect(descended.highlightedIndex).toBeNull();
  expect(descended.selectableCount).toBeGreaterThan(0);

  // Descending never chooses a child for you: Enter still submits the folder entered.
  await page.keyboard.press('Enter');
  await expect.poll(() => submissions(page)).toEqual(['~/work/projects/beta/']);
});

test('a trailing slash is not doubled, and a mid-buffer slash is ordinary typing', async ({
  page,
}) => {
  await type(page, '~/work/projects/');
  await page.locator(INPUT).press('End');
  await page.keyboard.press('/');
  expect((await state(page)).query).toBe('~/work/projects/');

  // Caret inside the buffer: the swallow does not apply.
  await page.locator(INPUT).fill('~/workprojects');
  await page.locator(INPUT).press('Home');
  for (let index = 0; index < 6; index += 1) await page.locator(INPUT).press('ArrowRight');
  await page.keyboard.press('/');
  expect((await state(page)).query).toBe('~/work/projects');
});

test('stale rows are inert and a transport error keeps the label, buffer and hint', async ({
  page,
}) => {
  await type(page, '~/work/projects/');
  await page.evaluate(() => window.pathPreviewFixture!.setLatency(1500));
  await page.locator(INPUT).fill('~/work/projects/b');

  // Old rows stay on screen for continuity, disabled and with no active descendant.
  await expect(row(page, 0)).toBeDisabled();
  await expect(page.locator(INPUT)).not.toHaveAttribute('aria-activedescendant', /./);
  await page.keyboard.press('Tab');
  expect((await state(page)).highlightedIndex).toBeNull();

  await page.evaluate(() => window.pathPreviewFixture!.setLatency(0));
  await page.getByRole('button', { name: 'listing transport error' }).click();
  await type(page, '~/work');
  await expect(page.locator(PANEL)).toContainText('Could not reach the runtime to list folders.');
  // Deliberate typed submission survives a listing failure, and the panel says so.
  await expect(page.locator(HINT)).toHaveText(/Press enter to use this path\./);
  await page.keyboard.press('Enter');
  await expect.poll(() => submissions(page)).toEqual(['~/work']);
});

test('the path input is a named combobox whose active descendant tracks the highlight', async ({
  page,
}) => {
  await type(page, '~/work/projects/');
  const input = page.locator(INPUT);

  await expect(input).toHaveAttribute('role', 'combobox');
  await expect(input).toHaveAttribute('aria-autocomplete', 'list');
  await expect(input).toHaveAttribute('aria-expanded', 'true');
  await expect(input).toHaveAttribute('aria-label', 'Repository root');
  await expect(page.locator(LIST)).toHaveAttribute('role', 'listbox');

  // Absent while nothing is highlighted, exact once something is.
  await expect(input).not.toHaveAttribute('aria-activedescendant', /./);
  await page.keyboard.press('Tab');
  const listId = await page.locator(LIST).getAttribute('id');
  await expect(input).toHaveAttribute('aria-activedescendant', `${listId}-0`);
  await expect(row(page, 0)).toHaveAttribute('aria-selected', 'true');
  await expect(row(page, 1)).toHaveAttribute('aria-selected', 'false');

  // The hint is what `aria-describedby` points at, so "what does Enter do" is readable.
  const hintId = await page.locator(HINT).getAttribute('id');
  await expect(input).toHaveAttribute('aria-describedby', hintId!);
});

test('a rejected submission keeps the buffer and the palette, and registers nothing', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'reject submission' }).click();
  await type(page, '~/work/projects/beta');
  await page.keyboard.press('Enter');

  await expect(page.locator('[data-path-preview-rejection]')).toHaveText(
    'Not a Git repository root',
  );
  await expect(page.locator(PANEL)).toBeVisible();
  expect((await state(page)).query).toBe('~/work/projects/beta');
});

/**
 * Not an assertion — the phase's qualitative evidence, captured from the same
 * page the automated tests drive so the screenshots cannot drift from behaviour.
 * Written outside the repo tree, into gitignored `scratch/ui-ux/screenshots/`.
 */
test('capture the reviewable state matrix', async ({ page }) => {
  const out = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../../scratch/ui-ux/screenshots',
  );
  await mkdir(out, { recursive: true });
  const panel = page.locator(PANEL);
  const shot = async (name: string) => panel.screenshot({ path: `${out}/${name}.png` });

  await shot('01-empty-buffer');

  await type(page, '~/work/projects/');
  await shot('02-matches-no-highlight');

  await page.keyboard.press('Tab');
  await shot('03-explicit-highlight');

  await type(page, '~/work/projects/al');
  await page.keyboard.press('Tab');
  await shot('04-single-row-highlight');

  await type(page, '~/work/projects/');
  await page.evaluate(() => window.pathPreviewFixture!.setLatency(4000));
  await page.locator(INPUT).fill('~/work/projects/beta');
  await expect.poll(async () => (await state(page)).loading).toBe(true);
  await shot('05-accepted-while-searching');

  await page.evaluate(() => window.pathPreviewFixture!.setLatency(0));
  await type(page, '~/work/projects/zzz');
  await shot('06-empty-result');

  await page.getByRole('button', { name: 'listing transport error' }).click();
  await type(page, '~/work');
  await shot('07-transport-error');
  await page.getByRole('button', { name: 'listing transport error' }).click();

  await page.getByRole('button', { name: 'reject submission' }).click();
  await type(page, '~/work/projects/beta');
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-path-preview-rejection]')).toBeVisible();
  await shot('08-submission-rejected');
  await page.getByRole('button', { name: 'reject submission' }).click();

  await type(page, '/Volumes/scratch-ssd/clients/northwind/');
  await page.keyboard.press('Tab');
  await shot('09-long-path-outside-home');

  await page.setViewportSize({ width: 420, height: 900 });
  await shot('10-narrow-viewport');
});
