import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Rail drag reordering, against the production `Rail` and a fake runtime.
 *
 * Everything here is mechanical — activation distance, which hovers are legal,
 * what a drop persists, edge auto-scroll, cancellation, rollback, and what a
 * drag must *not* disturb — because none of it can be tested anywhere else: the
 * web unit harness renders to static markup and has no pointer.
 *
 * Rows are located through the drag engine's own `data-drag-source` attribute
 * rather than through markers added for testing. It is `"<scope key>#<id>"`, so
 * a selector states the scope it means and cannot silently match a row in the
 * wrong list.
 */

const OVERLAY = '[data-rail-drag-overlay]';

const row = (page: Page, source: string) => page.locator(`[data-drag-source="${source}"]`);
const scope = (page: Page, key: string) => page.locator(`[data-drag-scope="${key}"]`);

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
async function pickUp(page: Page, source: string) {
  const start = await box(row(page, source));
  await page.mouse.move(start.x + 24, start.y + 8);
  await page.mouse.down();
  await page.mouse.move(start.x + 24, start.y + 20, { steps: 4 });
  return start;
}

async function hover(page: Page, x: number, y: number) {
  await page.mouse.move(x, y, { steps: 8 });
}

/** Press somewhere and pull, far enough that a drag would have started by now. */
async function pull(page: Page, x: number, y: number) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + 40, { steps: 5 });
}

/** Drive one drop the fixture runtime refuses, leaving its notice on screen. */
async function refuseDrop(page: Page, source: string, destination: string) {
  await page.evaluate(() => window.railFixture!.failNextWrite());
  await pickUp(page, source);
  const target = await rawBox(row(page, destination));
  await hover(page, target.x + 24, target.y);
  await page.mouse.up();
}

/** What the *runtime* holds, which is the only proof a drop actually persisted. */
const persistedOrder = (page: Page) => page.evaluate(() => window.railFixture!.order());

const indexOf = (text: string, needle: string) => {
  const at = text.indexOf(needle);
  expect(at, `expected to find ${needle}`).toBeGreaterThan(-1);
  return at;
};

test.beforeEach(async ({ page }) => {
  await page.goto('./');
  // The rail is behind a real query, so wait for the snapshot rather than for
  // the shell that will render an empty rail while it loads.
  await expect(row(page, 'projects#1')).toBeVisible();
  await expect(row(page, 'surfaces:12#121')).toBeVisible();
});

test('a press that never travels stays a click and selects the surface', async ({ page }) => {
  const target = await box(row(page, 'surfaces:12#123'));
  await page.mouse.move(target.x + 24, target.y + 8);
  await page.mouse.down();
  // Under the ~5px activation distance, so this is still a click.
  await page.mouse.move(target.x + 26, target.y + 10, { steps: 3 });
  await expect(page.locator(OVERLAY)).toHaveCount(0);
  await page.mouse.up();

  await expect(
    page.locator('[aria-current="true"]').filter({ hasText: 'pnpm check' }),
  ).toBeVisible();
});

test('crossing the activation distance starts a drag and suppresses the click', async ({
  page,
}) => {
  const selected = page.locator('[aria-current="true"]').filter({ hasText: 'scratch' });
  await expect(selected).toHaveCount(0);

  await pickUp(page, 'surfaces:12#124');
  await expect(page.locator(OVERLAY)).toBeVisible();
  await page.mouse.up();

  // The gesture must not also select the row it started from.
  await expect(selected).toHaveCount(0);
});

test('a surface drops before the sibling it is released over', async ({ page }) => {
  await pickUp(page, 'surfaces:12#121');
  const destination = await rawBox(row(page, 'surfaces:12#124'));
  await hover(page, destination.x + 24, destination.y);
  await page.mouse.up();

  await expect
    .poll(async () => {
      const order = await persistedOrder(page);
      return indexOf(order, 'pnpm check') < indexOf(order, 'plan review');
    })
    .toBe(true);
  const order = await persistedOrder(page);
  expect(indexOf(order, 'plan review')).toBeLessThan(indexOf(order, 'scratch'));
});

/**
 * Carrying the *last* row to the top is the case that shifts every sibling at
 * once, and it is where a collapsing placeholder went wrong: the list lost a
 * row's height while its siblings were pushed down by that same height, so the
 * bottom of the list fell outside a container that clips — each row's own
 * removal-animation wrapper, and the rail's scroll box, which a transform does
 * not extend. The siblings did not move, they vanished. Asserted for all three
 * scopes because all three clip differently.
 */
