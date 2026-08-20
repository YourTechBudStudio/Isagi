import { expect, test, type Page } from '@playwright/test';

import type { CommandSummary } from '@isagi/contracts';

/**
 * The `Commands` palette section and the workbench focus ownership around it,
 * against the **production** `CommandPalette` and `WorkbenchDrawer` over a fake
 * runtime (see `browser/fixture/command-palette/fake-runtime.ts`).
 *
 * Two kinds of test live here, and they are both load-bearing:
 *
 * - **Presentation**, carried over from phase 01 and now asserted against the
 *   real palette instead of a forked shell. These pin the state matrix the
 *   running-cue and copy decisions were approved against.
 * - **Integration**, which is why this page exists at all: the failures that only
 *   happen *between* correct units — the query observer's open/poll lifecycle,
 *   who owns dismissal when the palette sits over the drawer, where focus lands
 *   after queued animation frames, and whether the busy lock actually holds.
 *
 * Rows are located by their label text rather than by markers added for testing,
 * because the label *is* the command name: a selector that stops matching means
 * the row stopped saying what it runs. Nothing here required a test-only branch,
 * selector, or timing knob in shipped code.
 */

/** The palette's scrim and its focusable panel, as the production tree renders them. */
const SCRIM = 'div.fixed.inset-0.z-50';
const PALETTE = `${SCRIM} > div[tabindex="-1"]`;
/** The scrolling entry body inside the panel — the group/row container. */
const PALETTE_BODY = `${PALETTE} > div.overflow-y-auto`;

const palette = (page: Page) => page.locator(PALETTE);
const drawer = (page: Page) => page.getByRole('complementary', { name: 'Commands' });

const row = (page: Page, label: string) =>
  page.locator(`${PALETTE} button`).filter({ has: page.locator(`span:text-is("${label}")`) });

/** Group headers in DOM order — the palette renders one per contiguous group. */
const groupHeaders = (page: Page) => page.locator(`${PALETTE} p.uppercase`);

/** The icon is the first child of the row; its tone is the running/error cue. */
const iconClass = (page: Page, label: string) =>
  row(page, label).locator('svg').getAttribute('class');

async function openPalette(page: Page) {
  await page.keyboard.press('ControlOrMeta+k');
  await expect(palette(page)).toBeVisible();
}

/** Type a query and commit the single row it leaves, so selection never depends on arrow arithmetic. */
async function selectByQuery(page: Page, query: string, label: string) {
  await page.locator(`${PALETTE} input`).fill(query);
  await expect(row(page, label)).toBeVisible();
  await page.keyboard.press('Enter');
}

/** The highlight has no marker of its own; the row background *is* the cue the user sees. */
const HIGHLIGHT = /bg-white\/8/;

/**
 * Walk the highlight onto a row with real `ArrowDown` presses and commit it with
 * `Enter` — the keyboard path the palette is built around, exercised end to end
 * rather than approximated by narrowing the list until one row is left. A
 * regression in the arrow wiring or in where the highlight lands fails here.
 */
async function selectByArrowKeys(page: Page, label: string) {
  const target = row(page, label);
  await expect(target).toBeVisible();
  // If the row started highlighted the arrows below would be decoration, and a
  // broken highlight would still pass; the walk has to be load-bearing.
  await expect(target).not.toHaveClass(HIGHLIGHT);
  // One press per row is the whole list, so a highlight that refuses to move
  // exhausts the budget and fails on the assertion below instead of hanging.
  const budget = await page.locator(`${PALETTE} button`).count();
  for (let step = 0; step < budget; step += 1) {
    if (HIGHLIGHT.test((await target.getAttribute('class')) ?? '')) break;
    await page.keyboard.press('ArrowDown');
  }
  await expect(target).toHaveClass(HIGHLIGHT);
  await page.keyboard.press('Enter');
}

/** Rows per group, keyed by header — how a density question is answered in the DOM. */
function groupCounts(page: Page) {
  return page.evaluate((selector) => {
    const body = document.querySelector(selector);
    const counts: Record<string, number> = {};
    let current = '';
    for (const child of Array.from(body?.children ?? [])) {
      const header = child.querySelector('p.uppercase');
      if (header) current = header.textContent ?? '';
      counts[current] = (counts[current] ?? 0) + 1;
    }
    return counts;
  }, PALETTE_BODY);
}

