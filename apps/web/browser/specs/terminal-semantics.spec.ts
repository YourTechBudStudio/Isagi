import { expect, test, type Page } from '@playwright/test';

const rendererFor = (projectName: string) => (projectName === 'dom-fallback' ? 'dom' : 'webgl');

/** X10 (`ESC [ M …`) or SGR (`ESC [ < b ; x ; y M|m`) mouse reporting, whichever xterm negotiated. */
const MOUSE_REPORT = /\[(M|<\d)/;

test('StrictMode creates one claim, terminal, and socket and reveals after causal milestones', async ({
  page,
}, testInfo) => {
  await openFixture(page, testInfo.project.name, 'recipe=codex');
  await revealed(page);
  const counters = await readCounters(page);
  expect(counters.claimAttempts).toBe(1);
  expect(counters.terminalsCreated).toBe(1);
  expect(counters.socketsCreated).toBe(1);
  expect(counters.socketsOpened).toBe(1);
  expect(counters.milestones.map((event) => event.type)).toEqual(
    expect.arrayContaining([
      'parse_barrier_completed',
      'render_observed',
      'activation_render_qualified',
      'reveal_published',
    ]),
  );
  expect(milestone(counters, 'parse_barrier_completed')).toBeLessThanOrEqual(
    milestone(counters, 'reveal_published'),
  );
});

test('surface navigation releases one destination before acquiring a different DOM node', async ({
  page,
}, testInfo) => {
  await openFixture(page, testInfo.project.name);
  await revealed(page);
  await markXterm(page);
  await page.locator('[data-action="probe-relocation"]').click();
  await page.locator('[data-action="surface-relocate"]').click();
  await expect(page.locator('[data-destination="target"] .xterm')).toHaveCount(1);
  await expect(page.locator('[data-destination="source"]')).toHaveCount(0);
  await expectMarkedXterm(page);
  const counters = await readCounters(page);
  expect(counters.claimAttempts).toBe(1);
  expect(counters.socketsCreated).toBe(1);
  await expectWarmFrameBoundary(page);
  await expectInteractive(page);
});

test('zen relocation overlaps registration and moves the stable host to the newest slot', async ({
  page,
}, testInfo) => {
  await openFixture(page, testInfo.project.name);
  await revealed(page);
  await markXterm(page);
  await page.locator('[data-action="probe-relocation"]').click();
  await page.locator('[data-action="zen-relocate"]').click();
  await expect(page.locator('[data-destination="target"] .xterm')).toHaveCount(1);
  await expect(page.locator('[data-destination="source"]')).toHaveCount(0);
  await expectMarkedXterm(page);
  expect((await readCounters(page)).claimAttempts).toBe(1);
  await expectWarmFrameBoundary(page);
  await expectInteractive(page);
});

test('same-session overlapping slots arbitrate newest and fall back without another visibility claim', async ({
  page,
}, testInfo) => {
  await openFixture(page, testInfo.project.name);
  await revealed(page);
  await markXterm(page);
  await page.locator('[data-action="register-overlap"]').click();
  await expect(page.locator('[data-destination="target"] .xterm')).toHaveCount(1);
  await expect(page.locator('[data-destination="source"] .xterm')).toHaveCount(0);
  await page.locator('[data-action="release-overlap"]').click();
  await expect(page.locator('[data-destination="source"] .xterm')).toHaveCount(1);
  await expectMarkedXterm(page);
  const counters = await readCounters(page);
  expect(counters.claimAttempts).toBe(1);
  expect(counters.terminalsCreated).toBe(1);
});

test('focus transfers deterministically between distinct visible sessions', async ({
  page,
}, testInfo) => {
  await openFixture(page, testInfo.project.name, 'sessions=2&topology=focus');
  await expect(page.locator('[data-phase="revealed"]')).toHaveCount(2);
  await page.locator('[data-action="focus-next"]').click();
  await expect(page.locator('[data-session="2"] .xterm-helper-textarea')).toBeFocused();
  await page.locator('[data-action="focus-next"]').click();
  await expect(page.locator('[data-session="1"] .xterm-helper-textarea')).toBeFocused();
});

test('resize changes fitted geometry and reflows real xterm cells', async ({ page }, testInfo) => {
  await openFixture(page, testInfo.project.name, 'recipe=shell');
  await revealed(page);
  const before = await inspect(page);
  await page.locator('[data-action="resize"]').click();
  await expect.poll(async () => (await inspect(page))[0]?.cols).toBeLessThan(before[0]!.cols);
  const after = await inspect(page);
  expect(after[0]!.visibleText).toContain('shell');
});

test('paste crosses the production DOM input path exactly once and preserves ordering', async ({
  page,
}, testInfo) => {
  await openFixture(page, testInfo.project.name);
  await revealed(page);
  const textarea = page.locator('.xterm-helper-textarea');
  await textarea.evaluate((element) => {
    const data = new DataTransfer();
    data.setData('text/plain', 'paste-one\npaste-two');
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData: data }));
  });
  await expect
    .poll(async () => inputPayloads(await readCounters(page)).join(''))
    .toContain('paste-one\rpaste-two');
  expect(
    inputPayloads(await readCounters(page))
      .join('')
      .match(/paste-one/g),
  ).toHaveLength(1);
});