for (const scenario of [
  { name: 'surface', source: 'surfaces:12#124', prefix: 'surfaces:12#', siblings: 3 },
  { name: 'worktree', source: 'worktrees:1#15', prefix: 'worktrees:1#', siblings: 3 },
  { name: 'project', source: 'projects#3', prefix: 'projects#', siblings: 2 },
] as const) {
  test(`carrying the last ${scenario.name} to the top keeps every sibling visible`, async ({
    page,
  }) => {
    // Matched by scope prefix, not by container: a project's container encloses
    // its worktrees' and surfaces' sources too.
    const rows = page.locator(`[data-drag-source^="${scenario.prefix}"]`);
    const others = page.locator(
      `[data-drag-source^="${scenario.prefix}"]:not([data-drag-source="${scenario.source}"])`,
    );

    await pickUp(page, scenario.source);
    const top = await rawBox(rows.first());
    await hover(page, top.x + 24, top.y + 1);

    // The carried row keeps its box and only goes invisible, so the list is the
    // same height it always was and every sibling is still laid out inside it.
    await expect(others).toHaveCount(scenario.siblings);
    for (let index = 0; index < scenario.siblings; index += 1) {
      await expect(others.nth(index)).toBeVisible();
    }

    await page.mouse.up();
  });
}

test('dropping past the last sibling appends', async ({ page }) => {
  await pickUp(page, 'surfaces:12#121');
  const last = await rawBox(row(page, 'surfaces:12#124'));
  await hover(page, last.x + 24, last.y + last.height - 1);
  await page.mouse.up();

  await expect
    .poll(async () => {
      const order = await persistedOrder(page);
      return indexOf(order, 'scratch') < indexOf(order, 'plan review');
    })
    .toBe(true);
});

test('a worktree reorders within its project and the root stays pinned', async ({ page }) => {
  await pickUp(page, 'worktrees:1#15');
  const destination = await rawBox(row(page, 'worktrees:1#13'));
  await hover(page, destination.x + 24, destination.y);
  await page.mouse.up();

  await expect
    .poll(async () => {
      const order = await persistedOrder(page);
      return indexOf(order, 'harness ledger') < indexOf(order, 'update footer polish');
    })
    .toBe(true);
  const order = await persistedOrder(page);
  expect(indexOf(order, 'main')).toBeLessThan(indexOf(order, 'harness ledger'));
});

test('a project reorders among the present projects', async ({ page }) => {
  const header = await box(page.locator('[data-drag-source="projects#3"] [data-project-header]'));
  await page.mouse.move(header.x + 30, header.y + header.height / 2);
  await page.mouse.down();
  await page.mouse.move(header.x + 30, header.y + header.height / 2 - 30, { steps: 5 });

  const destination = await rawBox(row(page, 'projects#2'));
  await hover(page, destination.x + 24, destination.y);
  await page.mouse.up();

  await expect
    .poll(async () => {
      const order = await persistedOrder(page);
      return indexOf(order, 'sketchbook') < indexOf(order, 'toph');
    })
    .toBe(true);
});

