import { expect, test, type Page } from '@playwright/test';

import type { CommandSummary } from '@isagi/contracts';

import {
  FIXTURE_COLLIDING_BADGE_IDS,
  FIXTURE_DEGRADED_PORTS,
  FIXTURE_DENSE_PORTS,
  FIXTURE_DUPLICATE_URLS,
  FIXTURE_MANAGED_WITH_PORTS,
  FIXTURE_PATHLESS_ONLY,
  FIXTURE_REMOVED_WITH_PORTS,
} from '../fixture/command-palette/seed.js';

/**
 * The endpoint surfaces — the status strip's port-anchored URL badges and the
 * drawer's endpoints popover — against the **production** `StatusStrip`,
 * `WorkbenchDrawer` and `CommandEndpoints` over the command-palette fixture's
 * fake runtime.
 *
 * This page is where the endpoint work can actually be judged. The unit tests
 * own the presentation matrix as data; everything here needs a real DOM: a real
 * clipboard, real focus, a real popover that has to dismiss without taking the
 * drawer with it, and real layout that must not move when a badge confirms.
 *
 * Locality is steered through the fixture rather than the runtime, because it is
 * a client-side capability the runtime does not know. Production derives it in
 * Phase 05; here the fixture is the only place a `local` value exists at all.
 */

const strip = (page: Page) => page.locator('[data-fixture-strip]');
const drawer = (page: Page) => page.getByRole('complementary', { name: 'Commands' });
/** Every copyable URL affordance says what it copies — that label *is* the contract. */
const urlBadge = (page: Page, url: string) => page.getByRole('button', { name: `Copy ${url}` });
const endpointsToggle = (page: Page) =>
  drawer(page).getByRole('button', { name: /^(Show|Hide) endpoints$/ });
const endpointsPanel = (page: Page) => drawer(page).getByRole('group', { name: 'endpoints' });
const panelUrl = (page: Page, url: string) =>
  endpointsPanel(page).getByRole('button', { name: `Copy ${url}` });

/**
 * Comfortably past the popover's own dismissal delay, so "still open" means the
 * panel outlived every timer a copy could have scheduled rather than merely
 * being read too early.
 */
const DISMISS_GRACE_MS = 1200;

const fixture = {
  /**
   * Seed a catalog *and* make the always-mounted strip re-read it. The palette's
   * specs can seed and then open, because opening refetches; the strip never
   * closes, so a change behind it needs the invalidation a real mutation would
   * have caused.
   */
  setCatalog: async (page: Page, commands: readonly CommandSummary[]) => {
    await page.evaluate((value) => window.commandPaletteFixture!.setCatalog(value), commands);
    await page.evaluate(() => window.commandPaletteFixture!.refetchCommands());
  },
  setLocality: (page: Page, locality: 'local' | 'non_local') =>
    page.evaluate((value) => window.commandPaletteFixture!.setLocality(value), locality),
  /** Live runtime state whose config entries are gone — a different fact, kept apart. */
  setRemovedCommands: async (page: Page, commands: readonly CommandSummary[]) => {
    await page.evaluate(
      (value) => window.commandPaletteFixture!.setRemovedCommands(value),
      commands,
    );
    await page.evaluate(() => window.commandPaletteFixture!.refetchCommands());
  },
  /** Serve a catalog that could not be parsed, with the commands still being managed. */
  breakConfig: async (page: Page, managedCommands: readonly CommandSummary[]) => {
    await page.evaluate(
      (value) => window.commandPaletteFixture!.breakConfig(undefined, value),
      managedCommands,
    );
    await page.evaluate(() => window.commandPaletteFixture!.refetchCommands());
  },
};

const ORIGIN_WORKTREE = 12;

/** The fixture's default `api`: an allocated port with two paths, plus a pathless one. */
const DOCS_URL = 'http://localhost:51824/docs';
const HEALTH_URL = 'http://localhost:51824/healthz';
/** The URL `FIXTURE_DUPLICATE_URLS` composes twice, under two different labels. */
const DUPLICATE_URL = 'http://localhost:51824/api';