/**
 * Let every queued animation frame land. The focus scheduler defers through two
 * of them, so an "it did not steal focus" assertion taken any earlier would be
 * asserting that the future has not happened yet.
 */
function settleFrames(page: Page) {
  return page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
      }),
  );
}

const activeElementInside = (page: Page, selector: string) =>
  page.evaluate((value) => Boolean(document.activeElement?.closest(value)), selector);

const fixture = {
  setCatalog: (page: Page, commands: readonly CommandSummary[]) =>
    page.evaluate((value) => window.commandPaletteFixture!.setCatalog(value), commands),
  breakConfig: (page: Page, managedCommands: readonly CommandSummary[] = []) =>
    page.evaluate(
      (value) => window.commandPaletteFixture!.breakConfig(undefined, value),
      managedCommands,
    ),
  actionRequests: (page: Page) =>
    page.evaluate(() => window.commandPaletteFixture!.actionRequests()),
  applyScenario: (page: Page, scenario: 'suspended' | 'removed' | 'managed' | 'diagnostic') =>
    page.evaluate((value) => window.commandPaletteFixture!.applyScenario(value), scenario),
  setCatalogUnavailable: (page: Page, unavailable: boolean) =>
    page.evaluate(
      (value) => window.commandPaletteFixture!.setCatalogUnavailable(value),
      unavailable,
    ),
  setWorkflows: (page: Page, titles: readonly string[]) =>
    page.evaluate((value) => window.commandPaletteFixture!.setWorkflows(value), titles),
  setActiveWorktree: (page: Page, worktreeId: number | null) =>
    page.evaluate((value) => window.commandPaletteFixture!.setActiveWorktree(value), worktreeId),
  failNextRun: (page: Page) => page.evaluate(() => window.commandPaletteFixture!.failNextRun()),
  setRunDelay: (page: Page, ms: number) =>
    page.evaluate((value) => window.commandPaletteFixture!.setRunDelay(value), ms),
  commandsFetchCount: (page: Page, worktreeId?: number) =>
    page.evaluate((value) => window.commandPaletteFixture!.commandsFetchCount(value), worktreeId),
  runRequests: (page: Page) => page.evaluate(() => window.commandPaletteFixture!.runRequests()),
  paneFocusCount: (page: Page, worktreeId: number) =>
    page.evaluate((value) => window.commandPaletteFixture!.paneFocusCount(value), worktreeId),
};

const ORIGIN_WORKTREE = 12;
const DESTINATION_WORKTREE = 13;

test.beforeEach(async ({ page }) => {
  await page.goto('./');
  // The workspace snapshot has to have landed before the palette can assemble a
  // worktree's rows at all; the stand-in is the page's own canvas.
  await expect(page.locator(`[data-pane-stand-in="${ORIGIN_WORKTREE}"]`)).toBeAttached();
});

// ---------------------------------------------------------------------------
// Presentation — the phase-01 state matrix, now against production components.
// ---------------------------------------------------------------------------

test('opening the palette reads the catalog and renders the Commands group in place', async ({
  page,
}) => {
  // Not zero any more: the page now mounts the production status strip, which is
  // always on in the app and reads the same key. Measuring against a baseline
  // keeps this about the palette's own observer instead of asserting an absence
  // the real app never had.
  const baseline = await fixture.commandsFetchCount(page, ORIGIN_WORKTREE);

  await openPalette(page);
  await expect(row(page, 'dev')).toBeVisible();

  // The open itself is what starts the palette's read: its observer is disabled
  // until then.
  expect(await fixture.commandsFetchCount(page, ORIGIN_WORKTREE)).toBeGreaterThan(baseline);

  const headers = await groupHeaders(page).allTextContents();
  expect(headers).toEqual(['Global', 'Commands', 'This worktree', 'Surfaces', 'Switch worktree']);
});

test('a running row reads as details, a startable row reads as a launch', async ({ page }) => {
  await openPalette(page);

  await expect(row(page, 'dev')).toContainText('run command');
  await expect(row(page, 'api')).toContainText('open details');
  // The distinction has to survive being read quickly: the running row must not
  // contain the launch verb at all.
  await expect(row(page, 'api')).not.toContainText('run command');
  // Ports are part of the running sub, in the drawer's notation.
  await expect(row(page, 'api')).toContainText(':8080');
});

