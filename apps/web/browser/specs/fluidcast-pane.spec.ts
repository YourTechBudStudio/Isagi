import { expect, test, type Locator, type Page } from '@playwright/test';

import { silentWav } from '../fixture/test-support/fluidcast/silent-wav.js';

/**
 * Fluidcast panes over real in-page Harness sessions: what only a browser can show. Visibility
 * pauses (blur sends nothing, a surface switch pauses exactly the hidden sessions and a returning
 * player subscribes only after those pauses land), per-player keys, Escape inside zen, the toggle's
 * place in the floating cluster, and screenshots of that cluster over the player (an overlap with
 * the dock the user accepted for one consistent location).
 *
 * "Nothing plays" is judged from the player's own paused presentation and from the commands the
 * runtime saw: a `PlaybackFinished` only follows audio that actually played. Speech requests are
 * recorded for diagnostics only, because the player may prefetch.
 *
 * Every test fails on a session route the fake runtime does not answer, so a route the player
 * newly calls cannot quietly degrade to a 404.
 */

const SESSION_A = 'fc-session-a';
const SESSION_B = 'fc-session-b';

interface RecordedCommand {
  readonly fluidcastSessionId: string;
  readonly tag: string;
  readonly at: number;
  readonly settledAt?: number;
  readonly outcome?: string;
}

const commands = (page: Page) =>
  page.evaluate(() => window.fluidcastTestSupport!.commands()) as Promise<RecordedCommand[]>;
const subscriptions = (page: Page) =>
  page.evaluate(() => window.fluidcastTestSupport!.subscriptions()) as Promise<
    { fluidcastSessionId: string; at: number }[]
  >;
const commandsOf = async (page: Page, id: string, tag?: string) =>
  (await commands(page)).filter(
    (command) => command.fluidcastSessionId === id && (tag === undefined || command.tag === tag),
  );

const pane = (page: Page, title: string) => page.locator(`section[aria-label="${title}"]`);
const paneA = (page: Page) => pane(page, 'claude · voice A');
const paneB = (page: Page) => pane(page, 'claude · voice B');
const player = (scope: Locator) => scope.locator('.fluidcast-player');

/**
 * The player streams speech through its own `<audio>` element from the runtime's speech URL, which
 * no `fetch` stub can answer. The route serves the same silence the page's fake voice produces,
 * with the CORS header the element's `crossOrigin` load needs.
 */
async function routeSpeech(page: Page) {
  await page.route('http://fluidcast-test-support.invalid/**/speech/**', (route) =>
    route.fulfill({
      status: 200,
      body: Buffer.from(silentWav()),
      headers: { 'content-type': 'audio/wav', 'access-control-allow-origin': '*' },
    }),
  );
}

async function open(page: Page, query = '') {
  await routeSpeech(page);
  await page.goto(query);
  await expect(player(paneA(page))).toBeVisible();
  await expect(player(paneB(page))).toBeVisible();
  // Both sessions wait for their preloaded start: nothing has played anywhere.
  await expect(paneA(page).getByRole('button', { name: 'Tap to start' })).toBeVisible();
  await expect(paneB(page).getByRole('button', { name: 'Tap to start' })).toBeVisible();
}

async function startA(page: Page) {
  await paneA(page).getByRole('button', { name: 'Tap to start' }).click();
  await expect.poll(async () => (await commandsOf(page, SESSION_A)).length).toBeGreaterThan(0);
  await expect(paneA(page).getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
}

test.afterEach(async ({ page }) => {
  // A test that never opened the page has no fake runtime to ask.
  const unmatched = await page.evaluate(
    () => window.fluidcastTestSupport?.unmatchedRequests() ?? [],
  );
  expect(unmatched, 'session requests the fake runtime has no route for').toEqual([]);
});

/** Starts pane A, then interrupts it, so its composer is enabled. */
async function composeInA(page: Page) {
  await startA(page);
  await player(paneA(page)).focus();
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await commandsOf(page, SESSION_A, 'Interrupt')).length).toBe(1);
  const message = paneA(page).getByRole('combobox', { name: 'Message' });
  await expect(message).toBeEnabled();
  return message;
}

const showSurface = (page: Page, surfaceId: number) =>
  page.locator(`[data-show-surface="${surfaceId}"]`).click();

