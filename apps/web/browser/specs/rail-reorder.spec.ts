import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * The rail reorder fixture's behavior. Everything asserted here is mechanical —
 * activation distance, which hovers are legal, what a drop does to the order,
 * cancel, and rollback — because those are the parts that must survive Phase 05
 * unchanged. The *visual* questions the fixture exists to answer (preview
 * height, source placeholder, guide weight and colour) are the user's to judge,
 * so nothing here asserts on appearance beyond presence.
 */

const OVERLAY = '[data-overlay]';
const GUIDE = '[data-guide]';

const row = (page: Page, id: string) => page.locator(`[data-row="${id}"]`);

async function rawBox(locator: Locator) {
  const value = await locator.boundingBox();
  if (!value) throw new Error('expected the row to be laid out');
  return value;
}

/**
 * The rail scrolls, and a row below the fold still reports geometry — geometry
 * that is clipped, so a mouse press there lands on the scroll container instead
 * of the row. Bring it into view before measuring.
 *
 * Because scrolling invalidates every previously measured row, tests take the
 * source first via `pickUp` and only then measure the destination with
 * `rawBox`, which never scrolls and so cannot move the ground mid-gesture.
 */
async function box(locator: Locator) {
  await locator.scrollIntoViewIfNeeded();
  return rawBox(locator);
}

/** Press a row and travel far enough to activate, without releasing. */
async function pickUp(page: Page, id: string) {
  const start = await box(row(page, id));
  await page.mouse.move(start.x + 24, start.y + 8);
  await page.mouse.down();
  await page.mouse.move(start.x + 24, start.y + 20, { steps: 4 });
  return start;
}

async function hover(page: Page, x: number, y: number) {
  await page.mouse.move(x, y, { steps: 8 });
}

const orderText = (page: Page) => page.locator('[data-order]').innerText();

/**
 * The fixture opens in the chosen treatment — live reflow, which has no
 * insertion guide. Tests about the guide have to ask for the variant that draws
 * one rather than relying on whatever the default happens to be.
 */
async function useGuide(page: Page) {
  await page.click('[data-variant="siblings:stable"]');
}

const indexOf = (text: string, needle: string) => {
  const at = text.indexOf(needle);
  expect(at, `expected to find ${needle}`).toBeGreaterThan(-1);
  return at;
};

test.beforeEach(async ({ page }) => {
  await page.goto('./');
  await expect(page.locator('[data-fixture-rail]')).toBeVisible();
});

test('a press that never travels stays a click and selects exactly once', async ({ page }) => {
  const target = await box(row(page, 'surface-123'));
  await page.mouse.move(target.x + 24, target.y + 8);
  await page.mouse.down();
  // Under the ~5px activation distance, so this is still a click.
  await page.mouse.move(target.x + 26, target.y + 10, { steps: 3 });
  await expect(page.locator(OVERLAY)).toHaveCount(0);
  await page.mouse.up();

  await expect(page.locator('[data-log]')).toHaveText('select surface 123');
});

test('crossing the activation distance starts a drag and suppresses the click', async ({
  page,
}) => {
  await pickUp(page, 'surface-121');
  await expect(page.locator(OVERLAY)).toBeVisible();
  await page.mouse.up();

  // The gesture must not also select the row it started from.
  await expect(page.locator('[data-log]')).not.toContainText('select surface 121');
});

test('a surface drops before the sibling its guide names', async ({ page }) => {
  await useGuide(page);
  await pickUp(page, 'surface-121');
  const destination = await rawBox(row(page, 'surface-124'));
  await hover(page, destination.x + 24, destination.y);

  await expect(page.locator(GUIDE)).toBeVisible();
  await page.mouse.up();

  const order = await orderText(page);
  expect(indexOf(order, 'pnpm check')).toBeLessThan(indexOf(order, 'plan review'));
  expect(indexOf(order, 'plan review')).toBeLessThan(indexOf(order, 'scratch'));
});

