import { expect, test, type Page } from '@playwright/test';

/**
 * Saved checkpoints in the production inspector, over the same fake runtime.
 *
 * The fixture run loops over one checkpoint node three times: a clean capture, one that left
 * changes out, and one that failed and saved nothing. Everything here needs a browser: opening the
 * files tab from the column, following the inventory's pages, bytes that arrive as octet-stream and
 * still render by path, an SVG and an HTML file that must not run, and a list that moves the dock.
 */

const bar = (page: Page) => page.getByRole('region', { name: 'Workflow' });
const dialog = (page: Page) => page.getByRole('dialog');
const dock = (page: Page) => dialog(page).getByRole('region', { name: 'Selection details' });
const tab = (page: Page, name: 'Declared' | 'Trace' | 'Evidence' | 'Checkpoints') =>
  dialog(page).getByRole('tab', { name, exact: true });
const checkpointColumn = (page: Page) => dialog(page).locator('[data-dock-column="Checkpoint"]');
const dataColumn = (page: Page) => dialog(page).locator('[data-dock-column="Data"]');
const row = (page: Page, path: string) => dialog(page).locator(`[data-checkpoint-row="${path}"]`);

const CLEAN = 'wcp_0a1b2c3d-1111-4111-8111-00000000c1ea';
const WARNED = 'wcp_7f3a91e0-2222-4222-8222-00000000c21e';

async function open(page: Page) {
  await page.goto('./');
  await expect(bar(page)).toBeVisible();
  await page.locator('[data-action="scenario-checkpoints"]').click();
  await bar(page).getByRole('button', { name: 'Inspect', exact: true }).click();
  await expect(dock(page)).toBeVisible();
}

async function selectVisit(page: Page, executionId: number) {
  await tab(page, 'Trace').click();
  await page.locator(`[data-execution="${executionId}"]`).click();
}

async function requests(page: Page): Promise<readonly string[]> {
  return page.evaluate(() => [...(window.inspectorFixture?.requestPaths() ?? [])]);
}

test('a saved visit replaces Operations and Evidence with what it saved and what it did not', async ({
  page,
}) => {
  await open(page);
  await selectVisit(page, 203);

  await expect(dock(page).locator('header')).toContainText('· Phase 2');
  await expect(dialog(page).locator('[data-dock-column="Operations"]')).toHaveCount(0);
  await expect(dialog(page).locator('[data-dock-column="Evidence"]')).toHaveCount(0);

  const column = checkpointColumn(page);
  await expect(column).toContainText('this capture');
  await expect(column).toContainText('wcp_7f3a…c21e');
  await expect(column).toContainText('git · a41c9e2');
  await expect(column).toContainText('3 scopes · 10 files · 1 absent');

  // Warnings are read from the detail, grouped by reason, sampled and totalled.
  const dirty = column.locator('[data-checkpoint-warning="uncaptured_dirty_path"]');
  await expect(dirty).toContainText('Changed, not saved');
  await expect(dirty).toContainText('3,418');
  await expect(dirty.locator('li')).toHaveCount(6);
  await expect(dirty).toContainText('+ 3,413 more');
  await expect(column.locator('[data-checkpoint-warning="symlink_skipped"]')).toBeVisible();
  // Every Git checkpoint has this one, so it is a standing note, never a warning.
  await expect(column.locator('[data-checkpoint-standing="ignored_paths"]')).toBeVisible();
  await expect(
    column.locator('[data-checkpoint-warning="ignored_paths_not_surveyed"]'),
  ).toHaveCount(0);
  await expect(column.locator('[data-checkpoint-all-clear]')).toHaveCount(0);
  // No export command in the dock.
  await expect(column).not.toContainText('isagi checkpoints export');

  // The parent is the visit that saved it, and a way there.
  await column.locator('[data-field-select="parent"]').click();
  await expect(dock(page).locator('header')).toContainText('· Phase 1');
  await expect(checkpointColumn(page).locator('[data-checkpoint-all-clear]')).toBeVisible();
  await expect(checkpointColumn(page)).toContainText('none');
});

