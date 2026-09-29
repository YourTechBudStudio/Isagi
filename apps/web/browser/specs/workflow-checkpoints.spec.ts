import { expect, test, type Page } from '@playwright/test';

/**
 * Saved checkpoints in the production inspector, over the same fake runtime.
 *
 * The fixture run loops over one checkpoint node three times: a small capture, a full one, and one
 * that failed and saved nothing. Everything here needs a browser: opening the files tab from the
 * column, bytes that arrive as octet-stream and still render by path, an SVG and an HTML file whose
 * scripts must not run, a download, and a list that moves the dock.
 */

const bar = (page: Page) => page.getByRole('region', { name: 'Workflow' });
const dialog = (page: Page) => page.getByRole('dialog');
const dock = (page: Page) => dialog(page).getByRole('region', { name: 'Selection details' });
const dockHeader = (page: Page) => dock(page).locator('header').first();
const tab = (page: Page, name: 'Declared' | 'Trace' | 'Checkpoints') =>
  dialog(page).getByRole('tab', { name, exact: true });
const checkpointColumn = (page: Page) => dialog(page).locator('[data-dock-column="Checkpoint"]');
const dataColumn = (page: Page) => dialog(page).locator('[data-dock-column="Data"]');
const row = (page: Page, path: string) => dialog(page).locator(`[data-checkpoint-row="${path}"]`);

const SMALL = 1;
const FULL = 2;

async function open(page: Page) {
  await page.goto('./');
  await expect(bar(page)).toBeVisible();
  await page.locator('[data-action="scenario-checkpoints"]').click();
  await bar(page).getByRole('button', { name: 'Inspect', exact: true }).click();
  await expect(dockHeader(page)).toBeVisible();
}

async function selectExecution(page: Page, executionId: number) {
  await tab(page, 'Trace').click();
  await page.locator(`[data-execution="${executionId}"]`).click();
}

async function openFiles(page: Page) {
  await selectExecution(page, 203);
  await checkpointColumn(page).locator('[data-field-tab="checkpoint.files"]').click();
  await expect(row(page, 'scratch/story/design')).toBeVisible();
}

async function requests(page: Page): Promise<readonly string[]> {
  return page.evaluate(() => [...(window.inspectorFixture?.requestPaths() ?? [])]);
}

test('a saved checkpoint replaces Operations with what it saved', async ({ page }) => {
  await open(page);
  await selectExecution(page, 203);

  await expect(dockHeader(page)).toContainText('· Phase 2');
  await expect(dialog(page).locator('[data-dock-column^="Operations"]')).toHaveCount(0);

  const column = checkpointColumn(page);
  await expect(column).toContainText(`#${FULL}`);
  // The node's own title, and the label this visit captured.
  await expect(column).toContainText('Save completed phase');
  await expect(column).toContainText('Phase 2');
  await expect(column).toContainText('git · a41c9e2');
  await expect(column).toContainText('design, implementation, decisions, reviews (missing)');
  await expect(column).toContainText('4 scopes · 10 files');
  // The export command belongs to the Checkpoints tab, not to the dock.
  await expect(column).not.toContainText('isagi checkpoints export');
});

test('a failed capture saved nothing and keeps its failure rows', async ({ page }) => {
  await open(page);
  await selectExecution(page, 204);

  await expect(checkpointColumn(page)).toContainText(
    'Nothing was saved. No checkpoint exists for this step.',
  );
  const recorded = dialog(page).locator('[data-dock-column="Recorded"]');
  await expect(recorded).toContainText("A checkpoint couldn't capture its files.");
  await expect(recorded).toContainText('checkpoint_capture');
  await expect(dataColumn(page).locator('[data-tab="checkpoint.files"]')).toHaveCount(0);
});