test('running rows carry the working tone and startable rows do not', async ({ page }) => {
  await openPalette(page);
  expect(await iconClass(page, 'api')).toContain('text-working');
  expect(await iconClass(page, 'dev')).not.toContain('text-working');
  // A state tint, never an error tint — the command is fine, it is just up.
  expect(await iconClass(page, 'api')).not.toContain('text-error');
});

test('a failed last run is still an ordinary startable row', async ({ page }) => {
  await openPalette(page);
  await page.locator(`${PALETTE} input`).fill('migrate');

  await expect(row(page, 'migrate')).toContainText('run command');
  const icon = await iconClass(page, 'migrate');
  expect(icon).not.toContain('text-error');
  expect(icon).not.toContain('text-working');
});

test('the empty query caps the group at three, and typing lifts the cap', async ({ page }) => {
  await openPalette(page);
  await expect(row(page, 'dev')).toBeVisible();
  expect((await groupCounts(page))['Commands']).toBe(3);

  // Every configured command is reachable; the cap is a view, not a filter.
  await page.locator(`${PALETTE} input`).fill('migrate');
  await expect(row(page, 'migrate')).toBeVisible();
});

test('an empty catalog renders no Commands header at all', async ({ page }) => {
  await fixture.setCatalog(page, []);
  await openPalette(page);
  await expect(row(page, 'Open worktree')).toBeVisible();
  await expect(groupHeaders(page)).not.toContainText(['Commands']);
});

test('no active worktree removes the section entirely', async ({ page }) => {
  await fixture.setActiveWorktree(page, null);
  await openPalette(page);
  await expect(row(page, 'Open worktree')).toBeVisible();
  const headers = await groupHeaders(page).allTextContents();
  expect(headers).not.toContain('Commands');
});

test('an invalid config shows one error row and leaves other groups alone', async ({ page }) => {
  await fixture.breakConfig(page);
  await openPalette(page);

  const failure = row(page, 'Command config needs a look.');
  await expect(failure).toBeVisible();
  expect(await failure.locator('svg').getAttribute('class')).toContain('text-error');
  await expect(failure).toContainText('Select for details.');

  // No command rows accompany it, and the neighbours are untouched — a broken
  // command config must not make the whole palette look broken.
  expect((await groupCounts(page))['Commands']).toBe(1);
  await expect(row(page, 'dev')).toHaveCount(0);
  await expect(row(page, 'Open worktree')).toBeVisible();
});

test('an unreadable catalog shows the drawer’s own failure sentence', async ({ page }) => {
  await fixture.setCatalogUnavailable(page, true);
  await openPalette(page);

  // A read failure, not a catalog variant: the production retry ladder runs
  // first, so this row arrives seconds after the open, exactly as it would in
  // the app.
  const failure = row(page, 'Commands are unavailable.');
  await expect(failure).toBeVisible({ timeout: 20_000 });
  expect(await failure.locator('svg').getAttribute('class')).toContain('text-error');
});

test('four populated groups stay legible at the empty query', async ({ page }) => {
  // The density state phase 04 handed forward: Global, Workflows, Commands, and
  // This worktree all at the three-row cap at once. DOM counts prove it is the
  // state; the screenshot is the evidence a human judged the density on.
  await fixture.setWorkflows(page, ['Ship a story', 'Review a plan', 'Cut a release']);
  await openPalette(page);
  await expect(row(page, 'Ship a story')).toBeVisible();

  const headers = await groupHeaders(page).allTextContents();
  expect(headers).toEqual([
    'Global',
    'Workflows',
    'Commands',
    'This worktree',
    'Surfaces',
    'Switch worktree',
  ]);

  const counts = await groupCounts(page);
  expect(counts['Global']).toBe(3);
  expect(counts['Workflows']).toBe(3);
  expect(counts['Commands']).toBe(3);
  expect(counts['This worktree']).toBe(3);

  // Attached to the run rather than written to a hand-built path, so the artifact
  // always lands in this project's output directory and never outside the repo.
  await test.info().attach('four-populated-groups', {
    body: await palette(page).screenshot(),
    contentType: 'image/png',
  });
});

// ---------------------------------------------------------------------------
// Integration — the seams that only exist with both surfaces mounted.
// ---------------------------------------------------------------------------