test('selection and copy use xterm selection through the production copy handler', async ({
  page,
  context,
}, testInfo) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openFixture(page, testInfo.project.name, 'recipe=shell');
  await revealed(page);
  const screen = page.locator('.xterm-screen');
  const box = await screen.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + 3, box!.y + 8);
  await page.mouse.down();
  await page.mouse.move(box!.x + Math.min(150, box!.width - 3), box!.y + 8);
  await page.mouse.up();
  await page.locator('[data-action="inspect"]').click();
  await expect.poll(async () => (await inspect(page))[0]?.selection.length ?? 0).toBeGreaterThan(0);
  const selection = (await inspect(page))[0]!.selection;
  await page.locator('.xterm-helper-textarea').focus();
  const isMac = await page.evaluate(() => /mac/i.test(navigator.platform));
  await page.keyboard.press(isMac ? 'Meta+c' : 'Control+Shift+c');
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toBe(selection);
});

test('parked output parses under the parking root and preserves the held viewport', async ({
  page,
}, testInfo) => {
  await openFixture(page, testInfo.project.name, 'recipe=shell&bytes=65536');
  await revealed(page);
  await page.locator('.xterm-screen').hover();
  await page.mouse.wheel(0, -2000);
  const before = await inspect(page);
  expect(before[0]!.viewportY).toBeLessThan(before[0]!.baseY);
  await markXterm(page);
  await page.locator('[data-action="toggle"]').click();
  await expect(page.locator('[data-destination] .xterm')).toHaveCount(0);
  await expect(page.locator('[data-terminal-parking-root] .xterm')).toHaveCount(1);
  await page.locator('[data-action="live-output"]').click();
  const hidden = await inspect(page);
  expect(hidden[0]!.viewportY).toBe(before[0]!.viewportY);
  await page.locator('[data-action="toggle"]').click();
  await expectMarkedXterm(page);
  expect((await inspect(page))[0]!.baseY).toBeGreaterThanOrEqual(before[0]!.baseY);
});

test('keyboard input returns a held viewport to latest', async ({ page }, testInfo) => {
  await openFixture(page, testInfo.project.name, 'bytes=65536');
  await revealed(page);
  await page.locator('.xterm-screen').hover();
  await page.mouse.wheel(0, -2000);
  expect((await inspect(page))[0]!.viewportY).toBeLessThan((await inspect(page))[0]!.baseY);
  await page.locator('.xterm-helper-textarea').press('x');
  await expect
    .poll(async () => (await inspect(page))[0]?.viewportY)
    .toBe((await inspect(page))[0]!.baseY);
});

test('manual replay stays covered through synchronized output and drains held live output once', async ({
  page,
}, testInfo) => {
  await openFixture(page, testInfo.project.name, 'manual=1&recipe=shell');
  await page.locator('[data-action="open-socket"]').click();
  await page.locator('[data-action="sync-start"]').click();
  await page.locator('[data-action="replay-start"]').click();
  await page.locator('[data-action="replay-chunks"]').click();
  await page.locator('[data-action="replay-end"]').click();
  await page.locator('[data-action="live-output"]').click();
  await expect(page.locator('[data-terminal-cover]')).toHaveCount(1);
  expect(
    (await readCounters(page)).milestones.some((event) => event.type === 'reveal_published'),
  ).toBe(false);
  await page.locator('[data-action="sync-end"]').click();
  await revealed(page);
  await expect
    .poll(async () => ((await inspect(page))[0]!.tailText.match(/held-live-marker/g) ?? []).length)
    .toBe(1);
});

