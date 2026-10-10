import { expect, test, type Page } from '@playwright/test';

import type {
  EndpointKey,
  SocketAttempt,
  StateTransitionsFixtureControls,
  StateTransitionsFixtureInit,
} from '../fixture/folder-project/state-transitions/runtime.js';

/**
 * State-transition oracles for how the app reads, caches and refreshes runtime facts.
 *
 * The page is the production entry (`src/main.tsx`) over an instrumented fake runtime, and these
 * specs observe only two things: what is on screen, and what the fake runtime was asked. Nothing
 * here names a cache, a query key or a store, so the same specs hold whether React Query or Effect
 * atoms sit underneath — that is their whole job (verification §4d(1)): they are written against
 * the React Query app and must still pass after the move to `effect/reactivity`.
 *
 * Characterize, don't fix. Where today's behaviour differs from what a reader might expect, the
 * spec pins what actually happens and says so in a comment; it never asserts an aspiration.
 *
 * Time. Freshness is defined by production constants (a workspace read is fresh for 10 s), so the
 * specs that need data to go stale install Playwright's clock and jump it with `fastForward`. Time
 * otherwise flows naturally, which the production code needs: its schedulers run on ordinary
 * timers. Specs whose subject is an interval (retry backoff, the 1 s gate poll, socket backoff,
 * the palette's 10 s poll) leave the clock alone and measure wall time from the fake runtime's
 * request log — jumping the clock while the palette is open stalls its exit animation.
 */

/** Counts of runtime traffic, read from the fake runtime. */
async function reads(page: Page, key: EndpointKey): Promise<number> {
  return page.evaluate((k) => window.stateTransitionsFixture!.reads(k), key);
}

/** When each request with this key arrived, oldest first (page clock, milliseconds). */
async function readTimes(page: Page, key: EndpointKey): Promise<readonly number[]> {
  return page.evaluate(
    (k) =>
      window
        .stateTransitionsFixture!.calls()
        .filter((entry) => entry.key === k)
        .map((entry) => entry.at),
    key,
  );
}

/** Call one of the fake runtime's controls inside the page. */
async function control<K extends keyof StateTransitionsFixtureControls>(
  page: Page,
  method: K,
  ...args: Parameters<StateTransitionsFixtureControls[K]>
) {
  await page.evaluate(
    ([name, values]) => {
      const controls = window.stateTransitionsFixture!;
      (controls[name] as (...input: unknown[]) => unknown)(...values);
    },
    [method, args] as const,
  );
}

async function socketAttempts(page: Page): Promise<readonly SocketAttempt[]> {
  return page.evaluate(() => window.stateTransitionsFixture!.socketAttempts());
}

/**
 * Wait until the page has stopped talking to the runtime: nothing in flight and no new request
 * for a while. Every count a spec compares is taken at rest, so a read that merely started late
 * cannot pass for one the transition under test caused.
 */
async function settle(page: Page) {
  const snapshot = () =>
    page.evaluate(() => ({
      calls: window.stateTransitionsFixture!.calls().length,
      inFlight: window.stateTransitionsFixture!.inFlight(),
    }));
  let previous = await snapshot();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await page.waitForTimeout(400);
    const next = await snapshot();
    if (next.inFlight === 0 && next.calls === previous.calls) return;
    previous = next;
  }
  throw new Error('the page never stopped talking to the runtime');
}

/** Load the page, optionally with fixture state the first render already depends on. */
async function open(page: Page, init: StateTransitionsFixtureInit = {}) {
  await page.addInitScript((value) => {
    window.stateTransitionsFixtureInit = value;
  }, init);
  await page.goto('./?app=state-transitions');
}

/** Hide the document, then show it again: the browser's own focus-return signal. */
async function regainVisibility(page: Page) {
  for (const state of ['hidden', 'visible'] as const) {
    await page.evaluate((value) => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value });
      Object.defineProperty(document, 'hidden', {
        configurable: true,
        get: () => value === 'hidden',
      });
      document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
    }, state);
  }
}