test('a failed capture saved nothing and keeps its failure rows, with no reason row', async ({
  page,
}) => {
  await open(page);
  await selectVisit(page, 204);

  await expect(checkpointColumn(page)).toContainText(
    'Nothing was saved. No checkpoint exists for this visit.',
  );
  const recorded = dialog(page).locator('[data-dock-column="Recorded"]');
  await expect(recorded).toContainText('A checkpoint could not capture its files.');
  await expect(recorded).toContainText('checkpoint_capture_failed');
  await expect(recorded.locator('dt', { hasText: /^reason$/ })).toHaveCount(0);
  await expect(dataColumn(page).locator('[data-tab="checkpoint.files"]')).toHaveCount(0);
});

test('the file count opens the whole tree, across every inventory page', async ({ page }) => {
  await open(page);
  await selectVisit(page, 203);
  await checkpointColumn(page).locator('[data-field-tab="checkpoint.files"]').click();

  await expect(dataColumn(page).locator('[data-tab="checkpoint.files"]')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  // Scope roots under their full paths, labelled with their scope ids.
  await expect(row(page, 'scratch/story/design')).toContainText('design');
  await expect(row(page, 'scratch/story/planning')).toContainText('implementation');
  await expect(row(page, 'scratch/story/decisions.md')).toContainText('decisions');
  // The last page's entries are there, so the continuation was followed.
  await expect(dialog(page).locator('[data-checkpoint-row-kind="file"]')).toHaveCount(10);
  const inventoryReads = (await requests(page)).filter((path) =>
    path.includes(`/checkpoints/${WARNED}/inventory`),
  );
  expect(inventoryReads.length).toBeGreaterThan(1);
  // A required absence is struck through; a skipped symlink is a warning, not a file.
  await expect(
    row(page, 'scratch/story/design/obsolete.md').locator('.line-through'),
  ).toBeVisible();
  await expect(row(page, 'scratch/story/design/latest.md')).toHaveCount(0);

  await row(page, 'scratch/story/design/obsolete.md').click();
  await expect(dataColumn(page)).toContainText(
    "Deleted by this checkpoint. An export makes sure it doesn't exist, even though git · a41c9e2 has it.",
  );

  // Collapsing a directory hides its rows and says how many files it holds.
  await row(page, 'scratch/story/planning').click();
  await expect(row(page, 'scratch/story/planning')).toContainText('5 files');
  await expect(row(page, 'scratch/story/planning/tasks.json')).toHaveCount(0);
});

test('saved files render by path, never run, and keep their record when bytes are gone', async ({
  page,
}) => {
  await open(page);
  await selectVisit(page, 203);
  await checkpointColumn(page).locator('[data-field-tab="checkpoint.files"]').click();
  const data = dataColumn(page);

  // Markdown as text, reached from the keyboard.
  await row(page, 'scratch/story/design/architecture.md').focus();
  await page.keyboard.press('Enter');
  await expect(data).toContainText('One checkpoint row per visit.');
  await expect(data).toContainText('covered by');
  await expect(data).toContainText('not executable');

  // JSON as a tree.
  await row(page, 'scratch/story/planning/tasks.json').click();
  await expect(data).toContainText('files tab');

  // SVG through an image element, typed from its path, with its script never run.
  await row(page, 'scratch/story/design/state-diagram.svg').click();
  const image = data.locator('img');
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((node) => (node as HTMLImageElement).naturalWidth))
    .toBe(24);
  expect(
    await page.evaluate(() => (window as unknown as { svgRan?: boolean }).svgRan),
  ).toBeUndefined();

  // HTML is download only: no frame, no script.
  await row(page, 'scratch/story/planning/report.html').click();
  await expect(data).toContainText('No preview for this type. Download it and open it yourself.');
  await expect(data.locator('iframe')).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as unknown as { htmlRan?: boolean }).htmlRan),
  ).toBeUndefined();

  // The executable bit is part of the record.
  await row(page, 'scratch/story/planning/run.sh').click();
  await expect(data).toContainText('executable');

  // Over the cap, nothing is fetched until asked.
  await page.evaluate(() => window.inspectorFixture?.resetRequests());
  await row(page, 'scratch/story/design/program-design.md').click();
  await expect(data.locator('[data-content-load]')).toBeVisible();
  expect((await requests(page)).some((path) => path.includes('/files/wcf_big/content'))).toBe(
    false,
  );
  await data.locator('[data-content-load]').click();
  await expect(data).toContainText('Preview stops at 256 KB.');

  // Bytes the store cannot serve: the record stays, the cause is Isagi's copy, not the runtime's.
  await row(page, 'scratch/story/planning/gone.md').click();
  await expect(data.locator('[data-content-unavailable]')).toContainText(
    "Saved, but Isagi can't read it back.",
  );
  await expect(data.locator('[data-content-unavailable]')).toContainText('corrupt');
  await expect(data).toContainText('scratch/story/planning/gone.md');
  await expect(data).toContainText('sha256');
  await expect(data).not.toContainText('raw runtime diagnostic text');

  // A read that failed without a cause is a failed read, not lost bytes, and can be tried again.
  await row(page, 'scratch/story/planning/notes.md').click();
  await expect(data.locator('[data-content-read-failed]')).toContainText(
    "Isagi couldn't read these bytes just now.",
  );
  await expect(data.locator('[data-content-unavailable]')).toHaveCount(0);
  await expect(data).toContainText('scratch/story/planning/notes.md');
  await data
    .locator('[data-content-read-failed]')
    .getByRole('button', { name: 'Try again' })
    .click();
  await expect(data).toContainText('Read on the second try.');
});