test('alternate buffer and ED3 report honest public-buffer state', async ({ page }, testInfo) => {
  await openFixture(page, testInfo.project.name);
  await revealed(page);
  await page.locator('[data-action="alternate-on"]').click();
  await expect.poll(async () => (await inspect(page))[0]?.buffer).toBe('alternate');
  expect((await inspect(page))[0]!.visibleText).toContain('alternate-marker');
  await page.locator('[data-action="alternate-off"]').click();
  await expect.poll(async () => (await inspect(page))[0]?.buffer).toBe('normal');
  await page.locator('[data-action="ed3"]').click();
  expect((await inspect(page))[0]!.buffer).toBe('normal');
});

test('real WebGL context loss falls back only when the capability exists', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'dom-fallback', 'forced DOM project has no WebGL context');
  await openFixture(page, 'webgl-attempt');
  await revealed(page);
  const before = await readCounters(page);
  test.skip(before.webglCreated === 0, 'WebGL addon could not initialize on this browser');
  await page.locator('[data-action="lose-context"]').click();
  test.skip(
    (await page.locator('[data-context-loss]').textContent()) === 'unavailable',
    'WEBGL_lose_context is unavailable',
  );
  await expect.poll(async () => (await readCounters(page)).webglDisposed).toBeGreaterThan(0);
  await expect(page.locator('[data-session="1"]')).not.toHaveAttribute('data-renderer-warning', '');
});

// Each harness owns the screen differently, and the state that distinguishes them exists only
// *between* entering and exiting. Streaming a recipe end to end and asserting the final buffer
// is normal cannot tell a harness that entered the alternate screen from one that never did,
// so every scenario below is staged and asserts the intermediate state.

test('codex repaints its row inline, never leaves the normal buffer, and drops scrollback on ED3', async ({
  page,
}, testInfo) => {
  await openFixture(page, testInfo.project.name, 'recipe=codex&bytes=32768');
  await revealed(page);
  await scrollToLatest(page);
  await page.locator('[data-action="recipe-enter"]').click();
  await expect
    .poll(async () => (await inspect(page))[0]?.visibleText)
    .toContain('codex progress 0%');
  const entered = (await inspect(page))[0]!;
  expect(entered.buffer).toBe('normal');
  await page.locator('[data-action="recipe-redraw"]').click();
  await expect
    .poll(async () => (await inspect(page))[0]?.visibleText)
    .toContain('codex progress 100%');
  const redrawn = (await inspect(page))[0]!;
  // The repaint overwrote the row in place: no alternate screen, no new row, same viewport.
  expect(redrawn.visibleText).not.toContain('codex progress 0%');
  expect(redrawn.buffer).toBe('normal');
  expect(redrawn.viewportY).toBe(entered.viewportY);
  await page.locator('[data-action="recipe-exit"]').click();
  await expect
    .poll(async () => (await inspect(page))[0]?.normalRows)
    .toBeLessThan(redrawn.normalRows);
  const cleared = (await inspect(page))[0]!;
  expect(cleared.buffer).toBe('normal');
  expect(cleared.visibleText).toContain('codex progress 100%');
});

test('claude enters the alternate screen and restores the normal buffer untouched on exit', async ({
  page,
}, testInfo) => {
  await openFixture(page, testInfo.project.name, 'recipe=claude&bytes=32768');
  await revealed(page);
  await scrollToLatest(page);
  const before = (await inspect(page))[0]!;
  expect(before.buffer).toBe('normal');
  await page.locator('[data-action="recipe-enter"]').click();
  await expect.poll(async () => (await inspect(page))[0]?.buffer).toBe('alternate');
  const alternate = (await inspect(page))[0]!;
  expect(alternate.visibleText).toContain('claude alternate frame');
  expect(alternate.visibleText).not.toContain('claude:');
  expect(alternate.normalRows).toBe(before.normalRows);
  await page.locator('[data-action="recipe-redraw"]').click();
  await expect
    .poll(async () => (await inspect(page))[0]?.visibleText)
    .toContain('claude alternate redraw');
  await page.locator('[data-action="recipe-exit"]').click();
  await expect.poll(async () => (await inspect(page))[0]?.buffer).toBe('normal');
  const restored = (await inspect(page))[0]!;
  expect(restored.visibleText).not.toContain('claude alternate');
  expect(restored.visibleText).toBe(before.visibleText);
  expect(restored.normalRows).toBe(before.normalRows);
});