test('a keyboard launch runs, hands off to focused details, and gives focus back on Escape', async ({
  page,
}) => {
  await openPalette(page);
  // Focus starts in the palette's own input, so the arrows below are the
  // production key path, not a synthetic dispatch at the panel.
  await expect(page.locator(`${PALETTE} input`)).toBeFocused();
  await selectByArrowKeys(page, 'dev');

  // The mutation is proven by the server, twice over: the request the endpoint
  // received, and the status a *later* catalog read reports back.
  await expect(drawer(page)).toBeVisible();
  expect(await fixture.runRequests(page)).toEqual([
    { worktreeId: ORIGIN_WORKTREE, commandName: 'dev' },
  ]);
  await expect(drawer(page).getByText('running')).toBeVisible();

  // The drawer opened focused on the command the row named, not on whatever the
  // list happened to start with.
  await expect(drawer(page).locator('[aria-current="true"]')).toContainText('dev');

  await expect(palette(page)).toHaveCount(0);
  await settleFrames(page);
  expect(await activeElementInside(page, 'aside')).toBe(true);

  const before = await fixture.paneFocusCount(page, ORIGIN_WORKTREE);
  await page.keyboard.press('Escape');
  await expect(drawer(page)).toHaveCount(0);
  await settleFrames(page);
  expect(await fixture.paneFocusCount(page, ORIGIN_WORKTREE)).toBe(before + 1);
  expect(await activeElementInside(page, `[data-pane-stand-in="${ORIGIN_WORKTREE}"]`)).toBe(true);
});

test('a running row opens details without launching anything', async ({ page }) => {
  await openPalette(page);
  await row(page, 'api').click();

  await expect(drawer(page)).toBeVisible();
  await expect(drawer(page).locator('[aria-current="true"]')).toContainText('api');
  // The whole point of the running branch: no run request was ever sent.
  expect(await fixture.runRequests(page)).toEqual([]);
});

test('pointer selection over an open drawer neither dismisses nor remounts it', async ({
  page,
}) => {
  await openPalette(page);
  await row(page, 'api').click();
  await expect(drawer(page)).toBeVisible();

  const aside = await drawer(page).elementHandle();
  const paneFocusBefore = await fixture.paneFocusCount(page, ORIGIN_WORKTREE);

  await openPalette(page);
  await row(page, 'api').click();
  await expect(palette(page)).toHaveCount(0);
  await settleFrames(page);

  // Same DOM node: the drawer never dismissed on the palette's `pointerdown` and
  // never remounted underneath the selection.
  expect(await aside!.evaluate((node) => node.isConnected)).toBe(true);
  await expect(drawer(page)).toBeVisible();
  expect(await activeElementInside(page, 'aside')).toBe(true);
  // And nothing scheduled a pane steal behind the open drawer.
  expect(await fixture.paneFocusCount(page, ORIGIN_WORKTREE)).toBe(paneFocusBefore);
});

test('a navigation row keeps the drawer’s focus while the pane target stays reachable', async ({
  page,
}) => {
  await openPalette(page);
  await row(page, 'api').click();
  await expect(drawer(page)).toBeVisible();

  await openPalette(page);
  await selectByQuery(page, 'second worktree', 'second worktree');
  await expect(palette(page)).toHaveCount(0);
  await settleFrames(page);

  // The switch happened — the palette's observer refetched on the new key — but
  // the destination's pane target was never invoked, because the drawer owns
  // focus while it is open.
  await expect
    .poll(() => fixture.commandsFetchCount(page, DESTINATION_WORKTREE))
    .toBeGreaterThan(0);
  await expect(drawer(page)).toBeVisible();
  expect(await activeElementInside(page, 'aside')).toBe(true);
  expect(await fixture.paneFocusCount(page, DESTINATION_WORKTREE)).toBe(0);

  // The control, so the suppression above cannot pass vacuously: that exact
  // target is real, registered, and reachable the moment the drawer stops
  // owning focus.
  await page.keyboard.press('Escape');
  await expect(drawer(page)).toHaveCount(0);
  await settleFrames(page);
  expect(await fixture.paneFocusCount(page, DESTINATION_WORKTREE)).toBe(1);

  // And with the drawer closed, a switch row does drive pane focus itself.
  await openPalette(page);
  await selectByQuery(page, 'commands in the palette', 'commands in the palette');
  await settleFrames(page);
  await expect.poll(() => fixture.paneFocusCount(page, ORIGIN_WORKTREE)).toBeGreaterThan(0);
});