test('the drop lands in one commit instead of replaying the move', async ({ page }) => {
  // The reflowed sibling is the honest subject: the carried row legitimately
  // changes place once, but a row the reflow already moved is where a second
  // animation shows up. Its on-screen position is the *inner* node — the drag's
  // transform lives below the registered element, which never moves.
  // `toph` is the project the reflow moves when `sketchbook` is carried above
  // it; `isagi`, above the insertion point, never moves and would prove nothing.
  const reflowed = '[data-drag-source="projects#2"] > div > div';

  const header = await box(page.locator('[data-drag-source="projects#3"] [data-project-header]'));
  await page.mouse.move(header.x + 30, header.y + header.height / 2);
  await page.mouse.down();
  await page.mouse.move(header.x + 30, header.y + header.height / 2 - 30, { steps: 5 });
  const destination = await rawBox(row(page, 'projects#2'));
  await hover(page, destination.x + 24, destination.y);
  // The reflow eases the gap open; sampling has to start once it has arrived,
  // or the drag's own animation would be indistinguishable from a second one.
  await page.waitForTimeout(400);

  // Sample every frame across the drop. Dropping used to clear the transforms a
  // frame before the new order reached the cache, so the list snapped back to
  // the old order and Motion — its `layout` just re-enabled — then animated the
  // reorder a second time. Holding the drag's final visual until the cache
  // agrees means this row is already where it belongs and never moves again.
  await page.evaluate((selector) => {
    const samples: number[] = [];
    (window as unknown as { samples: number[] }).samples = samples;
    let frames = 0;
    const tick = () => {
      // Re-queried every frame: a row that remounts would otherwise leave the
      // sampler measuring a detached node and reporting a reassuring constant.
      const element = document.querySelector(selector);
      samples.push(element ? Math.round(element.getBoundingClientRect().top) : -1);
      if ((frames += 1) < 45) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, reflowed);

  await page.mouse.up();
  await expect
    .poll(async () => {
      const order = await persistedOrder(page);
      return indexOf(order, 'sketchbook') < indexOf(order, 'toph');
    })
    .toBe(true);
  await page.waitForTimeout(600);

  const samples = await page.evaluate(() => (window as unknown as { samples: number[] }).samples);
  expect(samples.length).toBeGreaterThan(20);
  expect([...new Set(samples)]).toHaveLength(1);
});

test('a surface may not be dropped into a worktree list', async ({ page }) => {
  const before = await persistedOrder(page);
  await pickUp(page, 'surfaces:12#121');
  const foreign = await rawBox(row(page, 'worktrees:1#13'));
  await hover(page, foreign.x + 24, foreign.y + 10);

  await expect(page.locator(`${OVERLAY}[data-overlay-valid="false"]`)).toBeVisible();
  expect(await page.evaluate(() => document.body.style.cursor)).toBe('not-allowed');

  await page.mouse.up();
  expect(await persistedOrder(page)).toBe(before);
});

test('a worktree may not be dropped into another project', async ({ page }) => {
  const before = await persistedOrder(page);
  await pickUp(page, 'worktrees:1#13');
  const foreign = await rawBox(row(page, 'worktrees:2#22'));
  await hover(page, foreign.x + 24, foreign.y + 10);

  await expect(page.locator(`${OVERLAY}[data-overlay-valid="false"]`)).toBeVisible();
  await page.mouse.up();
  expect(await persistedOrder(page)).toBe(before);
});

test('a project may not be dropped into the Disconnected section', async ({ page }) => {
  const before = await persistedOrder(page);
  const header = await box(page.locator('[data-drag-source="projects#3"] [data-project-header]'));
  await page.mouse.move(header.x + 30, header.y + header.height / 2);
  await page.mouse.down();
  await page.mouse.move(header.x + 30, header.y + header.height / 2 + 20, { steps: 4 });

  const disconnected = await rawBox(page.getByRole('button', { name: 'archive-2025' }));
  await hover(page, disconnected.x + 24, disconnected.y + 10);

  await expect(page.locator(`${OVERLAY}[data-overlay-valid="false"]`)).toBeVisible();
  await page.mouse.up();
  expect(await persistedOrder(page)).toBe(before);
});

test('the root worktree is neither a drag source nor a target above itself', async ({ page }) => {
  const root = await box(scope(page, 'worktrees:1').locator('[data-drag-pinned]'));

  // Immovable, and it absorbs the press rather than letting it fall through to
  // the project it sits inside. Nothing lifts; the refusal cursor is the whole
  // of the feedback, and refusing a drag is not selecting either.
  await page.mouse.move(root.x + 24, root.y + 8);
  await page.mouse.down();
  await page.mouse.move(root.x + 24, root.y + 30, { steps: 5 });
  await expect(page.locator(OVERLAY)).toHaveCount(0);
  expect(await page.evaluate(() => document.body.style.cursor)).toBe('not-allowed');
  await page.mouse.up();
  await expect(page.locator('[aria-current="true"]').filter({ hasText: 'main' })).toHaveCount(0);

  // Not a target above itself: however far up the pointer travels, the topmost
  // slot is still below the root, because the root registers no source and so
  // contributes no boundary of its own.
  const before = await persistedOrder(page);
  await pickUp(page, 'worktrees:1#13');
  const rootNow = await rawBox(scope(page, 'worktrees:1').locator('[data-drag-pinned]'));
  await hover(page, rootNow.x + 24, rootNow.y + 2);
  await page.mouse.up();

  await expect
    .poll(async () => {
      const order = await persistedOrder(page);
      return indexOf(order, 'main') < indexOf(order, 'update footer polish');
    })
    .toBe(true);
  expect(await persistedOrder(page)).not.toBe(before);
});

test('a project is still picked up by its header once the root is inert', async ({ page }) => {
  // The root absorbing its press leaves the header strip as the only grab area
  // for a project. Thin, and deliberately so — but it must actually work.
  const header = await box(page.locator('[data-drag-source="projects#2"] [data-project-header]'));
  await page.mouse.move(header.x + 30, header.y + header.height / 2);
  await page.mouse.down();
  await page.mouse.move(header.x + 30, header.y + header.height / 2 + 20, { steps: 4 });

  await expect(page.locator(OVERLAY)).toHaveAttribute('data-overlay-ref', 'projects#2');
  await page.keyboard.press('Escape');
  await page.mouse.up();
});

test('the add-worktree control inside a project header does not start a drag', async ({ page }) => {
  const project = page.locator('[data-drag-source="projects#2"]');
  await project.hover();
  const add = await box(project.getByTitle('Open worktree'));
  await page.mouse.move(add.x + add.width / 2, add.y + add.height / 2);
  await page.mouse.down();
  await page.mouse.move(add.x + add.width / 2, add.y + 40, { steps: 5 });

  await expect(page.locator(OVERLAY)).toHaveCount(0);
  await page.mouse.up();
});

test('right-click still opens the context menu for every scope', async ({ page }) => {
  for (const [source, item] of [
    ['worktrees:1#13', 'Delete worktree'],
    ['surfaces:12#121', 'Rename'],
  ] as const) {
    await row(page, source).click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: item })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menuitem', { name: item })).toHaveCount(0);
  }
});