test('dropping past the last sibling appends', async ({ page }) => {
  await pickUp(page, 'surface-121');
  const last = await rawBox(row(page, 'surface-124'));
  await hover(page, last.x + 24, last.y + last.height - 1);
  await page.mouse.up();

  const order = await orderText(page);
  expect(indexOf(order, 'scratch')).toBeLessThan(indexOf(order, 'plan review'));
});

test('a surface may not be dropped into a worktree list', async ({ page }) => {
  await useGuide(page);
  await pickUp(page, 'surface-121');
  const foreign = await rawBox(row(page, 'worktree-13'));
  await hover(page, foreign.x + 24, foreign.y + 10);

  await expect(page.locator(GUIDE)).toHaveCount(0);
  await expect(page.locator(`${OVERLAY}[data-overlay-valid="false"]`)).toBeVisible();
  expect(await page.evaluate(() => document.body.style.cursor)).toBe('not-allowed');

  const before = await orderText(page);
  await page.mouse.up();
  expect(await orderText(page)).toBe(before);
});

test('a worktree may not be dropped into another project', async ({ page }) => {
  await useGuide(page);
  await pickUp(page, 'worktree-13');
  const foreign = await rawBox(row(page, 'worktree-22'));
  await hover(page, foreign.x + 24, foreign.y + 10);

  await expect(page.locator(GUIDE)).toHaveCount(0);
  await expect(page.locator(`${OVERLAY}[data-overlay-valid="false"]`)).toBeVisible();
  await page.mouse.up();
});

test('a project may not be dropped into the Disconnected section', async ({ page }) => {
  await useGuide(page);
  await pickUp(page, 'project-3');
  const disconnected = await rawBox(row(page, 'missing-8'));
  await hover(page, disconnected.x + 24, disconnected.y + 10);

  await expect(page.locator(GUIDE)).toHaveCount(0);
  await expect(page.locator(`${OVERLAY}[data-overlay-valid="false"]`)).toBeVisible();
  await page.mouse.up();
});

test('the root worktree is neither a drag source nor a target above itself', async ({ page }) => {
  const root = await box(row(page, 'worktree-11'));

  // Immovable, and it absorbs the press rather than letting it fall through to
  // the project it sits inside. Nothing lifts; the refusal cursor is the whole
  // of the feedback.
  await page.mouse.move(root.x + 24, root.y + 8);
  await page.mouse.down();
  await page.mouse.move(root.x + 24, root.y + 30, { steps: 5 });
  await expect(page.locator(OVERLAY)).toHaveCount(0);
  expect(await page.evaluate(() => document.body.style.cursor)).toBe('not-allowed');
  await page.mouse.up();

  // Refusing a drag is not selecting either.
  await expect(page.locator('[data-log]')).toHaveText('—');

  // Not a target above itself: however far up the pointer travels, the nearest
  // slot is still the one below the root, because the root is not a source and
  // so contributes no boundary of its own.
  await useGuide(page);
  await pickUp(page, 'worktree-13');
  const rootNow = await rawBox(row(page, 'worktree-11'));
  await hover(page, rootNow.x + 24, rootNow.y + 2);
  const guide = await rawBox(page.locator(GUIDE));
  expect(guide.y).toBeGreaterThanOrEqual(rootNow.y + rootNow.height - 3);
  await page.mouse.up();
});

test('a project is still picked up by its header once the root is inert', async ({ page }) => {
  // The root absorbing its press leaves the header strip as the only grab area
  // for a project. Thin, and deliberately so — but it must actually work.
  const header = await box(page.locator('[data-row="project-2"] [data-project-header]'));
  await page.mouse.move(header.x + 30, header.y + header.height / 2);
  await page.mouse.down();
  await page.mouse.move(header.x + 30, header.y + header.height / 2 + 20, { steps: 4 });

  await expect(page.locator(OVERLAY)).toHaveAttribute('data-overlay-ref', 'projects#2');
  await page.keyboard.press('Escape');
  await page.mouse.up();
});