test('a rejected run stays at the palette with its inline error', async ({ page }) => {
  await fixture.failNextRun(page);
  await openPalette(page);
  await selectByQuery(page, 'dev', 'dev');

  // The failure is attached to the surface that owns the action: the palette
  // stays open, says so inline, and the drawer never opened behind it.
  await expect(palette(page).locator('p.text-error')).toBeVisible();
  await expect(palette(page)).toBeVisible();
  await expect(drawer(page)).toHaveCount(0);
  expect(await fixture.runRequests(page)).toEqual([
    { worktreeId: ORIGIN_WORKTREE, commandName: 'dev' },
  ]);
});

test('the busy lock holds the palette through Mod+K and Mod+N until the run settles', async ({
  page,
}) => {
  await fixture.setRunDelay(page, 2_000);
  await openPalette(page);
  await selectByQuery(page, 'typecheck', 'typecheck');

  const running = page.getByRole('status');
  await expect(running).toBeVisible();

  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.press('ControlOrMeta+n');

  // Neither shortcut abandoned or replaced the visible work, and the palette is
  // holding real keyboard focus rather than letting keystrokes fall through to
  // whatever is behind it.
  await expect(running).toBeVisible();
  await expect(palette(page)).toBeVisible();
  expect(await activeElementInside(page, PALETTE)).toBe(true);

  await expect(drawer(page)).toBeVisible({ timeout: 15_000 });
  await expect(drawer(page).locator('[aria-current="true"]')).toContainText('typecheck');
  await settleFrames(page);
  expect(await activeElementInside(page, 'aside')).toBe(true);
});

test('Escape dismisses neither surface while a run is in flight', async ({ page }) => {
  await openPalette(page);
  await row(page, 'api').click();
  await expect(drawer(page)).toBeVisible();

  await fixture.setRunDelay(page, 2_000);
  await openPalette(page);
  await selectByQuery(page, 'typecheck', 'typecheck');
  await expect(page.getByRole('status')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.getByRole('status')).toBeVisible();
  await expect(palette(page)).toBeVisible();
  await expect(drawer(page)).toBeVisible();

  // After settlement the same key works again, which is what makes the assertion
  // above about ownership rather than about Escape being inert.
  await expect(palette(page)).toHaveCount(0, { timeout: 15_000 });
  await settleFrames(page);
  await page.keyboard.press('Escape');
  await expect(drawer(page)).toHaveCount(0);
});

test('the catalog failure row opens the drawer’s config diagnostic', async ({ page }) => {
  await fixture.breakConfig(page);
  await openPalette(page);
  await row(page, 'Command config needs a look.').click();

  await expect(drawer(page)).toBeVisible();
  await expect(drawer(page).getByRole('heading')).toContainText('Command config needs a look.');
  // The runtime's own diagnostic, verbatim in the drawer's diagnostic block —
  // the actionable detail the palette row deliberately does not duplicate.
  await expect(drawer(page).locator('pre')).toContainText('.isagi/config.yaml');
  await expect(drawer(page).locator('pre')).toContainText('commands.dev.run');
  // Diagnostics are the drawer's job; the palette pointed at them rather than
  // rendering a weaker copy of them.
  expect(await fixture.runRequests(page)).toEqual([]);
});

test('the catalog is polled while the palette is open and left alone once it closes', async ({
  page,
}) => {
  // Deliberately slow: it verifies the production 10 s constant as-is rather than
  // forking the freshness policy it exists to prove.
  test.setTimeout(60_000);

  await openPalette(page);
  const openBaseline = await fixture.commandsFetchCount(page, ORIGIN_WORKTREE);
  await expect
    .poll(() => fixture.commandsFetchCount(page, ORIGIN_WORKTREE), { timeout: 15_000 })
    .toBeGreaterThan(openBaseline);

  await page.keyboard.press('Escape');
  await expect(palette(page)).toHaveCount(0);
  await expect(drawer(page)).toHaveCount(0);
  // Let anything already in flight settle before the baseline is taken.
  await page.waitForTimeout(1_000);

  const closedBaseline = await fixture.commandsFetchCount(page, ORIGIN_WORKTREE);
  await page.waitForTimeout(11_000);
  // This proves *this page's* disabled observer stops scheduling reads. It is not
  // a claim about production command traffic in general: the status strip is an
  // independent observer and window-focus refetches can still touch the key.
  expect(await fixture.commandsFetchCount(page, ORIGIN_WORKTREE)).toBe(closedBaseline);
});