test.beforeEach(async ({ page }) => {
  await page.goto('./');
  await expect(page.locator(`[data-pane-stand-in="${ORIGIN_WORKTREE}"]`)).toBeAttached();
  await fixture.setLocality(page, 'local');
});

/**
 * A bounding box taken once the element has stopped moving.
 *
 * The drawer slides in on the surface curve, so a box read the instant it opens
 * is a box mid-animation. Two consecutive equal readings mean it has landed.
 */
async function settledBox(page: Page, locator: ReturnType<Page['locator']>) {
  let previous = await locator.boundingBox();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await page.waitForTimeout(50);
    const next = await locator.boundingBox();
    if (previous && next && previous.x === next.x && previous.y === next.y) {
      return next;
    }
    previous = next;
  }
  throw new Error('element never stopped moving');
}

/**
 * Swap in a clipboard whose outcome the test steers, then reload so the stub is
 * installed before the app mounts.
 *
 * Failure is not a static fixture here: the popover's dismissal rules turn on
 * *sequences* — a success followed by a failure, a success followed by a
 * reopen — so a test has to be able to change the answer mid-scenario.
 */
async function useSteerableClipboard(page: Page) {
  await page.addInitScript(() => {
    const state: {
      fail: boolean;
      defer: boolean;
      text: string;
      pending: ((outcome: 'copied' | 'failed') => void)[];
    } = { fail: false, defer: false, text: '', pending: [] };
    (window as unknown as { clipboardStub: typeof state }).clipboardStub = state;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (text: string) => {
          const finish = (outcome: 'copied' | 'failed') => {
            if (outcome === 'copied') {
              state.text = text;
            }
          };
          // `defer` models the write that does not answer immediately — a
          // permission prompt, a focus-gated clipboard — which is the only way
          // to hold an attempt open past another timer's deadline.
          if (state.defer) {
            // Queued rather than held in a single slot, so two badges can each
            // have a write in flight and the test can answer them out of order.
            return new Promise<void>((resolve, reject) => {
              state.pending.push((outcome) => {
                finish(outcome);
                if (outcome === 'copied') {
                  resolve();
                  return;
                }
                reject(new Error('denied'));
              });
            });
          }
          if (state.fail) {
            return Promise.reject(new Error('denied'));
          }
          finish('copied');
          return Promise.resolve();
        },
        readText: () => Promise.resolve(state.text),
      },
    });
  });
  await page.reload();
  await expect(page.locator(`[data-pane-stand-in="${ORIGIN_WORKTREE}"]`)).toBeAttached();
  await fixture.setLocality(page, 'local');
}

const setClipboardFailing = (page: Page, fail: boolean) =>
  page.evaluate((value) => {
    (window as unknown as { clipboardStub: { fail: boolean } }).clipboardStub.fail = value;
  }, fail);

/** Hold every subsequent write open until the test answers it. */
const deferClipboard = (page: Page) =>
  page.evaluate(() => {
    (window as unknown as { clipboardStub: { defer: boolean } }).clipboardStub.defer = true;
  });

type DeferredStub = {
  clipboardStub: { pending: ((outcome: 'copied' | 'failed') => void)[] };
};

/** Wait for the nth deferred write to be in flight, then answer it. */
async function settleDeferredCopy(page: Page, index: number, outcome: 'copied' | 'failed') {
  await page.waitForFunction(
    (at) => (window as unknown as DeferredStub).clipboardStub.pending.length > at,
    index,
  );
  await page.evaluate(
    ({ at, value }) => {
      (window as unknown as DeferredStub).clipboardStub.pending[at]?.(value);
    },
    { at: index, value: outcome },
  );
}