test('pi repaints inline and sends Shift+Enter through the production composer-newline key', async ({
  page,
}, testInfo) => {
  await openFixture(page, testInfo.project.name, 'recipe=pi&bytes=32768');
  await revealed(page);
  await scrollToLatest(page);
  await page.locator('[data-action="recipe-enter"]').click();
  await expect.poll(async () => (await inspect(page))[0]?.visibleText).toContain('pi prompt draft');
  await page.locator('[data-action="recipe-redraw"]').click();
  await expect.poll(async () => (await inspect(page))[0]?.visibleText).toContain('pi prompt final');
  const redrawn = (await inspect(page))[0]!;
  expect(redrawn.visibleText).not.toContain('pi prompt draft');
  expect(redrawn.buffer).toBe('normal');

  const sentBefore = inputPayloads(await readCounters(page)).length;
  await page.locator('.xterm-helper-textarea').press('Shift+Enter');
  await expect
    .poll(async () => inputPayloads(await readCounters(page)).length)
    .toBeGreaterThan(sentBefore);
  // The composer newline must arrive bracketed and alone: an unbracketed `\r` here is a
  // submitted prompt, which is the exact defect this handler exists to prevent.
  const sent = inputPayloads(await readCounters(page)).slice(sentBefore);
  expect(sent.join('')).toBe('\u001b[200~\n\u001b[201~');

  await page.locator('[data-action="recipe-exit"]').click();
  await expect
    .poll(async () => (await inspect(page))[0]?.normalRows)
    .toBeLessThan(redrawn.normalRows);
});

test('opencode owns the mouse while it holds the alternate screen and gives it back on exit', async ({
  page,
}, testInfo) => {
  await openFixture(page, testInfo.project.name, 'recipe=opencode&bytes=32768');
  await revealed(page);
  await page.locator('[data-action="recipe-enter"]').click();
  await expect.poll(async () => (await inspect(page))[0]?.buffer).toBe('alternate');
  expect((await inspect(page))[0]!.visibleText).toContain('opencode frame');

  const box = (await page.locator('.xterm-screen').boundingBox())!;
  const owned = inputPayloads(await readCounters(page)).length;
  await page.mouse.click(box.x + 20, box.y + 20);
  await expect
    .poll(async () =>
      inputPayloads(await readCounters(page))
        .slice(owned)
        .join(''),
    )
    .toMatch(MOUSE_REPORT);

  await page.locator('[data-action="recipe-exit"]').click();
  await expect.poll(async () => (await inspect(page))[0]?.buffer).toBe('normal');
  const released = inputPayloads(await readCounters(page)).length;
  await page.mouse.click(box.x + 20, box.y + 20);
  // No poll here on purpose: this asserts an absence, so it needs a settled observation
  // rather than the first one that happens to satisfy it.
  await page.locator('[data-action="inspect"]').click();
  expect(
    inputPayloads(await readCounters(page))
      .slice(released)
      .join(''),
  ).not.toMatch(MOUSE_REPORT);
});

test('an ordinary shell runs a full-screen program and gets its scrollback back afterwards', async ({
  page,
}, testInfo) => {
  await openFixture(page, testInfo.project.name, 'recipe=shell&bytes=32768');
  await revealed(page);
  await scrollToLatest(page);
  const before = (await inspect(page))[0]!;
  expect(before.buffer).toBe('normal');
  expect(before.rows).toBeGreaterThanOrEqual(10);
  await page.locator('[data-action="recipe-redraw"]').click();
  await expect.poll(async () => (await inspect(page))[0]?.buffer).toBe('alternate');
  const fullScreen = (await inspect(page))[0]!;
  // Cursor addressing landed the cell at row 10, column 5 — the program drew where it asked to.
  expect(fullScreen.visibleText.split('\n')[9]).toBe('    shell tui cell');
  expect(fullScreen.normalRows).toBe(before.normalRows);
  await page.locator('[data-action="recipe-exit"]').click();
  await expect.poll(async () => (await inspect(page))[0]?.buffer).toBe('normal');
  const restored = (await inspect(page))[0]!;
  expect(restored.visibleText).toBe(before.visibleText);
  expect(restored.normalRows).toBe(before.normalRows);
});

async function openFixture(page: Page, projectName: string, query = '') {
  const suffix = query ? `&${query}` : '';
  await page.goto(`/?renderer=${rendererFor(projectName)}${suffix}`);
}

async function revealed(page: Page) {
  await expect(page.locator('[data-session="1"]')).toHaveAttribute('data-phase', 'revealed');
  await expect(page.locator('[data-terminal-cover]')).toHaveCount(0);
}