// ---------------------------------------------------------------------------
// Suspension
//
// The runtime cannot produce `suspended` yet, so every state below is authored
// by the fixture. What is *not* authored is the rendering: these run against the
// production drawer, status strip, and palette, which is the point of reviewing
// the presentation a phase before the lifecycle that emits it.
//
// The load-bearing question in each test is what the user can tell and what they
// can do — a suspended command is the one state that carries a pending decision,
// and it is worthless if it reads as "stopped" or offers no way out.
// ---------------------------------------------------------------------------

/** The always-on strip, mounted by the fixture in the app's own position. */
const strip = (page: Page) => page.locator('[data-fixture-strip]');

/** The drawer's single notice band, located by what it says rather than by shape. */
const suspendedNotice = (page: Page) =>
  drawer(page).getByText(/^Suspended when leaving this worktree/);

/**
 * Open the drawer and land on one command *without* acting on it.
 *
 * The way in is always the running row, because selecting a suspended row in the
 * palette resumes it — that is the feature. Routing through the palette's only
 * details-opening row and then selecting inside the drawer keeps the state under
 * test intact instead of destroying it on the way to observing it.
 */
async function openDrawerOn(page: Page, commandName: string) {
  await openPalette(page);
  await row(page, 'api').click();
  await expect(drawer(page)).toBeVisible();
  if (commandName !== 'api') {
    await drawer(page).getByText(commandName, { exact: true }).first().click();
  }
}

test('a suspended configured command reads as waiting and offers both Run and Stop', async ({
  page,
}) => {
  await fixture.applyScenario(page, 'suspended');
  await openDrawerOn(page, 'dev');

  // Waiting, not idle and not working: nothing is happening, and that is the
  // user's call to make. The dot carries an accessible name, so this is the
  // signal a screen reader gets too, not just a colour.
  await expect(drawer(page).getByRole('img', { name: 'Waiting on you' }).first()).toBeVisible();
  await expect(drawer(page).getByText('suspended').first()).toBeVisible();

  // The copy has to name both recoveries without promising an auto-restart.
  await expect(suspendedNotice(page)).toBeVisible();
  await expect(suspendedNotice(page)).toContainText('next activation');
  await expect(suspendedNotice(page)).not.toContainText(/come back|when you return/i);

  // Both affordances, which is unique to this status: Run resumes it now, Stop
  // abandons the intent. A suspended command that could not be stopped would be
  // a state with no way out that does not involve editing config.
  await expect(drawer(page).getByTitle('Run dev').first()).toBeVisible();
  await expect(drawer(page).getByTitle('Stop dev').first()).toBeVisible();
});

test('an ordinary status grows no explanatory notice', async ({ page }) => {
  await fixture.applyScenario(page, 'suspended');
  await openDrawerOn(page, 'api');

  // The gating that keeps the band from becoming chrome: it belongs to the
  // states that owe the user an explanation, and `running` is not one of them.
  await expect(drawer(page).getByText('running').first()).toBeVisible();
  await expect(suspendedNotice(page)).toHaveCount(0);
});

test('stopping a suspended command clears the intent and drops it off the strip', async ({
  page,
}) => {
  await fixture.applyScenario(page, 'suspended');
  await openDrawerOn(page, 'dev');
  await expect(strip(page).getByText('suspended')).toBeVisible();

  await drawer(page).getByTitle('Stop dev').first().click();

  // Converged server state, not a recorded request: the drawer re-reads and the
  // command is now an ordinary `stopped`, which after this feature unambiguously
  // means a person did it.
  await expect(drawer(page).getByText('stopped').first()).toBeVisible();
  await expect(suspendedNotice(page)).toHaveCount(0);
  expect(await fixture.actionRequests(page)).toEqual([
    { action: 'stop', worktreeId: ORIGIN_WORKTREE, commandName: 'dev' },
  ]);
  // `stopped` is not attention-worthy, so the chip leaves the always-on strip
  // while the still-running command keeps its place.
  await expect(strip(page).getByText('suspended')).toHaveCount(0);
  await expect(strip(page).getByText('api')).toBeVisible();
});

test('the status strip keeps a suspended command visible, in waiting tones', async ({ page }) => {
  await fixture.applyScenario(page, 'suspended');
  await openPalette(page);
  await page.keyboard.press('Escape');

  // Visibility here is the whole fix: before this phase the strip admitted only
  // `running` and `failed`, so a suspension the user had to resolve vanished from
  // the one surface that is always on screen.
  const badge = strip(page).getByText('suspended');
  await expect(badge).toBeVisible();
  // State colour comes from the attention semantics rather than the error tones
  // every non-running status used to share — a suspension is not a failure.
  await expect(badge).toHaveClass(/text-waiting/);
  await expect(badge).not.toHaveClass(/text-error/);
});