/**
 * Which badges in a set are showing the failure tone, read in one pass.
 *
 * The settled state returns to idle on its own, so two sequential retrying
 * assertions can both come true simply by being read late. One snapshot of the
 * whole set is the only reading that means what it says.
 */
const failingBadges = (badges: ReturnType<Page['getByRole']>) =>
  badges.evaluateAll((nodes) => nodes.map((node) => node.className.includes('text-error')));

/** Everything the surface has announced, in DOM order across both live regions. */
const announced = async (page: Page) =>
  (await drawer(page).locator('span[aria-live="polite"]').allTextContents()).join('');

/** Open the drawer on one command the way a user does — by clicking its chip. */
async function openCommand(page: Page, name: string) {
  await strip(page).locator(`button[title="Open ${name} monitor"]`).click();
  await expect(drawer(page)).toBeVisible();
}

// ---------------------------------------------------------------------------
// The status strip — the primary endpoint surface.
// ---------------------------------------------------------------------------

test('the strip anchors each URL badge on its resolved port', async ({ page }) => {
  // Direction B: the port rides in front of the label. For an allocated port it
  // is the fact the user did not choose and cannot guess, so putting it here is
  // what makes the drawer optional rather than mandatory.
  await expect(urlBadge(page, DOCS_URL)).toContainText(':51824');
  await expect(urlBadge(page, DOCS_URL)).toContainText('docs');
  await expect(urlBadge(page, HEALTH_URL)).toContainText('health');

  // One badge per URL, not per port.
  await expect(strip(page).getByRole('button', { name: /^Copy http/ })).toHaveCount(2);

  // The pathless port is present as a fact and is *not* a control.
  await expect(strip(page)).toContainText(':9229');
  await expect(page.getByRole('button', { name: /9229/ })).toHaveCount(0);
});

test('the command chip stays the only drawer opener, with badges as siblings', async ({ page }) => {
  // A button may not nest a button. If the badges were ever moved inside the
  // chip this count would climb and keyboard order would break with it.
  const nested = await strip(page).evaluate(
    (node) => node.querySelectorAll('button button').length,
  );
  expect(nested).toBe(0);
});