const clusterOf = (page: Page) => paneA(page).locator('[data-pane-action-cluster]');

test('the toggle is the leftmost button of the floating cluster, lit while the pane is in Fluidcast mode', async ({
  page,
}) => {
  await open(page);
  await paneA(page).hover();

  // Where every other pane keeps it: floating lower-right, revealed on hover.
  await expect(clusterOf(page)).toHaveCSS('opacity', '1');
  await expect(clusterOf(page)).toHaveCSS('position', 'absolute');
  const labels = await clusterOf(page)
    .locator('button')
    .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label')));
  expect(labels).toEqual([
    'Switch to terminal',
    'Split pane right',
    'Split pane down',
    'Delete pane',
  ]);
  await expect(clusterOf(page).locator('button').first()).toHaveAttribute('aria-pressed', 'true');
});

test('nothing plays until the listener taps, and a tap in one player starts only that one', async ({
  page,
}) => {
  await open(page);
  await page.waitForTimeout(500);
  expect(await commandsOf(page, SESSION_A, 'PlaybackFinished')).toEqual([]);
  expect(await commandsOf(page, SESSION_B)).toEqual([]);

  await startA(page);

  expect(await commandsOf(page, SESSION_B)).toEqual([]);
  await expect(paneB(page).getByRole('button', { name: 'Tap to start' })).toBeVisible();
});

for (const [name, which, id] of [
  ['A', paneA, SESSION_A],
  ['B', paneB, SESSION_B],
] as const) {
  test(`clicking pane ${name}'s composer keeps focus there, so typing reaches it`, async ({
    page,
  }) => {
    await open(page);
    // Start, then interrupt, so the composer is enabled.
    await which(page).getByRole('button', { name: 'Tap to start' }).click();
    await expect(which(page).getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
    await player(which(page)).focus();
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await commandsOf(page, id, 'Interrupt')).length).toBe(1);

    const message = which(page).getByRole('combobox', { name: 'Message' });
    await expect(message).toBeEnabled();
    await message.click();
    // Longer than the activation's deferred focus (two animation frames).
    await page.waitForTimeout(150);
    await expect(message).toBeFocused();
    await page.keyboard.type('hello');
    await expect(message).toHaveValue('hello');
  });
}