test('a removed suspended command offers Stop only, under one notice', async ({ page }) => {
  await fixture.applyScenario(page, 'removed');
  await openDrawerOn(page, 'api');
  await drawer(page).getByText('worker').first().click();

  // One band, not two. The suspension copy already states the entry is gone, so
  // the standalone removed notice would be a second paragraph saying an
  // overlapping thing.
  await expect(drawer(page).getByText(/config entry is gone/)).toBeVisible();
  await expect(
    drawer(page).getByText('This command is no longer in .isagi/config.yaml.'),
  ).toHaveCount(0);
  // Nothing in the catalog to launch, so Run and Restart are absent — but the
  // intent can still be cleared.
  await expect(drawer(page).getByTitle('Stop worker').first()).toBeVisible();
  await expect(drawer(page).getByTitle('Run worker')).toHaveCount(0);
  await expect(drawer(page).getByTitle('Restart worker')).toHaveCount(0);
});

test('an unreadable config keeps the ordinary drawer, the parse error, and a way to re-read', async ({
  page,
}) => {
  await fixture.applyScenario(page, 'managed');
  await openPalette(page);
  await row(page, 'Command config needs a look.').click();
  await expect(drawer(page)).toBeVisible();

  // The full-width diagnostic panel and the `runtime-managed commands` heading
  // are gone: the heading named an internal concept, and the panel rebuilt the
  // layout for a state the badge and the notice already carry.
  await expect(drawer(page).getByText('runtime-managed commands')).toHaveCount(0);
  await expect(drawer(page).getByRole('heading')).toHaveCount(0);
  // Terse in the 208px list row, subject named in the roomier header — the same
  // fact at two lengths rather than a truncation of one wording.
  await expect(drawer(page).getByText('broken', { exact: true }).first()).toBeVisible();
  await expect(drawer(page).getByText('config broken', { exact: true })).toBeVisible();

  // The managed suspension says the config is unreadable rather than claiming the
  // entry is gone — its presence is unknown, which is a different fact.
  await expect(drawer(page).getByText(/config can't be read right now/)).toBeVisible();
  // The parse error survives the panel's removal. Without it a user can see that
  // the config is broken but never what is wrong with it.
  await expect(drawer(page).getByText(/commands\.dev\.run/)).toBeVisible();
  // A fix happens on disk and emits nothing, so the re-read stays reachable.
  await expect(drawer(page).getByRole('button', { name: 'Refresh' })).toBeVisible();
});

test('a failed stop is voiced above the log rather than floating over it', async ({ page }) => {
  await fixture.applyScenario(page, 'diagnostic');
  await openDrawerOn(page, 'api');

  // The command is truthfully still running — the stop failed, so claiming it
  // stopped or failed would both be lies. What it owes the user is the reason.
  await expect(drawer(page).getByText('running').first()).toBeVisible();
  const notice = drawer(page).getByText("Isagi couldn't stop or verify this command's process.");
  await expect(notice).toBeVisible();
  // Isagi's voice carries the summary; the runtime's sentence is labelled
  // diagnostic detail and never promoted to the headline (ADR 0004).
  await expect(
    drawer(page).getByText(/Diagnostic detail: Could not stop the process/),
  ).toBeVisible();

  // Above the terminal, not on top of it: the band costs one row of height and
  // never hides live output.
  await expect(notice.locator('xpath=ancestor::*[contains(@class,"isagi-xterm")]')).toHaveCount(0);
});

test('the palette calls a suspended command Resume', async ({ page }) => {
  await fixture.applyScenario(page, 'suspended');
  await openPalette(page);

  // Same runnable group and same Play icon as a startable row — only the word
  // changes, because the user is continuing a command that already exists.
  await expect(row(page, 'dev')).toContainText('Resume');
  await expect(row(page, 'dev')).not.toContainText('run command');

  await selectByQuery(page, 'dev', 'dev');
  await expect(drawer(page)).toBeVisible();
  expect(await fixture.runRequests(page)).toEqual([
    { worktreeId: ORIGIN_WORKTREE, commandName: 'dev' },
  ]);
});