/** A runtime event that invalidates the workspace snapshot, as a surface rename does. */
async function emitWorkspaceChange(page: Page) {
  await page.evaluate(() =>
    window.stateTransitionsFixture!.emit({
      id: `spec-${Date.now()}`,
      type: 'surface_changed',
      occurredAt: new Date().toISOString(),
      payload: { worktreeId: 101, surfaceId: 1011, change: 'renamed' },
    }),
  );
}

const projectGroup = (page: Page, projectId: number) =>
  page.locator(`[data-drag-source="projects#${projectId}"]`);
const worktreeRow = (page: Page, projectId: number, worktreeId: number) =>
  page
    .locator(`[data-drag-source="worktrees:${projectId}#${worktreeId}"]`)
    .getByRole('button')
    .first();
const rootRow = (page: Page, projectId: number) =>
  page
    .locator(`[data-drag-scope="worktrees:${projectId}"] [data-drag-pinned]`)
    .getByRole('button')
    .first();

const restoringWorkspace = (page: Page) => page.getByText('Restoring the workspace.');
const refreshFailedBanner = (page: Page) => page.getByText(/^runtime refresh failed · /);
const PALETTE = 'div.fixed.inset-0.z-50 > div[tabindex="-1"]';

/** Every request the page made reached a fixture route: nothing here passes by asking for less. */
test.afterEach(async ({ page }) => {
  const unhandled = await page.evaluate(() => window.stateTransitionsFixture?.unhandled() ?? []);
  expect(unhandled).toEqual([]);
});

async function workspaceReady(page: Page) {
  await expect(projectGroup(page, 10)).toBeVisible({ timeout: 10_000 });
  await settle(page);
}