async function markXterm(page: Page) {
  await page
    .locator('.xterm')
    .evaluate((element) => (element.dataset.fixtureIdentity = 'original'));
}

async function expectMarkedXterm(page: Page) {
  await expect(page.locator('.xterm')).toHaveAttribute('data-fixture-identity', 'original');
}

async function inspect(page: Page) {
  await page.locator('[data-action="inspect"]').click();
  return JSON.parse((await page.locator('[data-inspection]').textContent()) ?? '[]') as Array<{
    cols: number;
    rows: number;
    buffer: 'normal' | 'alternate';
    viewportY: number;
    baseY: number;
    normalRows: number;
    alternateRows: number;
    selection: string;
    visibleText: string;
    tailText: string;
    estimatedBytes: number;
  }>;
}

/**
 * Warm acceptance: interactive within one animation frame of the visible *host* becoming
 * measurable. Both ends are observed events — the first frame the host had a box inside the
 * destination, and the frame it first painted there — so the boundary is calculated from the
 * causal moments rather than inferred from how many frames were requested.
 *
 * Starting the boundary at the destination's own box instead of the host's overstated the gap:
 * a slot can have a box a frame before the host is appended into it, and the controller cannot
 * fit a host that is not there yet.
 */
async function expectWarmFrameBoundary(page: Page) {
  await expect
    .poll(async () => (await readCounters(page)).relocation.interactiveFrame)
    .not.toBeNull();
  const relocation = (await readCounters(page)).relocation;
  expect(relocation.measurableFrame).not.toBeNull();
  expect(
    relocation.interactiveFrame! - relocation.measurableFrame!,
    // Controller frames and paints are carried so a failure says which side was late.
    `warm relocation frames: ${JSON.stringify(relocation)}`,
  ).toBeLessThanOrEqual(1);
}

/**
 * A cold reveal with nothing remembered lands on the oldest available row, so a staged harness
 * scenario has to put the viewport where a user watching a live harness actually is — at the
 * latest output — before asserting on visible cells. Scrolling down is the user's own way of
 * saying that, and it leaves the buffer untouched.
 */
async function scrollToLatest(page: Page) {
  // Typing is the production way back to the latest row, and unlike a wheel it lands there in
  // one step rather than a couple of lines at a time.
  await page.locator('.xterm-helper-textarea').press('x');
  await expect
    .poll(async () => {
      const state = (await inspect(page))[0]!;
      return state.viewportY === state.baseY;
    })
    .toBe(true);
}

/** Interactivity means keystrokes reach the session, not merely that pixels landed. */
async function expectInteractive(page: Page) {
  const before = inputPayloads(await readCounters(page)).length;
  await page.locator('.xterm-helper-textarea').press('y');
  await expect
    .poll(async () =>
      inputPayloads(await readCounters(page))
        .slice(before)
        .join(''),
    )
    .toBe('y');
}

async function readCounters(page: Page) {
  return JSON.parse((await page.locator('[data-counters]').textContent()) ?? '{}') as Counters;
}

function milestone(counters: Counters, type: string) {
  return counters.milestones.find((event) => event.type === type)!.at;
}

function inputPayloads(counters: Counters) {
  return counters.input
    .map((value) => {
      try {
        const decoded = JSON.parse(value) as { type?: string; data?: string };
        return decoded.type === 'input' ? (decoded.data ?? '') : '';
      } catch {
        return '';
      }
    })
    .filter(Boolean);
}

interface Counters {
  readonly claimAttempts: number;
  readonly terminalsCreated: number;
  readonly terminalsDisposed: number;
  readonly socketsCreated: number;
  readonly socketsOpened: number;
  readonly socketsClosed: number;
  readonly webglCreated: number;
  readonly webglDisposed: number;
  readonly tasksActive: number;
  readonly framesRequested: number;
  readonly framesActive: number;
  readonly resizeObserversActive: number;
  readonly input: string[];
  readonly milestones: Array<{ type: string; at: number }>;
  readonly replayChunksSubmitted: number;
  readonly lastReplayChunkAt: number | null;
  readonly replayEndAt: number | null;
  readonly relocation: {
    readonly measurableFrame: number | null;
    readonly interactiveFrame: number | null;
    readonly measurableAt: number | null;
    readonly interactiveAt: number | null;
    readonly activationFrames: readonly number[];
    readonly renderFrames: readonly number[];
  };
}