test('blurring a visible pane, or the window, sends no Pause', async ({ page }) => {
  await open(page);
  await startA(page);

  await player(paneB(page)).click({ position: { x: 10, y: 120 } });
  await page.evaluate(() => {
    window.dispatchEvent(new Event('blur'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.locator('[data-active-surface-id]').click();
  await page.waitForTimeout(300);

  expect((await commands(page)).filter((command) => command.tag === 'Pause')).toEqual([]);
});

test('Escape in a focused player changes only that player’s session', async ({ page }) => {
  await open(page);
  await startA(page);

  await player(paneA(page)).focus();
  await page.keyboard.press('Escape');

  await expect.poll(async () => (await commandsOf(page, SESSION_A, 'Interrupt')).length).toBe(1);
  expect(await commandsOf(page, SESSION_B)).toEqual([]);
});

test('Escape that a focused player uses does not exit zen', async ({ page }) => {
  await open(page);
  await startA(page);
  await page.locator('[data-zen-on]').click();
  await expect(page.locator('[data-zen]')).toHaveAttribute('data-zen', '1');

  await player(paneA(page)).focus();
  await page.keyboard.press('Escape');

  await expect.poll(async () => (await commandsOf(page, SESSION_A, 'Interrupt')).length).toBe(1);
  await expect(page.locator('[data-zen]')).toHaveAttribute('data-zen', '1');
});

test('a surface switch pauses both sessions; returning at once waits for those pauses and stays paused', async ({
  page,
}) => {
  await open(page);
  await startA(page);
  await page.evaluate(() => window.fluidcastTestSupport!.delayPauses(800));
  const before = (await subscriptions(page)).length;

  await showSurface(page, 42);
  await expect
    .poll(async () => (await commands(page)).filter((c) => c.tag === 'Pause').length)
    .toBe(2);
  // Back before either delayed Pause has landed.
  await showSurface(page, 41);
  await expect(player(paneA(page))).toBeVisible();

  await expect
    .poll(async () => (await subscriptions(page)).length)
    .toBeGreaterThanOrEqual(before + 2);
  const pauses = await commands(page);
  const returned = (await subscriptions(page)).slice(before);
  for (const id of [SESSION_A, SESSION_B]) {
    const pause = pauses.find((c) => c.fluidcastSessionId === id && c.tag === 'Pause');
    const subscription = returned.find((s) => s.fluidcastSessionId === id);
    expect(pause?.settledAt, `${id} pause settled`).toBeDefined();
    expect(subscription, `${id} resubscribed`).toBeDefined();
    expect(subscription!.at, `${id} subscribed after its pause landed`).toBeGreaterThanOrEqual(
      pause!.settledAt!,
    );
  }

  expect(await page.evaluate((id) => window.fluidcastTestSupport!.paused(id), SESSION_A)).toBe(
    true,
  );
  await expect(paneA(page).getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  const finishedOnReturn = (await commandsOf(page, SESSION_A, 'PlaybackFinished')).length;
  await page.waitForTimeout(1500);
  expect((await commandsOf(page, SESSION_A, 'PlaybackFinished')).length).toBe(finishedOnReturn);

  // Only the listener's Play resumes it.
  const playsBefore = (await commandsOf(page, SESSION_A, 'Play')).length;
  await paneA(page).getByRole('button', { name: 'Play', exact: true }).click();
  await expect
    .poll(async () => (await commandsOf(page, SESSION_A, 'Play')).length)
    .toBe(playsBefore + 1);
  await expect(paneA(page).getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
});

test('a failing Pause still lets the returning player subscribe within the bound, nothing plays, and a Warning is logged', async ({
  page,
}) => {
  const logged: string[] = [];
  page.on('console', (message) => logged.push(`${message.type()} ${message.text()}`));
  await open(page);
  await startA(page);
  await page.evaluate(() => window.fluidcastTestSupport!.failPauses(true));
  const before = (await subscriptions(page)).length;

  await showSurface(page, 42);
  await expect
    .poll(async () => (await commands(page)).filter((c) => c.outcome === 'failed').length)
    .toBe(2);
  await showSurface(page, 41);

  await expect
    .poll(async () => (await subscriptions(page)).length, { timeout: 3000 })
    .toBeGreaterThanOrEqual(before + 2);
  expect(
    logged.some((line) => line.includes('hide pause failed')),
    logged.join('\n'),
  ).toBe(true);

  const finishedOnReturn = (await commandsOf(page, SESSION_A, 'PlaybackFinished')).length;
  await page.waitForTimeout(1500);
  expect((await commandsOf(page, SESSION_A, 'PlaybackFinished')).length).toBe(finishedOnReturn);
  await expect(
    paneA(page)
      .getByText(/Tap to resume|Play/)
      .first(),
  ).toBeVisible();
});

for (const [frame, width] of [
  ['100', '50'],
  ['50', '25'],
] as const) {
  test(`cluster over the player at about ${width}% pane width (recorded, accepted)`, async ({
    page,
  }, testInfo) => {
    await open(page, `?frame=${frame}`);
    // At rest (the preloaded start), then mid-line, when the dock shows Interrupt. The overlap with
    // the player's dock is accepted for one consistent cluster location; this records it.
    for (const state of ['ready', 'speaking'] as const) {
      if (state === 'speaking') await startA(page);
      await paneA(page).hover();
      await expect(clusterOf(page)).toHaveCSS('opacity', '1');
      const covered = await controlsUnder(paneA(page), clusterOf(page));
      testInfo.annotations.push({
        type: `cluster-vs-dock ${width}% ${state}`,
        description:
          covered.length === 0
            ? 'no player control under the cluster'
            : `covers: ${covered.join(', ')}`,
      });
      const shot = await paneA(page).screenshot({
        path: `test-results/fluidcast-cluster-${width}-${state}.png`,
      });
      await testInfo.attach(`cluster-${width}-${state}`, { body: shot, contentType: 'image/png' });
    }
  });
}

// Failed switches to Fluidcast (surface 43). The pane shows the failure where the user acted, never
// a terminal behind it, and its two buttons send the projection they were shown as `from`.

const FAILED_SURFACE = 43;
const failedFrom = { generation: 2, fluidcastSessionId: null, processIncarnation: null };

interface RecordedSwitch {
  readonly agentSessionId: number;
  readonly body: unknown;
}

const switches = (page: Page) =>
  page.evaluate(() => window.fluidcastTestSupport!.switches()) as Promise<RecordedSwitch[]>;
const claims = (page: Page) => page.evaluate(() => window.fluidcastTestSupport!.claims());
const scriptSwitches = (page: Page, outcomes: unknown[]) =>
  page.evaluate(
    (scripted) => window.fluidcastTestSupport!.scriptSwitches(scripted as never),
    outcomes,
  );
const toasts = (page: Page) => page.getByRole('button', { name: 'Dismiss notification' });

/** Opens the failed surface, recording every WebSocket the page opens (a terminal attach is one). */
async function openFailed(page: Page) {
  const sockets: string[] = [];
  page.on('websocket', (socket) => sockets.push(socket.url()));
  await open(page);
  await showSurface(page, FAILED_SURFACE);
  await expect(pane(page, 'claude · stop failed')).toBeVisible();
  return sockets;
}

const panel = (scope: Locator) => ({
  retry: scope.getByRole('button', { name: 'Retry', exact: true }),
  back: scope.getByRole('button', { name: 'Back to terminal', exact: true }),
});

for (const [title, agentSessionId, heading, diagnostic] of [
  [
    'claude · stop failed',
    174,
    "Couldn't stop the terminal",
    'terminal_stop_failed · PTY kill error (ptyProcess=30): Error',
  ],
  [
    'claude · unreadable',
    175,
    "Fluidcast couldn't read this conversation",
    'fluidcast_session_unreadable · SessionUnreadable',
  ],
  [
    'claude · start failed',
    176,
    "Fluidcast didn't start",
    'fluidcast_start_failed · executable_not_found',
  ],
  [
    'claude · preparation failed',
    177,
    "Couldn't finish the switch",
    'fluidcast_preparation_failed · Error',
  ],
] as const) {
  test(`a ${diagnostic.split(' ')[0]} pane shows its failure, attaches nothing, and Retry and Back send what it shows`, async ({
    page,
  }) => {
    const sockets = await openFailed(page);
    const scope = pane(page, title);

    await expect(scope.getByText(heading, { exact: true })).toBeVisible();
    await expect(scope.getByText(diagnostic, { exact: true })).toBeVisible();
    await expect(scope).toContainText('switch failed');
    await expect(player(scope)).toHaveCount(0);

    // Retry fails again, as a new handoff failure: the panel re-reads and shows it, no inline error.
    await scriptSwitches(page, [
      {
        kind: 'handoff_failure',
        failure: { code: 'fluidcast_start_failed', reason: 'session_build_failed' },
      },
    ]);
    await panel(scope).retry.click();
    await expect(scope.getByText('fluidcast_start_failed · session_build_failed')).toBeVisible();
    await expect(scope.locator('.text-error', { hasText: /\S/ })).toHaveCount(0);
    expect(await toasts(page).count()).toBe(0);

    // Back to terminal is made against the failure now shown, one generation on.
    await panel(scope).back.click();
    await expect(panel(scope).back).toHaveCount(0);

    expect(await switches(page)).toEqual([
      { agentSessionId, body: { mode: 'fluidcast', from: failedFrom } },
      {
        agentSessionId,
        body: { mode: 'terminal', from: { ...failedFrom, generation: 3 } },
      },
    ]);
    expect(await claims(page)).toEqual([]);
    expect(sockets).toEqual([]);
  });
}

test('a failure pane offers split and delete, and no toggle', async ({ page }) => {
  await openFailed(page);
  const scope = pane(page, 'claude · start failed');
  await scope.hover();

  const cluster = scope.locator('[data-pane-action-cluster]');
  await expect(cluster).toHaveCSS('opacity', '1');
  const labels = await cluster
    .locator('button')
    .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label')));
  expect(labels).toEqual(['Split pane right', 'Split pane down', 'Delete pane']);
});

test('a refusal before the switch began shows inline in the panel, not as a toast', async ({
  page,
}) => {
  await openFailed(page);
  const scope = pane(page, 'claude · unreadable');
  await scriptSwitches(page, [{ kind: 'refusal', status: 409, code: 'agent_session_deleting' }]);

  await panel(scope).retry.click();

  await expect(
    scope.getByText("That agent's worktree is being deleted, so it can't switch now."),
  ).toBeVisible();
  await expect(panel(scope).retry).toBeEnabled();
  expect(await toasts(page).count()).toBe(0);
});

test("the toggle's handoff failure shows the panel and no toast; an admission refusal still toasts", async ({
  page,
}) => {
  await openFailed(page);
  const scope = pane(page, 'claude · terminal');
  const toggle = scope.getByRole('button', { name: 'Switch to Fluidcast' });

  // Refused before cleanup began: nothing changed in the pane, so the toast is the feedback.
  await scriptSwitches(page, [
    { kind: 'refusal', status: 409, code: 'fluidcast_unavailable', data: { reason: 'disabled' } },
  ]);
  await scope.hover();
  await toggle.click();
  await expect(toasts(page)).toHaveCount(1);
  await toasts(page).click();
  await expect(toasts(page)).toHaveCount(0);

  await scriptSwitches(page, [
    {
      kind: 'handoff_failure',
      failure: { code: 'fluidcast_start_failed', reason: 'executable_not_found' },
    },
  ]);
  await scope.hover();
  await toggle.click();

  await expect(scope.getByText("Fluidcast didn't start", { exact: true })).toBeVisible();
  await page.waitForTimeout(300);
  expect(await toasts(page).count()).toBe(0);
  expect(await switches(page)).toEqual([
    {
      agentSessionId: 178,
      body: {
        mode: 'fluidcast',
        from: { generation: 0, fluidcastSessionId: null, processIncarnation: null },
      },
    },
    {
      agentSessionId: 178,
      body: {
        mode: 'fluidcast',
        from: { generation: 0, fluidcastSessionId: null, processIncarnation: null },
      },
    },
  ]);
});

/** The player's own controls whose boxes intersect the cluster's. */
async function controlsUnder(scope: Locator, cluster: Locator): Promise<string[]> {
  const clusterBox = await cluster.boundingBox();
  if (!clusterBox) return [];
  const controls = scope.locator(
    '.fluidcast-player button:visible, .fluidcast-player textarea:visible, .fluidcast-player input:visible',
  );
  const covered: string[] = [];
  for (const control of await controls.all()) {
    const box = await control.boundingBox();
    if (!box) continue;
    const overlaps =
      box.x < clusterBox.x + clusterBox.width &&
      box.x + box.width > clusterBox.x &&
      box.y < clusterBox.y + clusterBox.height &&
      box.y + box.height > clusterBox.y;
    if (overlaps) {
      covered.push((await control.getAttribute('aria-label')) ?? (await control.innerText()));
    }
  }
  return covered;
}

test("typing / suggests the worker's skills from the runtime", async ({ page }) => {
  await open(page);
  const message = await composeInA(page);
  await message.click();
  await page.keyboard.type('/');

  const skills = paneA(page).getByRole('listbox', { name: 'Skills' });
  await expect(skills).toBeVisible();
  await expect(skills.getByRole('option')).toHaveText([
    /\/review\s*Review the current diff/,
    /\/brainstorming\s*Think a change through in phases/,
  ]);
});

test('unavailable skills leave the suggestions out, and the player keeps working', async ({
  page,
}) => {
  await open(page, '?skills=unavailable');
  // The player reads skills once; its suggestions can only be judged absent after that read failed.
  await expect
    .poll(() => page.evaluate(() => window.fluidcastTestSupport!.servedRequests()))
    .toContain(`GET /fluidcast-sessions/${SESSION_A}/worker/skills → 502`);
  const message = await composeInA(page);
  await message.click();
  await page.keyboard.type('/review the diff');
  await expect(paneA(page).getByRole('listbox', { name: 'Skills' })).toHaveCount(0);

  // A message still sends, with the typed skill as its text.
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await commandsOf(page, SESSION_A, 'SendMessage')).length).toBe(1);

  // The worker's status and transcript still stream into the Worker layer.
  await player(paneA(page)).focus();
  await page.keyboard.press('w');
  const worker = paneA(page).locator('section[aria-label="Worker"]');
  await expect(
    worker.getByRole('button', { name: 'Copy session ID native-session' }),
  ).toBeVisible();
  await expect(worker).toContainText('The plan has three steps.');
});