test.describe('first read', () => {
  test('the workspace shows a loading state until its first read, then the snapshot', async ({
    page,
  }) => {
    await open(page, { holds: ['GET /workspace'] });

    await expect(restoringWorkspace(page)).toBeVisible();
    await expect.poll(() => reads(page, 'GET /workspace')).toBe(1);
    // A loading state, not an empty one: no rail, and not the first-run empty canvas.
    await expect(projectGroup(page, 10)).toHaveCount(0);
    await expect(page.getByText('No worktrees on the canvas.')).toHaveCount(0);

    await control(page, 'release', 'GET /workspace');

    await expect(projectGroup(page, 10)).toBeVisible();
    await expect(projectGroup(page, 50)).toBeVisible();
    await expect(restoringWorkspace(page)).toHaveCount(0);
    await settle(page);
    expect(await reads(page, 'GET /workspace')).toBe(1);
  });

  test('a failed first read shows the error with a retry, and retry recovers', async ({ page }) => {
    // The app's first read is the startup gate's control-plane read; it owns the only
    // first-load error surface with a retry action. (The workspace page's own fatal error has
    // no retry control: it recovers only through a later refresh.)
    await open(page, { failures: ['GET /control-plane'] });

    await expect(page.getByText('Reaching the runtime…')).toBeVisible();
    await expect(page.getByText('Runtime unreachable.')).toBeVisible({ timeout: 15_000 });

    // Default retry policy, pinned: the first attempt plus three retries, 1 s, 2 s and 4 s apart,
    // before the error is shown at all.
    const attempts = await readTimes(page, 'GET /control-plane');
    expect(attempts).toHaveLength(4);
    const gaps = attempts.slice(1).map((at, index) => at - attempts[index]!);
    for (const [index, expected] of [1_000, 2_000, 4_000].entries()) {
      expect(gaps[index]).toBeGreaterThanOrEqual(expected - 25);
      expect(gaps[index]).toBeLessThan(expected + 750);
    }
    // Nothing behind the gate mounted while it was failing.
    expect(await reads(page, 'GET /workspace')).toBe(0);

    await control(page, 'succeed', 'GET /control-plane');
    await page.getByRole('button', { name: 'Try again' }).click();

    await expect(projectGroup(page, 10)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Runtime unreachable.')).toHaveCount(0);
    await settle(page);
    expect(await reads(page, 'GET /control-plane')).toBe(5);
  });
});

test.describe('refresh', () => {
  test('a refresh keeps the last snapshot on screen until the new one arrives', async ({
    page,
  }) => {
    await open(page);
    await workspaceReady(page);
    const before = await reads(page, 'GET /workspace');

    await control(page, 'setWorkspace', 'refreshed');
    await control(page, 'hold', 'GET /workspace');
    await emitWorkspaceChange(page);
    await expect.poll(() => reads(page, 'GET /workspace')).toBe(before + 1);

    // The read is in flight and held: the previous snapshot stays, with no loading state.
    await page.waitForTimeout(300);
    await expect(worktreeRow(page, 10, 103)).toBeVisible();
    await expect(projectGroup(page, 50)).toBeVisible();
    await expect(worktreeRow(page, 10, 104)).toHaveCount(0);
    await expect(restoringWorkspace(page)).toHaveCount(0);

    await control(page, 'release', 'GET /workspace');

    await expect(worktreeRow(page, 10, 104)).toBeVisible();
    await expect(worktreeRow(page, 10, 103)).toBeVisible();
  });

  test('a failed refresh keeps the last snapshot and does not blank the rail', async ({ page }) => {
    await open(page);
    await workspaceReady(page);
    const before = await reads(page, 'GET /workspace');

    await control(page, 'fail', 'GET /workspace');
    await emitWorkspaceChange(page);

    // Retried like any read (three retries over ~7 s) before the failure is shown — and the rail
    // holds the last snapshot the whole time.
    await expect.poll(() => reads(page, 'GET /workspace')).toBeGreaterThanOrEqual(before + 2);
    await expect(worktreeRow(page, 10, 103)).toBeVisible();
    await expect(refreshFailedBanner(page)).toBeVisible({ timeout: 15_000 });
    expect(await reads(page, 'GET /workspace')).toBe(before + 4);

    await expect(projectGroup(page, 10)).toBeVisible();
    await expect(projectGroup(page, 50)).toBeVisible();
    await expect(worktreeRow(page, 10, 103)).toBeVisible();
    await expect(restoringWorkspace(page)).toHaveCount(0);
    await expect(page.getByText('Runtime connection failed.')).toHaveCount(0);
  });

  test('regaining visibility refreshes a stale workspace once and a fresh one not at all', async ({
    page,
  }) => {
    await page.clock.install();
    await open(page);
    await workspaceReady(page);
    const fresh = await reads(page, 'GET /workspace');

    await regainVisibility(page);
    await settle(page);
    expect(await reads(page, 'GET /workspace')).toBe(fresh);

    // Past the 10 s freshness window.
    await page.clock.fastForward(11_000);
    await settle(page);
    expect(await reads(page, 'GET /workspace')).toBe(fresh);

    await regainVisibility(page);
    await settle(page);
    expect(await reads(page, 'GET /workspace')).toBe(fresh + 1);

    // That read made it fresh again.
    await regainVisibility(page);
    await settle(page);
    expect(await reads(page, 'GET /workspace')).toBe(fresh + 1);
  });

  test('coming back online refreshes the workspace', async ({ page, context }) => {
    await page.clock.install();
    await open(page);
    await workspaceReady(page);
    const fresh = await reads(page, 'GET /workspace');

    // A fresh snapshot is left alone: reconnecting is a reason to check, not to re-read.
    await context.setOffline(true);
    await context.setOffline(false);
    await settle(page);
    expect(await reads(page, 'GET /workspace')).toBe(fresh);

    await page.clock.fastForward(11_000);
    await settle(page);
    await context.setOffline(true);
    await context.setOffline(false);
    await settle(page);
    expect(await reads(page, 'GET /workspace')).toBe(fresh + 1);
  });

  // No offline pausing (plan R24, web-state §2.3 delta 2). React Query's default
  // `networkMode: 'online'` held reads while the browser reported offline, which is wrong for a
  // runtime on localhost: `navigator.onLine` says nothing about whether it answers. The browser
  // coming back online is still a revalidation signal, but only for what is stale.
  test('while offline, a workspace refresh still runs, and coming back online does not repeat it', async ({
    page,
    context,
  }) => {
    await open(page);
    await workspaceReady(page);
    const before = await reads(page, 'GET /workspace');

    await context.setOffline(true);
    await emitWorkspaceChange(page);
    await settle(page);
    expect(await reads(page, 'GET /workspace')).toBe(before + 1);

    await context.setOffline(false);
    await settle(page);
    expect(await reads(page, 'GET /workspace')).toBe(before + 1);
  });
});

test.describe('runtime connection', () => {
  test('the runtime-events socket reconnects with backoff and re-requests attention, workflow and session facts, but not the workspace', async ({
    page,
  }) => {
    await open(page);
    await workspaceReady(page);
    await expect.poll(async () => (await socketAttempts(page))[0]?.outcome).toBe('open');
    const before = await reads(page, 'GET /workspace');
    const inventoryBefore = await reads(page, 'GET /workspace/durable-sessions');

    // The runtime goes away and turns the first two reconnects away.
    await control(page, 'refuseSockets', 2);
    await control(page, 'closeSocket');

    await expect
      .poll(async () => (await socketAttempts(page))[3]?.outcome, { timeout: 10_000 })
      .toBe('open');
    const attempts = await socketAttempts(page);
    expect(attempts.map((attempt) => attempt.outcome)).toEqual([
      'open',
      'refused',
      'refused',
      'open',
    ]);
    // 500 ms, then doubling.
    for (const [index, expected] of [500, 1_000, 2_000].entries()) {
      const gap = attempts[index + 1]!.startedAt - attempts[index]!.closedAt!;
      expect(gap).toBeGreaterThanOrEqual(expected - 25);
      expect(gap).toBeLessThan(expected + 500);
    }
    // A connection that opened resets the backoff.
    await control(page, 'closeSocket');
    await expect
      .poll(async () => (await socketAttempts(page))[4]?.outcome, { timeout: 5_000 })
      .toBe('open');
    const reset = await socketAttempts(page);
    const resetGap = reset[4]!.startedAt - reset[3]!.closedAt!;
    expect(resetGap).toBeGreaterThanOrEqual(475);
    expect(resetGap).toBeLessThan(1_000);

    // Every reconnect asks the runtime for the facts it may have missed.
    expect(reset[4]!.sent).toEqual(
      expect.arrayContaining(['attention_snapshot_requested', 'workflow_run_snapshot_requested']),
    );
    // Characterized, not designed: nothing re-reads the workspace after a reconnect, so a change
    // whose event was missed while the socket was down shows only after the next refresh
    // (visibility, a later event, a commit). Verification §4d named this spec "…and the workspace
    // is refreshed after reconnect"; today's app does not do that, and this pins what it does.
    await settle(page);
    expect(await reads(page, 'GET /workspace')).toBe(before);
    // The terminal layer re-reads the durable-session inventory once per successful reconnect.
    expect(await reads(page, 'GET /workspace/durable-sessions')).toBe(inventoryBefore + 2);
  });

  test('the startup gate polls every second while inventory is pending and stops when settled', async ({
    page,
  }) => {
    await open(page, { controlPlane: 'inventory_pending' });
    await expect(page.getByText('Checking your environment…')).toBeVisible();
    await expect.poll(() => reads(page, 'GET /control-plane')).toBeGreaterThanOrEqual(1);

    await expect
      .poll(() => reads(page, 'GET /control-plane'), { timeout: 5_000 })
      .toBeGreaterThanOrEqual(4);
    const polls = await readTimes(page, 'GET /control-plane');
    for (const [index, at] of polls.slice(1).entries()) {
      const gap = at - polls[index]!;
      expect(gap).toBeGreaterThanOrEqual(975);
      expect(gap).toBeLessThan(1_600);
    }
    // The gate holds the workspace back while it waits.
    expect(await reads(page, 'GET /workspace')).toBe(0);

    await control(page, 'setControlPlane', 'ready');
    await expect(projectGroup(page, 10)).toBeVisible({ timeout: 5_000 });
    await settle(page);
    const settled = await reads(page, 'GET /control-plane');
    await page.waitForTimeout(3_200);
    expect(await reads(page, 'GET /control-plane')).toBe(settled);
  });

  test('the palette command catalog refreshes on open and every 10 seconds while open, and stops when closed', async ({
    page,
  }) => {
    // Wall time, not the fake clock (see the header): about 22 s of real waiting.
    test.slow();
    await open(page);
    await workspaceReady(page);
    const catalog: EndpointKey = 'GET /worktrees/101/commands';
    // The status strip already reads the catalog; that read is fresh.
    const closed = await reads(page, catalog);
    expect(closed).toBeGreaterThanOrEqual(1);

    await page.keyboard.press('Meta+k');
    await expect(page.locator(PALETTE)).toBeVisible();
    await settle(page);
    // Opening reads even though the shared catalog is fresh.
    expect(await reads(page, catalog)).toBe(closed + 1);

    await expect.poll(() => reads(page, catalog), { timeout: 12_000 }).toBe(closed + 2);
    const times = await readTimes(page, catalog);
    const interval = times[closed + 1]! - times[closed]!;
    expect(interval).toBeGreaterThanOrEqual(9_975);
    expect(interval).toBeLessThan(10_750);

    await page.keyboard.press('Escape');
    await expect(page.locator(PALETTE)).toHaveCount(0);
    await settle(page);
    const afterClose = await reads(page, catalog);
    await page.waitForTimeout(11_000);
    expect(await reads(page, catalog)).toBe(afterClose);
  });
});

test.describe('selection and restoration', () => {
  test('selecting a worktree survives a workspace refresh that still contains it, and falls back when it disappears', async ({
    page,
  }) => {
    await open(page);
    await workspaceReady(page);
    await worktreeRow(page, 10, 103).click();
    await expect(worktreeRow(page, 10, 103)).toHaveAttribute('aria-current', 'true');
    await settle(page);

    await control(page, 'setWorkspace', 'refreshed');
    await emitWorkspaceChange(page);
    await expect(worktreeRow(page, 10, 104)).toBeVisible();
    await expect(worktreeRow(page, 10, 103)).toHaveAttribute('aria-current', 'true');
    await expect(
      page.getByText('Active worktree is no longer available.', { exact: false }),
    ).toHaveCount(0);

    await control(page, 'setWorkspace', 'pruned');
    await emitWorkspaceChange(page);
    await expect(worktreeRow(page, 10, 103)).toHaveCount(0);
    // Reconciled to the same project's root checkout, and the user is told why.
    await expect(rootRow(page, 10)).toHaveAttribute('aria-current', 'true');
    await expect(
      page.getByText('Active worktree is no longer available. Switched to the root checkout.'),
    ).toBeVisible();
  });

  test('active context is restored on reload from the runtime, not from client state', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      // The runtime remembers the scratch folder from an earlier session.
      if (!window.sessionStorage.getItem('isagi.state-transitions-fixture.active-context')) {
        window.sessionStorage.setItem(
          'isagi.state-transitions-fixture.active-context',
          JSON.stringify({ projectId: 50, worktreeId: 501 }),
        );
      }
    });
    await open(page);
    await workspaceReady(page);
    await expect(rootRow(page, 50)).toHaveAttribute('aria-current', 'true');

    // Choosing a worktree is persisted to the runtime.
    await worktreeRow(page, 10, 103).click();
    await expect(worktreeRow(page, 10, 103)).toHaveAttribute('aria-current', 'true');
    await expect
      .poll(() => page.evaluate(() => window.stateTransitionsFixture!.activeContext()))
      .toEqual({ projectId: 10, worktreeId: 103 });

    // Another client moves the runtime's active context; this page's last choice was 103.
    await control(page, 'setActiveContext', { projectId: 10, worktreeId: 102 });
    await page.reload();
    await workspaceReady(page);

    await expect(worktreeRow(page, 10, 102)).toHaveAttribute('aria-current', 'true');
    await expect(worktreeRow(page, 10, 103)).not.toHaveAttribute('aria-current', 'true');
  });
});