test('copying confirms inside the badge without moving its neighbour', async ({ page }) => {
  const docs = urlBadge(page, DOCS_URL);
  const health = urlBadge(page, HEALTH_URL);

  const before = await health.boundingBox();
  await docs.click();

  await expect(docs).toContainText('copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(DOCS_URL);

  // The badge that was clicked must not shove the one next to it. Without the
  // grid-stacked strings, `copied` being wider than `docs` would reflow the row
  // and shift the strip's scroll position out from under the pointer.
  expect(await health.boundingBox()).toEqual(before);

  // And it returns to its label on its own.
  await expect(docs).toContainText('docs', { timeout: 4000 });
});

test('a clipboard failure is visible in the badge rather than swallowed', async ({ page }) => {
  await useSteerableClipboard(page);
  await setClipboardFailing(page, true);

  const docs = urlBadge(page, DOCS_URL);
  await docs.click();

  // Red is earned here: the clipboard genuinely failed, and silence was the
  // pre-existing behavior this replaces.
  await expect(docs).toContainText('copy failed');
  await expect(docs).toHaveClass(/text-error/);
});

test('a badge is keyboard-activatable and scrolls itself into view', async ({ page }) => {
  await fixture.setCatalog(page, FIXTURE_DENSE_PORTS);

  const metrics = urlBadge(page, 'http://localhost:51824/internal/metrics');
  await expect(metrics).toBeAttached();

  // The strip scrolls rather than clipping, and reachability comes from native
  // focus behavior — which only works because every affordance is a real button.
  await metrics.focus();
  await expect(metrics).toBeInViewport();
  await page.keyboard.press('Enter');
  await expect(metrics).toContainText('copied');
});

test('a dense strip scrolls instead of clipping its badges', async ({ page }) => {
  // Narrow enough that the badges cannot all fit. The old strip clipped here and
  // the overflowing badges were simply unreachable; the assertion is that they
  // are still in the DOM *and* that the region can be scrolled to them.
  await page.setViewportSize({ width: 640, height: 720 });
  await fixture.setCatalog(page, FIXTURE_DENSE_PORTS);
  await expect(urlBadge(page, 'http://localhost:7070/queue')).toBeAttached();

  const region = strip(page).locator('.overflow-x-auto');
  const overflows = await region.evaluate((node) => node.scrollWidth > node.clientWidth);
  expect(overflows).toBe(true);

  const queue = urlBadge(page, 'http://localhost:7070/queue');
  await queue.focus();
  await expect(queue).toBeInViewport();
});

// ---------------------------------------------------------------------------
// The drawer — a closed-by-default lookup that never moves the log.
// ---------------------------------------------------------------------------

test('the endpoints popover is closed by default and opens on the toggle', async ({ page }) => {
  await openCommand(page, 'api');

  const toggle = endpointsToggle(page);
  await expect(toggle).toContainText('2 urls');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(endpointsPanel(page)).toHaveCount(0);

  await toggle.click();

  const panel = endpointsPanel(page);
  await expect(panel).toBeVisible();
  // The complete URL is visible text, not a tooltip. That visibility is the
  // acceptance criterion, so a label alone would not satisfy it.
  await expect(panel).toContainText(DOCS_URL);
  await expect(panel).toContainText(HEALTH_URL);
  // Allocated ports name the variable they were injected under.
  await expect(panel).toContainText('$API_PORT');
  await expect(panel).toContainText(':9229');
  await expect(panel).toContainText('no paths declared');
});

test('opening the popover leaves the log area exactly where it was', async ({ page }) => {
  await openCommand(page, 'api');
  const log = drawer(page).locator('div.px-4.py-3');
  const before = await settledBox(page, log);

  await endpointsToggle(page).click();
  await expect(endpointsPanel(page)).toBeVisible();

  // The whole reason the panel floats: the thing the user came to the drawer for
  // does not move when they glance at a URL. An inline panel would push it down
  // by its own height and fail here.
  expect(await log.boundingBox()).toEqual(before);
});

test('a confirmed copy dismisses the popover', async ({ page }) => {
  await openCommand(page, 'api');
  await endpointsToggle(page).click();

  const docs = panelUrl(page, DOCS_URL);
  await docs.click();

  // The confirmation has to be readable before the dismissal — otherwise ADR
  // 0004's in-badge feedback has nowhere to render at all.
  await expect(docs).toContainText('copied');
  await expect(endpointsPanel(page)).toHaveCount(0);
  await expect(endpointsToggle(page)).toBeFocused();
});

test('a failed copy inside the popover keeps it open', async ({ page }) => {
  await useSteerableClipboard(page);
  await setClipboardFailing(page, true);
  await openCommand(page, 'api');
  await endpointsToggle(page).click();

  const docs = panelUrl(page, DOCS_URL);
  await docs.click();
  await expect(docs).toContainText('copy failed');

  // Closing over a failure would recreate the silent clipboard this replaces:
  // the panel goes away and the user is left believing the copy worked.
  await page.waitForTimeout(DISMISS_GRACE_MS);
  await expect(endpointsPanel(page)).toBeVisible();
  await expect(panelUrl(page, DOCS_URL)).toContainText('copy failed');
});

test('a failure after a success cancels the success dismissal', async ({ page }) => {
  await useSteerableClipboard(page);
  await openCommand(page, 'api');
  await endpointsToggle(page).click();

  await panelUrl(page, DOCS_URL).click();
  await expect(panelUrl(page, DOCS_URL)).toContainText('copied');

  // The success has already scheduled a dismissal. The failure that lands next
  // owns the panel now, and the earlier timer must not close over it.
  await setClipboardFailing(page, true);
  await panelUrl(page, HEALTH_URL).click();
  await expect(panelUrl(page, HEALTH_URL)).toContainText('copy failed');

  await page.waitForTimeout(DISMISS_GRACE_MS);
  await expect(endpointsPanel(page)).toBeVisible();
});

test('a copy still in flight is not closed over by the previous copy', async ({ page }) => {
  await useSteerableClipboard(page);
  await openCommand(page, 'api');
  await endpointsToggle(page).click();

  await panelUrl(page, DOCS_URL).click();
  await expect(panelUrl(page, DOCS_URL)).toContainText('copied');

  // The second attempt never settles inside the first one's remaining delay.
  // Intent is expressed at the click, so the click is where the earlier
  // dismissal has to be retired — cancelling only once this write answers would
  // be cancelling after the panel had already gone.
  await deferClipboard(page);
  await panelUrl(page, HEALTH_URL).click();
  await page.waitForTimeout(DISMISS_GRACE_MS);
  await expect(endpointsPanel(page)).toBeVisible();

  // And the interaction site is still there for the outcome to land in.
  await settleDeferredCopy(page, 0, 'failed');
  await expect(panelUrl(page, HEALTH_URL)).toContainText('copy failed');
  await expect(endpointsPanel(page)).toBeVisible();
});

test('an older copy cannot settle over a newer one on another badge', async ({ page }) => {
  await useSteerableClipboard(page);
  await openCommand(page, 'api');
  await endpointsToggle(page).click();
  await deferClipboard(page);

  // Two writes in flight on two different badges, answered newest first. There
  // is one clipboard and one live region, so ordering has to hold across badges,
  // not just within each of them.
  await panelUrl(page, DOCS_URL).click();
  await panelUrl(page, HEALTH_URL).click();

  await settleDeferredCopy(page, 1, 'failed');
  await expect(panelUrl(page, HEALTH_URL)).toContainText('copy failed');

  // The older write now succeeds. It must announce nothing, dismiss nothing,
  // and claim nothing in its own badge: the user's last instruction was the one
  // that failed, and that is the outcome the surface is reporting.
  await settleDeferredCopy(page, 0, 'copied');
  await page.waitForTimeout(DISMISS_GRACE_MS);

  await expect(endpointsPanel(page)).toBeVisible();
  await expect(panelUrl(page, HEALTH_URL)).toHaveClass(/text-error/);
  expect(await announced(page)).toBe('copy failed');
});

test('two badges sharing a URL confirm separately in the popover', async ({ page }) => {
  await useSteerableClipboard(page);
  await setClipboardFailing(page, true);
  await fixture.setCatalog(page, FIXTURE_DUPLICATE_URLS);
  await openCommand(page, 'api');
  await endpointsToggle(page).click();

  // One port, two labels, one URL. Identity is the row, not the text.
  const rows = panelUrl(page, DUPLICATE_URL);
  await expect(rows).toHaveCount(2);

  await rows.nth(0).click();
  // Read both badges in one snapshot. A pair of retrying assertions would pass
  // on its own after the failed state self-resets, whether or not the outcome
  // ever leaked into the second badge.
  expect(await failingBadges(rows)).toEqual([true, false]);
});

test('two badges sharing a URL confirm separately on the strip', async ({ page }) => {
  await useSteerableClipboard(page);
  await setClipboardFailing(page, true);
  await fixture.setCatalog(page, FIXTURE_DUPLICATE_URLS);

  const badges = strip(page).getByRole('button', { name: `Copy ${DUPLICATE_URL}` });
  await expect(badges).toHaveCount(2);

  await badges.nth(0).click();
  await expect(badges.nth(0)).toHaveClass(/text-error/);
  expect(await failingBadges(badges)).toEqual([true, false]);
});

test('strip badges whose identities would collide stay independent', async ({ page }) => {
  await useSteerableClipboard(page);
  await setClipboardFailing(page, true);
  await fixture.setCatalog(page, FIXTURE_COLLIDING_BADGE_IDS);

  // Both commands are valid configuration and their tuples flatten to the same
  // string under a delimiter join, so a joined identity would let one click
  // confirm inside a badge that copies a different URL entirely.
  const first = urlBadge(page, 'http://localhost:5002/x');
  const second = urlBadge(page, 'http://localhost:5001/y');
  await expect(first).toBeVisible();
  await expect(second).toBeVisible();

  await first.click();
  await expect(first).toHaveClass(/text-error/);
  expect(await failingBadges(strip(page).getByRole('button', { name: /^Copy http/ }))).toEqual([
    true,
    false,
  ]);
});

test('reopening the popover survives the previous copy dismissal', async ({ page }) => {
  await openCommand(page, 'api');
  await endpointsToggle(page).click();

  // Escape and reopen follow the click with no polled assertion between them,
  // so the reopen lands inside the dismissal delay the copy just started. The
  // copy settles on a resolved promise, so the timer is already scheduled by the
  // time the keypress arrives.
  await panelUrl(page, DOCS_URL).click();
  await page.keyboard.press('Escape');
  await expect(endpointsPanel(page)).toHaveCount(0);
  await endpointsToggle(page).click();
  await expect(endpointsPanel(page)).toBeVisible();

  // A timer that outlived the opening that scheduled it closes this second one,
  // and the popover vanishes under a user who just asked for it again.

  await page.waitForTimeout(DISMISS_GRACE_MS);
  await expect(endpointsPanel(page)).toBeVisible();
});

test('Escape closes the popover and leaves the drawer open', async ({ page }) => {
  await openCommand(page, 'api');
  await endpointsToggle(page).click();
  await expect(endpointsPanel(page)).toBeVisible();

  await page.keyboard.press('Escape');

  // Dismissal belongs to the topmost open surface. The drawer's own Escape
  // handler must not also fire, or one keypress would close both.
  await expect(endpointsPanel(page)).toHaveCount(0);
  await expect(drawer(page)).toBeVisible();
  await expect(endpointsToggle(page)).toBeFocused();

  // A second Escape now reaches the drawer, as it always did.
  await page.keyboard.press('Escape');
  await expect(drawer(page)).toHaveCount(0);
});

test('selecting another command closes an open popover', async ({ page }) => {
  await openCommand(page, 'api');
  await endpointsToggle(page).click();
  await expect(endpointsPanel(page)).toBeVisible();

  await drawer(page).locator('button:has(> span:text-is("dev"))').click();

  // The popover is a lookup scoped to one command; it must never outlive the
  // selection that opened it.
  await expect(endpointsPanel(page)).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// The states where the strip shows nothing and the drawer is the only channel.
// ---------------------------------------------------------------------------

test('a non-local runtime withholds URLs but keeps the host-independent facts', async ({
  page,
}) => {
  await fixture.setLocality(page, 'non_local');

  // Nothing copyable anywhere: a composed localhost URL would name this machine
  // rather than the one running the command.
  await expect(strip(page).getByRole('button', { name: /^Copy http/ })).toHaveCount(0);
  // A port with paths is not reinterpreted as pathless — only the genuinely
  // pathless one still shows.
  await expect(strip(page)).toContainText(':9229');
  await expect(strip(page)).not.toContainText(':51824');

  await openCommand(page, 'api');
  const toggle = endpointsToggle(page);
  // Amber and re-worded, because the strip is silent here and this toggle is the
  // only thing left that can say so.
  await expect(toggle).toContainText('2 ports · no urls');
  await expect(toggle).toHaveClass(/text-amber/);

  await toggle.click();
  const panel = endpointsPanel(page);
  await expect(panel).toContainText('/docs');
  await expect(panel).toContainText('$API_PORT');
  await expect(panel).toContainText(
    'HTTP URLs are available only when the runtime runs on this machine.',
  );
  await expect(panel).not.toContainText('http://localhost');
});

test('degraded metadata is voiced rather than shown as a command with no ports', async ({
  page,
}) => {
  await fixture.setCatalog(page, FIXTURE_DEGRADED_PORTS);

  await expect(strip(page).getByRole('button', { name: /^Copy http/ })).toHaveCount(0);

  await openCommand(page, 'api');
  const toggle = endpointsToggle(page);
  await expect(toggle).toContainText('ports unknown');
  await expect(toggle).toHaveClass(/text-amber/);

  await toggle.click();
  await expect(endpointsPanel(page)).toContainText(
    'Port metadata is unavailable for this run. It will resolve on the next launch.',
  );
});

test('a command that declared no ports has no toggle at all', async ({ page }) => {
  await fixture.setCatalog(page, [{ name: 'api', status: 'running', ports: [] }]);
  await openCommand(page, 'api');

  // `[]` is authoritative, not degraded. Nothing is being hidden, so nothing is
  // said — the header is exactly what it was before this work.
  await expect(endpointsToggle(page)).toHaveCount(0);
});

test('an all-pathless set stays quiet, because nothing is being withheld', async ({ page }) => {
  await fixture.setCatalog(page, FIXTURE_PATHLESS_ONLY);
  await fixture.setLocality(page, 'non_local');
  await openCommand(page, 'api');

  const toggle = endpointsToggle(page);
  await expect(toggle).toContainText('1 port');
  await expect(toggle).not.toContainText('no urls');
  await expect(toggle).not.toHaveClass(/text-amber/);
});

// ---------------------------------------------------------------------------
// Presentations whose endpoints are state-owned rather than config-derived.
// ---------------------------------------------------------------------------

test('a running command deleted from config keeps the endpoints its process got', async ({
  page,
}) => {
  await fixture.setCatalog(page, []);
  await fixture.setRemovedCommands(page, FIXTURE_REMOVED_WITH_PORTS);

  // The snapshot is incarnation truth, not a config echo. The old
  // config-derived implementation could not have shown anything here, because
  // the entry it would have read is gone.
  await expect(urlBadge(page, 'http://localhost:4000/v1')).toContainText(':4000');
  await expect(strip(page)).toContainText('removed');

  await openCommand(page, 'legacy-api');
  await expect(endpointsToggle(page)).toContainText('1 url');
  await endpointsToggle(page).click();
  await expect(endpointsPanel(page)).toContainText('http://localhost:4000/v1');
});

test('a running command behind an unreadable config still reports its endpoints', async ({
  page,
}) => {
  await fixture.breakConfig(page, FIXTURE_MANAGED_WITH_PORTS);

  await expect(urlBadge(page, DOCS_URL)).toBeVisible();
  await expect(strip(page)).toContainText(':9229');

  await openCommand(page, 'api');
  await expect(endpointsToggle(page)).toContainText('1 url');
});

test('strip tab order is the chip, then its own URL badges, left to right', async ({ page }) => {
  await fixture.setCatalog(page, FIXTURE_DENSE_PORTS);
  // Exact, because the root-path URL is a prefix of every other URL on that port.
  await expect(
    page.getByRole('button', { name: 'Copy http://localhost:5173/', exact: true }),
  ).toBeAttached();

  // DOM order *is* keyboard order here — there is no tabindex surgery anywhere
  // in the strip, which is what keeps a dense set walkable.
  const order = await strip(page).evaluate((node) =>
    Array.from(node.querySelectorAll('button')).map(
      (button) =>
        button.getAttribute('aria-label') ??
        button.getAttribute('title') ??
        (button.textContent ?? '').trim(),
    ),
  );

  // The drawer-opening `commands` label leads, then each command group: its chip
  // first, then that command's own URL badges in declaration order.
  expect(order.slice(0, 5)).toEqual([
    'commands',
    'Open web monitor',
    'Copy http://localhost:5173/',
    'Copy http://localhost:5173/healthz',
    'Open api monitor',
  ]);
});