test('a download is a blob named after the saved file', async ({ page }) => {
  await open(page);
  await selectVisit(page, 203);
  await checkpointColumn(page).locator('[data-field-tab="checkpoint.files"]').click();
  await row(page, 'scratch/story/planning/report.html').click();

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    dataColumn(page).locator('[data-content-download]').click(),
  ]);
  expect(download.url().startsWith('blob:')).toBe(true);
  expect(download.suggestedFilename()).toBe('report.html');
});

test('the Checkpoints tab lists every checkpoint, moves the dock, and keeps its choice', async ({
  page,
}) => {
  await open(page);
  // The inspector opens on the failed visit, which saved nothing, so the tab seeds the latest.
  await tab(page, 'Checkpoints').click();
  const item = (id: string) => dialog(page).locator(`[data-checkpoint-item="${id}"]`);
  await expect(dialog(page).getByRole('group', { name: 'savePhase' })).toContainText('2 visits');
  await expect(item(WARNED)).toHaveAttribute('aria-selected', 'true');
  await expect(item(CLEAN)).toHaveAttribute('aria-selected', 'false');
  // No counts or warning badges on the list.
  await expect(item(WARNED)).not.toContainText('files');

  // Choosing one moves the dock to the visit that saved it.
  await item(CLEAN).click();
  await expect(dock(page).locator('header')).toContainText('· Phase 1');
  await expect(dialog(page).locator(`[data-checkpoint-files="${CLEAN}"]`)).toBeVisible();

  // The export line, knowingly ahead of the command.
  const exportLine = dialog(page).locator('[data-checkpoint-export]');
  await expect(exportLine).toHaveText(
    `isagi checkpoints export ${CLEAN} --run 77 --output <directory>`,
  );
  await expect(dialog(page)).toContainText('Runs once the checkpoint export command ships.');
  await page.evaluate(() => {
    const scope = window as unknown as { copied: string[] };
    scope.copied = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: (text: string) => (scope.copied.push(text), Promise.resolve()) },
    });
  });
  await dialog(page).locator('[data-checkpoint-export-copy]').click();
  await expect(dialog(page).locator('[data-checkpoint-export-copy]')).toHaveText('Copied');
  expect(await page.evaluate(() => (window as unknown as { copied: string[] }).copied)).toEqual([
    `isagi checkpoints export ${CLEAN} --run 77 --output <directory>`,
  ]);

  // Moving the dock elsewhere does not take the choice with it.
  await selectVisit(page, 203);
  await tab(page, 'Checkpoints').click();
  await expect(item(CLEAN)).toHaveAttribute('aria-selected', 'true');
});