test('Escape cancels the gesture and leaves the order alone', async ({ page }) => {
  const before = await persistedOrder(page);

  await pickUp(page, 'surfaces:12#121');
  const destination = await rawBox(row(page, 'surfaces:12#124'));
  await hover(page, destination.x + 24, destination.y);
  await expect(page.locator(OVERLAY)).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.locator(OVERLAY)).toHaveCount(0);
  await page.mouse.up();

  expect(await persistedOrder(page)).toBe(before);
});

test('a refused write restores the list and says so at the row, until dismissed', async ({
  page,
}) => {
  await page.evaluate(() => window.railFixture!.failNextWrite());
  const before = await persistedOrder(page);

  await pickUp(page, 'surfaces:12#121');
  const destination = await rawBox(row(page, 'surfaces:12#124'));
  await hover(page, destination.x + 24, destination.y);
  await page.mouse.up();

  const notice = page.locator('[data-rail-order-failure="surfaces:12"]');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("Couldn't save that order.");
  expect(await persistedOrder(page)).toBe(before);

  // It waits to be read rather than expiring on a timer.
  await page.waitForTimeout(2500);
  await expect(notice).toBeVisible();

  await notice.getByRole('button', { name: 'Dismiss' }).click();
  await expect(notice).toHaveCount(0);
});

test('a refusal notice is inert everywhere, message text included', async ({ page }) => {
  // A notice renders outside the row it is about but still inside the enclosing
  // list's drag source: a surface refusal sits within the worktree source, a
  // worktree refusal within the project source. Pulling on the text of a message
  // about one list must therefore not pick up the list above it.
  for (const [key, source, destination] of [
    ['surfaces:12', 'surfaces:12#121', 'surfaces:12#124'],
    ['worktrees:1', 'worktrees:1#15', 'worktrees:1#13'],
  ] as const) {
    await refuseDrop(page, source, destination);

    const notice = page.locator(`[data-rail-order-failure="${key}"]`);
    await expect(notice).toBeVisible();
    const before = await persistedOrder(page);

    const message = await box(notice.locator('span').first());
    await pull(page, message.x + 8, message.y + message.height / 2);
    await expect(page.locator(OVERLAY)).toHaveCount(0);
    await page.mouse.up();

    expect(await persistedOrder(page)).toBe(before);
    await expect(notice).toBeVisible();
    await notice.getByRole('button', { name: 'Dismiss' }).click();
    await expect(notice).toHaveCount(0);
  }
});