test('a nested control inside a draggable row does not start a drag', async ({ page }) => {
  const add = await box(page.locator('[data-add-worktree="2"]'));
  await page.mouse.move(add.x + add.width / 2, add.y + add.height / 2);
  await page.mouse.down();
  await page.mouse.move(add.x + add.width / 2, add.y + 40, { steps: 5 });

  await expect(page.locator(OVERLAY)).toHaveCount(0);
  await page.mouse.up();
});

test('Escape cancels the gesture and leaves the order alone', async ({ page }) => {
  await useGuide(page);
  const before = await orderText(page);

  await pickUp(page, 'surface-121');
  const destination = await rawBox(row(page, 'surface-124'));
  await hover(page, destination.x + 24, destination.y);
  await expect(page.locator(GUIDE)).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.locator(OVERLAY)).toHaveCount(0);
  await page.mouse.up();

  expect(await orderText(page)).toBe(before);
  await expect(page.locator('[data-log]')).toHaveText('—');
});

test('a rejected write restores the affected list and says so', async ({ page }) => {
  await page.click('[data-control="fail"]');
  const before = await orderText(page);

  await pickUp(page, 'surface-121');
  const destination = await rawBox(row(page, 'surface-124'));
  await hover(page, destination.x + 24, destination.y);
  await page.mouse.up();

  // Optimistic first: the list commits before anything is asked to persist it.
  expect(await orderText(page)).not.toBe(before);

  await expect(page.locator('[data-log]')).toContainText('rejected');
  expect(await orderText(page)).toBe(before);
});

test('the variant controls change the treatment under the pointer', async ({ page }) => {
  await useGuide(page);
  await page.click('[data-variant="tone:blue"]');
  await page.click('[data-variant="overlay:full"]');

  await pickUp(page, 'worktree-13');
  const destination = await rawBox(row(page, 'worktree-15'));
  await hover(page, destination.x + 24, destination.y);

  await expect(page.locator(`${OVERLAY}[data-overlay-variant="full"]`)).toBeVisible();
  await expect(page.locator(`${GUIDE}[data-guide-tone="blue"]`)).toBeVisible();
  await page.mouse.up();
});

test('live reflow replaces the guide rather than joining it', async ({ page }) => {
  await page.click('[data-variant="siblings:reflow"]');

  await pickUp(page, 'surface-121');
  const destination = await rawBox(row(page, 'surface-124'));
  await hover(page, destination.x + 24, destination.y);

  await expect(page.locator(OVERLAY)).toBeVisible();
  await expect(page.locator(GUIDE)).toHaveCount(0);
  await page.mouse.up();

  const order = await orderText(page);
  expect(indexOf(order, 'pnpm check')).toBeLessThan(indexOf(order, 'plan review'));
});

test('a second drop is refused while the first is still in flight', async ({ page }) => {
  // A real local write is over in a few hundred ms, which a test can only race.
  // The slow setting widens the same window instead of faking a different one.
  await page.click('[data-control="slow"]');
  await expect(page.locator('[data-control="slow"]')).toHaveAttribute('aria-pressed', 'true');

  await pickUp(page, 'surface-121');
  const destination = await rawBox(row(page, 'surface-124'));
  await hover(page, destination.x + 24, destination.y);
  await page.mouse.up();
  await expect(page.locator('[data-fixture-rail]')).toHaveAttribute('data-pending', 'surfaces:12');

  // The write is still in flight; the list must not accept another move.
  const second = await rawBox(row(page, 'surface-122'));
  await page.mouse.move(second.x + 24, second.y + 6);
  await page.mouse.down();
  await page.mouse.move(second.x + 24, second.y + 30, { steps: 5 });
  await expect(page.locator(OVERLAY)).toHaveCount(0);
  await page.mouse.up();

  await expect(page.locator('[data-log]')).toContainText('persisted');
});