test('the file count opens every scope, including one that did not exist', async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.inspectorFixture?.resetRequests());
  await openFiles(page);

  await expect(dataColumn(page).locator('[data-tab="checkpoint.files"]')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  // One root per scope, under its full path, labelled with its scope name.
  await expect(row(page, 'scratch/story/design')).toContainText('design');
  await expect(row(page, 'scratch/story/planning')).toContainText('implementation');
  await expect(row(page, 'scratch/story/decisions.md')).toContainText('decisions');
  await expect(dialog(page).locator('[data-checkpoint-row-kind="file"]')).toHaveCount(10);
  // The whole checkpoint is one read; there is no inventory to page through any more.
  expect(
    (await requests(page)).filter((path) => path === `GET /workflows/checkpoints/${FULL}`),
  ).toHaveLength(1);

  // A scope that did not exist is struck through, and says what an export does with it.
  const missing = row(page, 'scratch/story/reviews');
  await expect(missing).toHaveAttribute('data-checkpoint-row-kind', 'missing');
  await expect(missing.locator('.line-through')).toBeVisible();
  await missing.click();
  await expect(dataColumn(page)).toContainText(
    "This path didn't exist when the checkpoint was taken. An export makes sure it doesn't exist.",
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
  await openFiles(page);
  const data = dataColumn(page);

  // Markdown as text, reached from the keyboard.
  await row(page, 'scratch/story/design/architecture.md').focus();
  await page.keyboard.press('Enter');
  await expect(data).toContainText('One checkpoint per phase.');
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

  // HTML: source first, and a rendered preview only on request, in a sandboxed frame.
  await row(page, 'scratch/story/planning/report.html').click();
  await expect(data).toContainText('<h1 id="report">Report</h1>');
  await expect(data.locator('iframe')).toHaveCount(0);
  await data.locator('[data-html-mode="render"]').click();
  const frame = data.locator('iframe');
  await expect(frame).toHaveAttribute('sandbox', '');
  await expect(page.frameLocator('[data-dock-column="Data"] iframe').locator('#report')).toHaveText(
    'Report',
  );
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
  expect((await requests(page)).some((path) => path.includes('program-design.md'))).toBe(false);
  await data.locator('[data-content-load]').click();
  await expect(data).toContainText('Preview stops at 256 KB.');

  // Bytes the store cannot serve: the record stays, and the sentence is Isagi's, not the runtime's.
  await row(page, 'scratch/story/planning/gone.md').click();
  await expect(data.locator('[data-content-unavailable]')).toContainText(
    "Saved, but Isagi can't read it back.",
  );
  await expect(data).toContainText('scratch/story/planning/gone.md');
  await expect(data).toContainText('sha256');
  await expect(data).not.toContainText('raw runtime diagnostic text');

  // A read that failed without a cause is a failed read, not lost bytes, and can be tried again.
  await row(page, 'scratch/story/planning/notes.md').click();
  await expect(data.locator('[data-content-read-failed]')).toContainText(
    "Isagi couldn't read these bytes just now.",
  );
  await expect(data.locator('[data-content-unavailable]')).toHaveCount(0);
  await data
    .locator('[data-content-read-failed]')
    .getByRole('button', { name: 'Try again' })
    .click();
  await expect(data).toContainText('Read on the second try.');
});

test('a download is a blob named after the saved file', async ({ page }) => {
  await open(page);
  await openFiles(page);
  await row(page, 'scratch/story/planning/run.sh').click();

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    dataColumn(page).locator('[data-content-download]').click(),
  ]);
  expect(download.url().startsWith('blob:')).toBe(true);
  expect(download.suggestedFilename()).toBe('run.sh');
});

test('the Checkpoints tab lists every checkpoint, moves the dock, and keeps its choice', async ({
  page,
}) => {
  await open(page);
  // The inspector opens on the failed execution, which saved nothing, so the tab seeds the latest.
  await tab(page, 'Checkpoints').click();
  const item = (id: number) => dialog(page).locator(`[data-checkpoint-item="${id}"]`);
  await expect(dialog(page).getByRole('group', { name: 'savePhase' })).toContainText('2 captures');
  await expect(item(FULL)).toHaveAttribute('aria-selected', 'true');
  await expect(item(SMALL)).toHaveAttribute('aria-selected', 'false');
  await expect(item(FULL)).toContainText('design, implementation, decisions, reviews (missing)');
  await expect(item(SMALL)).toContainText('Save completed phase');
  await expect(item(SMALL)).toContainText('Phase 1');

  // Choosing one moves the dock to the execution that saved it.
  await item(SMALL).click();
  await expect(dockHeader(page)).toContainText('· Phase 1');
  await expect(dialog(page).locator(`[data-checkpoint-files="${SMALL}"]`)).toBeVisible();

  const command = `isagi checkpoints export ${SMALL} --output <directory>`;
  await expect(dialog(page).locator('[data-checkpoint-export]')).toHaveText(command);
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
    command,
  ]);

  // Moving the dock elsewhere does not take the choice with it.
  await selectExecution(page, 203);
  await tab(page, 'Checkpoints').click();
  await expect(item(SMALL)).toHaveAttribute('aria-selected', 'true');
});