test('a browser-cancelled gesture persists nothing and eats no later click', async ({ page }) => {
  const rows = () => scope(page, 'surfaces:12').locator('[data-drag-source]').allInnerTexts();
  const before = await persistedOrder(page);
  const onScreen = await rows();

  await pickUp(page, 'surfaces:12#122');
  const destination = await rawBox(row(page, 'surfaces:12#124'));
  await hover(page, destination.x + 24, destination.y);
  await expect(page.locator(`${OVERLAY}[data-overlay-valid="true"]`)).toBeVisible();

  // The browser withdrawing the pointer is not a release. Even over a legal
  // slot, nothing lands optimistically and nothing is written.
  await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointercancel')));
  await expect(page.locator(OVERLAY)).toHaveCount(0);
  expect(await page.evaluate(() => document.body.style.cursor)).toBe('');
  expect(await rows()).toEqual(onScreen);
  expect(await persistedOrder(page)).toBe(before);

  // A cancelled sequence fires no click of its own, so nothing may be left armed
  // to swallow one — the next click the page sees belongs to the user.
  const target = await rawBox(row(page, 'surfaces:12#122'));
  await page.mouse.move(target.x + 24, target.y + 8);
  await page.mouse.up();
  await expect(page.locator('[aria-current="true"]').filter({ hasText: 'fixture' })).toBeVisible();
  expect(await persistedOrder(page)).toBe(before);
});

test.describe('edge auto-scroll', () => {
  // Short enough that the rail cannot show every project at once, which is the
  // only condition under which auto-scroll does anything at all.
  test.use({ viewport: { width: 900, height: 420 } });

  test('holding at an edge scrolls the rail and drops onto a newly exposed slot', async ({
    page,
  }) => {
    // The scroll container is the projects scope container's parent — the same
    // element the drag layer hands the engine, reached without a test marker.
    const scroller = scope(page, 'projects').locator('xpath=..');
    const scrollTop = () => scroller.evaluate((element) => element.scrollTop);

    await row(page, 'projects#3').scrollIntoViewIfNeeded();
    expect(await scrollTop()).toBeGreaterThan(0);

    const header = await box(page.locator('[data-drag-source="projects#3"] [data-project-header]'));
    await page.mouse.move(header.x + 30, header.y + header.height / 2);
    await page.mouse.down();
    await page.mouse.move(header.x + 30, header.y + header.height / 2 + 20, { steps: 4 });
    await expect(page.locator(OVERLAY)).toBeVisible();

    // Hold near the top edge and let go of nothing. The list travels under a
    // stationary pointer, so the slot has to be recomputed off animation frames
    // rather than off pointer events.
    const bounds = await rawBox(scroller);
    await hover(page, bounds.x + 60, bounds.y + 16);
    await expect.poll(scrollTop).toBe(0);
    await expect(page.locator(`${OVERLAY}[data-overlay-valid="true"]`)).toBeVisible();

    // Scrolling does not widen where a drop is legal: drifting sideways out of
    // the rail is still refused, and coming back is still accepted.
    await hover(page, bounds.x + bounds.width + 240, bounds.y + 16);
    await expect(page.locator(`${OVERLAY}[data-overlay-valid="false"]`)).toBeVisible();
    await hover(page, bounds.x + 60, bounds.y + 16);
    await expect(page.locator(`${OVERLAY}[data-overlay-valid="true"]`)).toBeVisible();

    await page.mouse.up();

    // The anchor persisted is the one the scrolled-into-view sibling named.
    await expect
      .poll(async () => {
        const order = await persistedOrder(page);
        return indexOf(order, 'sketchbook') < indexOf(order, 'isagi');
      })
      .toBe(true);
  });
});

test('a slow write blocks a second drop in its own scope but not in another', async ({ page }) => {
  // A local write is over in a few ms, which a test can only race. Widening the
  // window observes the same behaviour rather than faking a different one.
  await page.evaluate(() => window.railFixture!.setWriteDelay(3000));

  await pickUp(page, 'surfaces:12#121');
  const destination = await rawBox(row(page, 'surfaces:12#124'));
  await hover(page, destination.x + 24, destination.y);
  await page.mouse.up();

  // The optimistic order is on screen immediately, before the write settles.
  await expect
    .poll(async () => {
      const rows = await scope(page, 'surfaces:12').locator('[data-drag-source]').allInnerTexts();
      return rows.indexOf('plan review') > rows.indexOf('pnpm check');
    })
    .toBe(true);

  // Same list: refused.
  const second = await rawBox(row(page, 'surfaces:12#122'));
  await page.mouse.move(second.x + 24, second.y + 6);
  await page.mouse.down();
  await page.mouse.move(second.x + 24, second.y + 30, { steps: 5 });
  await expect(page.locator(OVERLAY)).toHaveCount(0);
  await page.mouse.up();

  // A different list is untouched by another scope's pending write.
  await pickUp(page, 'worktrees:1#15');
  await expect(page.locator(OVERLAY)).toBeVisible();
  await page.keyboard.press('Escape');
  await page.mouse.up();
});
