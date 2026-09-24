import { expect, test, type Page } from '@playwright/test';

/**
 * The production inspector over a fake runtime.
 *
 * These are behaviour checks, not prose checks: what is reachable, what is counted, what is fetched
 * and what is never fetched. Literal sentences are asserted only where the sentence *is* the
 * behaviour — telling "Isagi cannot read this" apart from "this was never produced" is the point of
 * those two states existing.
 */

/**
 * Everything is scoped to the surface it belongs to.
 *
 * The scaffolding strip carries a button per scenario, so an unscoped `Pause` matches both the bar's
 * control and the strip's `paused` switch. Scoping is not a workaround here — it is the assertion:
 * the controls live in the bar and the facts live in the dialog, and a locator that cannot tell them
 * apart is not checking that.
 */
const bar = (page: Page) => page.getByRole('region', { name: 'Workflow' });
const inspect = (page: Page) => bar(page).getByRole('button', { name: 'Inspect', exact: true });
const dialog = (page: Page) => page.getByRole('dialog');
const tab = (page: Page, name: 'Declared' | 'Trace') =>
  dialog(page).getByRole('tab', { name, exact: true });
const canvas = (page: Page) => dialog(page).locator('[data-testid="declared-viewport"]');
const traceTree = (page: Page) => dialog(page).getByRole('tree', { name: 'Executions' });
/** The Data column alone — the card beside it repeats some of the same identifiers. */
const dataColumn = (page: Page) => dialog(page).locator('[data-dock-column="Data"]');

/**
 * Scrolls Trace to the first row.
 *
 * The inspector opens on where the run is now, which on a finished run is the last thing that ran,
 * and the list is windowed — so the earliest rows are legitimately not mounted until somebody goes
 * back to them. Reaching them is what a person does; the test does the same.
 */
async function goToTop(page: Page) {
  const tree = traceTree(page);
  await tree.click();
  await page.keyboard.press('Home');
  await expect(tree.locator('[aria-selected="true"]').first()).toBeVisible();
}

async function open(page: Page, scenario?: string) {
  await page.goto('./');
  await expect(bar(page)).toBeVisible();
  if (scenario) await page.locator(`[data-action="scenario-${scenario}"]`).click();
  await inspect(page).click();
  await expect(dialog(page)).toBeVisible();
  // Nothing is asserted until the run's projection has actually landed.
  await expect(dialog(page).getByRole('region', { name: 'Selection details' })).toBeVisible();
}

/** The element's box once it has stopped moving, so a coordinate taken from it is still true. */
async function settledBox(page: Page, locator: ReturnType<Page['locator']>): Promise<string> {
  let last = '';
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const current = JSON.stringify(await locator.boundingBox());
    if (current === last) return current;
    last = current;
    await page.waitForTimeout(100);
  }
  return last;
}

async function requests(page: Page): Promise<readonly string[]> {
  return page.evaluate(() => [...(window.inspectorFixture?.requestPaths() ?? [])]);
}

test('the inspector opens from the bar, closes with Escape, and hands focus back', async ({
  page,
}) => {
  await open(page);
  // Focus moves into the overlay, onto the control a person tabs from.
  await expect(dialog(page).getByRole('button', { name: 'Close inspector' })).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
  await expect(inspect(page)).toBeFocused();
});

test('the bar stays reachable and operable while the inspector is open', async ({ page }) => {
  await open(page, 'waiting_questions');

  // The overlay stops above the bar rather than covering it: the controls a person might need are
  // still on screen and still clickable, which is why this is not a modal.
  const pause = bar(page).getByRole('button', { name: 'Pause', exact: true });
  await expect(pause).toBeVisible();
  await pause.click();

  const paths = await requests(page);
  expect(paths.some((path) => path.includes('/pause'))).toBe(true);
  await expect(dialog(page)).toBeVisible();
});

test('a question is answered in the bar, never in the inspector', async ({ page }) => {
  await open(page, 'waiting_questions');

  // The dock reports the wait as a record and says where to answer it.
  await tab(page, 'Trace').click();
  await page.locator('[data-execution="102"]').click();
  await expect(dialog(page).getByText('the workflow bar')).toBeVisible();

  // And the only form is the bar's own, outside the overlay.
  const forms = await dialog(page).locator('textarea, input[type="text"]').count();
  expect(forms).toBe(0);
  await expect(bar(page).getByRole('textbox').first()).toBeVisible();
});

test('the inspector offers no control that changes the run', async ({ page }) => {
  await open(page, 'callback_failed');
  for (const label of ['Pause', 'Resume', 'Retry', 'Cancel', 'Dismiss', 'Advance', 'Continue']) {
    await expect(dialog(page).getByRole('button', { name: label, exact: true })).toHaveCount(0);
  }
});

test('Declared draws the current pin, and a Retry redraws it without touching history', async ({
  page,
}) => {
  await open(page, 'done');
  await expect(canvas(page).locator('[data-element]').first()).toBeVisible();

  const before = await canvas(page).locator('[data-element]').count();
  // The exact address, not a substring: `after-sign-off` is the edge beside it, and a locator that
  // cannot tell a node from its outgoing edge is not checking which one was added.
  expect(await canvas(page).locator('[data-element="::node:sign-off"]').count()).toBe(0);

  await page.keyboard.press('Escape');
  await page.locator('[data-action="adopt-pin"]').click();
  await inspect(page).click();

  // The node the new definition added is drawn, and it has never run.
  const signOff = canvas(page).locator('[data-element="::node:sign-off"]');
  await expect(signOff).toHaveCount(1);
  await expect(signOff).toHaveAttribute('data-status', 'unvisited');
  await expect
    .poll(async () => canvas(page).locator('[data-element]').count())
    .toBeGreaterThan(before);
});

test('a node removed from the current pin keeps its row in Trace', async ({ page }) => {
  await open(page, 'done');
  await page.keyboard.press('Escape');
  await page.locator('[data-action="adopt-pin"]').click();
  await inspect(page).click();
  await tab(page, 'Trace').click();
  // The inspector opens on where the run got to, so the earliest rows are legitimately outside the
  // mounted window until somebody goes back to them.
  await goToTop(page);

  // `collect` still ran, under the pin that ran it, whatever the current definition says.
  await expect(dialog(page).locator('[data-execution="101"]')).toBeVisible();
});

test('layout runs on shape changes and not on status, timing or operation deltas', async ({
  page,
}) => {
  await open(page, 'blocked_operation');
  await page.waitForTimeout(400);

  type LayoutCounter = { layoutMessages?: number };
  const layouts = () =>
    page.evaluate(() => (window as unknown as LayoutCounter).layoutMessages ?? 0);

  // Count worker traffic directly: a layout is a message to the worker, and a shape that does not
  // change is a message that is never sent.
  await page.evaluate(() => {
    const counter = window as unknown as { layoutMessages: number };
    const original = Worker.prototype.postMessage;
    counter.layoutMessages = 0;
    Worker.prototype.postMessage = function (this: Worker, ...args: unknown[]) {
      counter.layoutMessages += 1;
      return original.apply(this, args as never);
    } as typeof Worker.prototype.postMessage;
  });

  // A settled operation, a clock tick and a selection: three things that change what a node says
  // and move nothing.
  await page.locator('[data-action="settle-operation"]').click();
  await canvas(page).locator('[data-element]').first().click();
  await page.waitForTimeout(1600);
  expect(await layouts()).toBe(0);

  // Opening a subgraph is a shape change, and does lay out again. A graph is opened from its header
  // strip, which is the control that carries the toggle.
  const box = canvas(page).locator('[data-element="::node:first-pass"] [data-node-key]').first();
  await box.dblclick();
  await expect.poll(layouts).toBeGreaterThan(0);
});

test('every operation of a selected visit is read, across pages, and completeness is not implied', async ({
  page,
}) => {
  await page.goto('./');
  await page.locator('[data-action="many-operations"]').click();
  await inspect(page).click();
  await tab(page, 'Trace').click();
  await page.locator('[data-execution="102"]').click();

  // Seven operations at three per page: the dock reads every page rather than stopping at the first.
  await expect(dialog(page).locator('article').first()).toBeVisible();
  await expect.poll(async () => dialog(page).locator('article').count()).toBe(7);

  const paths = await requests(page);
  const operationReads = paths.filter((path) => path.includes('/operations?'));
  expect(operationReads.length).toBeGreaterThanOrEqual(3);
});

test('a failed operations read says so instead of showing a short list as though it were whole', async ({
  page,
}) => {
  await page.goto('./');
  await page.locator('[data-action="fail-operations"]').click();
  await inspect(page).click();
  await tab(page, 'Trace').click();
  await page.locator('[data-execution="102"]').click();

  await expect(dialog(page).getByText("Isagi couldn't read this step's operations.")).toBeVisible();
  await expect(dialog(page).getByRole('button', { name: 'Try again' })).toBeVisible();
});

test('an operation that settles while it is on screen updates in place', async ({ page }) => {
  await open(page, 'blocked_operation');
  await tab(page, 'Trace').click();
  await page.locator('[data-execution="102"]').click();
  await expect(dialog(page).getByText('uncertain').first()).toBeVisible();

  await page.locator('[data-action="settle-operation"]').click();
  await expect.poll(async () => dialog(page).getByText('uncertain').count()).toBe(0);
});

test('a wait and its operations are both shown; neither replaces the other', async ({ page }) => {
  await open(page, 'waiting_questions');
  await tab(page, 'Trace').click();
  await page.locator('[data-execution="102"]').click();

  await expect(dialog(page).getByText('#5').first()).toBeVisible();
  await expect.poll(async () => dialog(page).locator('article').count()).toBeGreaterThan(0);
});

test('a payload Isagi cannot read is distinguishable from one that was never produced', async ({
  page,
}) => {
  await open(page, 'done');
  await tab(page, 'Trace').click();

  // `collect` recorded a state.out whose bytes are gone.
  await goToTop(page);
  await page.locator('[data-execution="101"]').click();
  await dialog(page)
    .getByRole('button', { name: /^state\.out/ })
    .click();
  await dialog(page)
    .getByRole('button', { name: /Show value/ })
    .click();
  await expect(dialog(page).getByText("Recorded, but Isagi can't read it back.")).toBeVisible();
  await expect(dialog(page).getByText(/reports it missing/)).toBeVisible();

  // The second read of the first pass committed nothing at all, which is a different sentence.
  await page.locator('[data-execution="105"]').click();
  await dialog(page)
    .getByRole('button', { name: /^update/ })
    .click();
  await expect(dialog(page).getByText('This step never produced this value.')).toBeVisible();
});

test('nothing fetches a payload until somebody asks to see one', async ({ page }) => {
  await page.goto('./');
  await page.evaluate(() => window.inspectorFixture?.resetRequests());
  await inspect(page).click();
  await tab(page, 'Trace').click();
  await page.locator('[data-execution="101"]').click();

  const paths = await requests(page);
  expect(paths.some((path) => path.includes('/payloads/'))).toBe(false);
});

test('the inspector never asks for an attempt list or a version list', async ({ page }) => {
  await open(page, 'callback_failed');
  await tab(page, 'Trace').click();
  await page.locator('[data-execution="105"]').click();
  await tab(page, 'Declared').click();
  // The viewport is a transform container with absolutely-positioned contents, so it has no box of
  // its own; a drawn node is what proves the graph rendered.
  await canvas(page).locator('[data-element]').first().waitFor();

  const paths = await requests(page);
  expect(paths.some((path) => path.includes('/attempts'))).toBe(false);
  expect(paths.some((path) => path.includes('/versions'))).toBe(false);
});

test('a long history pages in fully and stays reachable from the keyboard', async ({ page }) => {
  await page.goto('./');
  await page.locator('[data-action="long-history"]').click();
  await inspect(page).click();
  await tab(page, 'Trace').click();

  const paths = await requests(page);
  const executionReads = paths.filter((path) => path.includes('/executions?'));
  expect(executionReads.length).toBeGreaterThan(1);

  const tree = traceTree(page);
  await tree.click();
  // The window is a rendering decision, not a reachability one: End reaches the last execution even
  // though it was never mounted.
  await page.keyboard.press('End');
  await expect(tree.locator('[aria-selected="true"]')).toBeVisible();
});

test('nested subgraphs open and close from the keyboard at every depth', async ({ page }) => {
  await open(page, 'done');
  await tab(page, 'Trace').click();
  const tree = traceTree(page);
  await tree.click();
  await page.keyboard.press('Home');

  // Walk down to the subgraph row and collapse it with the keyboard alone.
  for (let index = 0; index < 3; index += 1) await page.keyboard.press('ArrowDown');
  const expandable = tree.locator('[aria-expanded]').first();
  await expect(expandable).toBeVisible();

  const before = await tree.locator('[role="treeitem"]').count();
  await expandable.click();
  await page.keyboard.press('ArrowLeft');
  await expect
    .poll(async () => tree.locator('[role="treeitem"]').count())
    .toBeLessThanOrEqual(before);
});

test('the dock resizes from the keyboard as well as the pointer', async ({ page }) => {
  await open(page, 'done');
  const grip = dialog(page).getByRole('slider', { name: 'Resize details' });
  const before = Number(await grip.getAttribute('aria-valuenow'));
  await grip.focus();
  await page.keyboard.press('ArrowUp');
  await expect
    .poll(async () => Number(await grip.getAttribute('aria-valuenow')))
    .toBeGreaterThan(before);
  // And it is bounded: End takes it to its floor rather than collapsing it away.
  await page.keyboard.press('End');
  await expect.poll(async () => Number(await grip.getAttribute('aria-valuenow'))).toBe(140);
});

test('pan and zoom move the canvas without laying it out again', async ({ page }) => {
  await open(page, 'done');
  const zoomIn = dialog(page).getByRole('button', { name: 'Zoom in' });
  const before = await canvas(page).getAttribute('style');
  await zoomIn.click();
  await expect.poll(async () => canvas(page).getAttribute('style')).not.toBe(before);
});

/** The last execution in the run's order, reached from the keyboard. Windowing cannot hide it. */
async function lastReachableExecution(page: Page): Promise<string | null> {
  const tree = traceTree(page);
  await tree.click();
  await page.keyboard.press('End');
  return tree.locator('[aria-selected="true"]').first().getAttribute('data-execution');
}

test('a reconnect and a duplicate delta both leave the projection coherent', async ({ page }) => {
  await open(page, 'done');
  await tab(page, 'Trace').click();
  const tree = traceTree(page);
  const before = await lastReachableExecution(page);
  expect(before).not.toBeNull();

  await page.locator('[data-action="duplicate-delta"]').click();
  await page.locator('[data-action="reconnect"]').click();

  // The first execution and the last are both still reachable: recovery added facts and lost none.
  await expect.poll(() => lastReachableExecution(page)).toBe(before);
  await goToTop(page);
  await expect(tree.locator('[data-execution="101"]')).toHaveCount(1);
});

test('a paused run draws its pause band from recorded history', async ({ page }) => {
  await open(page, 'paused');
  await tab(page, 'Trace').click();
  // The band is drawn from the recorded pause interval; the header states the pause itself.
  await expect(dialog(page).getByText('paused', { exact: true }).first()).toBeVisible();
});

test('a cancelled run reports its stop honestly rather than claiming a clean stop', async ({
  page,
}) => {
  await open(page, 'cancelled');
  // One capability could not be stopped and one is still outstanding; the header says the latter.
  await expect(dialog(page).getByText(/Still waiting on external work to stop/)).toBeVisible();
});

test('an unavailable environment is stated, and the run keeps its position', async ({ page }) => {
  await open(page, 'blocked_environment');
  await expect(dialog(page).getByText(/worktree isn.t available/)).toBeVisible();
  await expect(dialog(page).getByText(/surface release · unavailable/)).toBeVisible();
});

test('every scenario opens, draws and selects without error', async ({ page }) => {
  const scenarios = [
    'ready',
    'running',
    'waiting_agent',
    'waiting_questions',
    'waiting_continue',
    'paused',
    'blocked_operation',
    'blocked_environment',
    'callback_failed',
    'routing_failed',
    'done',
    'authored_failure',
    'cancelled',
  ];
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto('./');
  await inspect(page).click();
  for (const scenario of scenarios) {
    await page.locator(`[data-action="scenario-${scenario}"]`).click();
    await expect(dialog(page)).toBeVisible();
    await expect(
      dialog(page).locator('[data-testid="declared-viewport"] [data-element]').first(),
    ).toBeVisible();
    await tab(page, 'Trace').click();
    await tab(page, 'Declared').click();
  }
  expect(errors).toEqual([]);
});

test('reduced motion is respected and the elapsed time still moves', async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await context.newPage();
  await open(page, 'running');
  const facts = dialog(page).locator('header p').first();
  const before = await facts.textContent();
  // Elapsed time is information, not animation: it keeps counting.
  await expect.poll(async () => facts.textContent(), { timeout: 4000 }).not.toBe(before);
  await context.close();
});

/* ── frame lifecycle, keyboard, layout protocol and depth ──────────────────────────────────── */

test('a run whose graph setup threw shows its frame rather than "nothing has run yet"', async ({
  page,
}) => {
  await open(page, 'root_init_failed');
  await tab(page, 'Trace').click();

  await expect(dialog(page).getByText('Nothing has run yet.')).toHaveCount(0);
  await goToTop(page);
  const frameRow = dialog(page).locator('[data-frame="1"]');
  await expect(frameRow).toBeVisible();

  // The entry marker is the only way to reach a segment that never had a node execution.
  await frameRow.locator('[data-marker="entry"]').click();
  const details = dialog(page).getByRole('region', { name: 'Selection details' });
  await expect(details).toContainText("This workflow's setup code threw.");
  await expect(details).toContainText('graph_init_failed');
  await expect(details).toContainText('graph entry');
});

test("the root frame's published output is selectable from its lifecycle row", async ({ page }) => {
  await open(page, 'done');
  await tab(page, 'Trace').click();
  await goToTop(page);
  const output = dialog(page).locator('[data-frame="1"] [data-marker="output"]');
  await expect(output).toBeVisible();
  await output.click();
  // The dock describes the frame's output, addressed by the frame and not by an invented execution.
  await expect(dialog(page).getByText('shipped').first()).toBeVisible();
  await expect(dialog(page).getByRole('region', { name: 'Selection details' })).toContainText(
    'outcome',
  );
});

test('Declared is navigable and expandable from the keyboard, four levels down', async ({
  page,
}) => {
  await open(page, 'done');
  const viewport = canvas(page);
  await viewport.locator('[data-element]').first().waitFor();

  // One tab stop for the whole graph: arrows move within it rather than Tab walking every node.
  const stops = await viewport.locator('[data-node-key][tabindex="0"]').count();
  expect(stops).toBe(1);

  await viewport.locator('[data-node-key][tabindex="0"]').focus();
  const focusedKey = async () =>
    page.evaluate(() => document.activeElement?.getAttribute('data-node-key') ?? null);
  const first = await focusedKey();
  await page.keyboard.press('ArrowDown');
  await expect.poll(focusedKey).not.toBe(first);

  // Walk to the first subgraph and open it with Space, then keep going into its contents.
  for (let index = 0; index < 12; index += 1) {
    const key = await focusedKey();
    if (key !== null && key.endsWith('::node:first-pass')) break;
    await page.keyboard.press('ArrowDown');
  }
  expect(await focusedKey()).toBe('::node:first-pass');
  await page.keyboard.press(' ');
  await expect(viewport.locator('[data-element="first-pass::node:read"]')).toHaveCount(1);

  // Four levels: release → review → rules → lint, each opened from the keyboard alone. Expansion is
  // a relayout, so each level has to be drawn before the next one can be walked to.
  for (const [path, node, proof] of [
    ['first-pass', 'deep-check', 'first-pass/deep-check::node:scan'],
    ['first-pass/deep-check', 'lint-pass', 'first-pass/deep-check/lint-pass::node:rules-run'],
  ] as const) {
    for (let index = 0; index < 24; index += 1) {
      if ((await focusedKey()) === `${path}::node:${node}`) break;
      await page.keyboard.press('ArrowDown');
    }
    expect(await focusedKey()).toBe(`${path}::node:${node}`);
    await page.keyboard.press(' ');
    await expect(viewport.locator(`[data-element="${proof}"]`)).toHaveCount(1);
  }
});

test('collapsing a graph returns focus to the subgraph node rather than to the top', async ({
  page,
}) => {
  await open(page, 'done');
  const viewport = canvas(page);
  await viewport.locator('[data-element]').first().waitFor();

  const focusedKey = async () =>
    page.evaluate(() => document.activeElement?.getAttribute('data-node-key') ?? null);
  const box = () => viewport.locator('[data-element="::node:first-pass"] [data-node-key]');

  await box().focus();
  await page.keyboard.press(' ');
  await expect(viewport.locator('[data-element="first-pass::node:read"]')).toHaveCount(1);

  // Move inside the graph, then collapse it from its own header.
  await page.keyboard.press('ArrowDown');
  await expect.poll(focusedKey).toBe('first-pass::node:read');

  await box().focus();
  await page.keyboard.press(' ');
  await expect(viewport.locator('[data-element="first-pass::node:read"]')).toHaveCount(0);
  // Focus is where the person was, not back at the top of the graph.
  await expect.poll(focusedKey).toBe('::node:first-pass');
});

test('a graph name stays pinned once its header has panned off the top', async ({ page }) => {
  await open(page, 'done');
  const viewport = canvas(page);
  await viewport.locator('[data-element]').first().waitFor();
  await viewport.locator('[data-element="::node:first-pass"] [data-node-key]').dblclick();
  await expect(viewport.locator('[data-element="first-pass::node:read"]')).toHaveCount(1);

  await expect(dialog(page).locator('[data-pinned-graph]')).toHaveCount(0);

  // Pan the box's header above the visible region; its name has to survive. Zooming in first makes
  // the box tall enough that panning past its header still leaves its body on screen.
  await dialog(page).getByRole('button', { name: 'Zoom in' }).click();
  await dialog(page).getByRole('button', { name: 'Zoom in' }).click();
  const box = await viewport.locator('[data-element="::node:first-pass"]').boundingBox();
  const region = await dialog(page).locator('[data-testid="declared-canvas"]').boundingBox();
  expect(box && region).toBeTruthy();

  // Dragging starts on empty canvas — a pointer-down on a node is a selection, not a pan — and the
  // box is panned far enough that its header leaves while its body stays.
  const from = { x: region!.x + 12, y: region!.y + region!.height - 12 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x, from.y - (box!.y - region!.y) - box!.height * 0.75, { steps: 12 });
  await page.mouse.up();

  await expect(dialog(page).locator('[data-pinned-graph="::node:first-pass"]')).toBeVisible();
  // It is a way back to the graph, not just a label.
  await dialog(page).locator('[data-pinned-graph="::node:first-pass"]').click();
  await expect(dialog(page).getByRole('region', { name: 'Selection details' })).toContainText(
    'first-pass',
  );
});

test('a layout answer that is no longer the shape being asked about cannot commit', async ({
  page,
}) => {
  await open(page, 'done');
  const viewport = canvas(page);
  await viewport.locator('[data-element]').first().waitFor();

  await page.locator('[data-action="hold-layout"]').click();
  // Two shapes in flight: open a box, then close it again.
  await viewport.locator('[data-element="::node:first-pass"] [data-node-key]').dblclick();
  await viewport.locator('[data-element="::node:first-pass"] [data-node-key]').dblclick();
  await page.locator('[data-action="release-layout-newest-first"]').click();

  // The newest shape is the collapsed one, and the older answer must not reinstate the open box.
  await expect(viewport.locator('[data-element="first-pass::node:read"]')).toHaveCount(0);
  await expect(viewport.locator('[data-element="::node:first-pass"]')).toHaveCount(1);
});

test('a first layout failure is stated, and a later shape recovers', async ({ page }) => {
  // Opened once so the run's projection is already hydrated and the shape is settled; otherwise a
  // node crossing the pip threshold is a real shape change and the relayout legitimately recovers.
  await open(page, 'done');
  await canvas(page).locator('[data-element]').first().waitFor();
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);

  await page.locator('[data-action="fail-layout"]').click();
  await inspect(page).click();

  await expect(dialog(page).getByText("Isagi couldn't lay this graph out.")).toBeVisible();
  // Never an empty canvas: that would read as a workflow with no nodes in it.
  await expect(canvas(page).locator('[data-element]')).toHaveCount(0);

  // A later *shape* recovers. Changing scenario is not one — the definition is the same graph — so
  // this adopts a new pin, which is the thing that actually changes what has to be drawn.
  await page.locator('[data-action="adopt-pin"]').click();
  await expect(canvas(page).locator('[data-element]').first()).toBeVisible();
  await expect(dialog(page).getByText("Isagi couldn't lay this graph out.")).toHaveCount(0);
});

test('a redraw that failed says so instead of silently keeping the previous shape', async ({
  page,
}) => {
  await open(page, 'done');
  const viewport = canvas(page);
  await viewport.locator('[data-element]').first().waitFor();

  await page.locator('[data-action="fail-layout"]').click();
  await viewport.locator('[data-element="::node:first-pass"] [data-node-key]').dblclick();

  // The box did not open, and the canvas says why rather than showing a shape nobody asked for.
  await expect(viewport.locator('[data-element="first-pass::node:read"]')).toHaveCount(0);
  await expect(
    dialog(page).getByText(
      "Isagi couldn't redraw this graph, so it still shows the previous shape.",
    ),
  ).toBeVisible();
});

test('closing the inspector disposes its layout engine', async ({ page }) => {
  await open(page, 'done');
  await canvas(page).locator('[data-element]').first().waitFor();
  const disposals = () => page.evaluate(() => window.inspectorEngine?.disposals() ?? 0);
  expect(await disposals()).toBe(0);

  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
  await expect.poll(disposals).toBeGreaterThan(0);
});

test('a skipped revision is recovered through the API before later facts are applied', async ({
  page,
}) => {
  await open(page, 'done');
  await tab(page, 'Trace').click();
  const tree = traceTree(page);
  const before = await lastReachableExecution(page);
  await page.evaluate(() => window.inspectorFixture?.resetRequests());

  await page.locator('[data-action="skip-revision"]').click();

  // A delta that is not exactly one past coverage is a gap, and a gap is filled by reading.
  await expect
    .poll(async () => (await requests(page)).filter((path) => path.includes('/executions?')).length)
    .toBeGreaterThan(0);

  // Duplicate and reordered delivery after the fill must not regress what is on screen.
  await page.locator('[data-action="duplicate-delta"]').click();
  await page.locator('[data-action="settle-operation"]').click();
  await expect.poll(() => lastReachableExecution(page)).toBe(before);
  await goToTop(page);
  await expect(tree.locator('[data-execution="101"]')).toHaveCount(1);
});

test('every execution at four levels deep is reachable in Trace', async ({ page }) => {
  await open(page, 'done');
  await tab(page, 'Trace').click();
  const tree = traceTree(page);
  await goToTop(page);
  // release → review → rules → lint, so the deepest visit sits at aria-level 4. Walking to it with
  // the keyboard is also what proves a windowed row is still reachable.
  for (let index = 0; index < 20; index += 1) {
    if ((await tree.locator('[role="treeitem"][aria-level="4"]').count()) > 0) break;
    await page.keyboard.press('ArrowDown');
  }
  await expect(tree.locator('[role="treeitem"][aria-level="4"]').first()).toBeVisible();
});

/* ── operation payloads, child navigation and the dock's own geometry ──────────────────────── */

test("an operation's request, receipt and result are openable, and a recorded null is a value", async ({
  page,
}) => {
  await open(page, 'waiting_questions');
  await tab(page, 'Trace').click();
  await goToTop(page);
  await page.locator('[data-execution="102"]').click();
  await expect(dialog(page).locator('article').first()).toBeVisible();

  // A tab's accessible name carries its size badge, so it is matched by prefix, not exactly. The
  // card's own `request` row opens the same tab; the tab is asserted here because it is what a
  // person reads the value in.
  await dialog(page)
    .getByRole('button', { name: /^op1\.request/ })
    .click();
  await dialog(page)
    .getByRole('button', { name: /Show value/ })
    .click();
  await expect(dialog(page).getByText(/unbounded queries/)).toBeVisible();

  // A receipt is a recorded value, not only a status.
  await dialog(page)
    .getByRole('button', { name: /^op1\.receipt/ })
    .click();
  // Scoped to Data: the card beside it names the same turn as the operation's raw target, and an
  // unscoped match would pass without the payload ever being shown.
  await expect(dataColumn(page).getByText('t-88')).toBeVisible();

  // The second call produced JSON `null`: still a value, still selectable.
  await dialog(page)
    .getByRole('button', { name: /^op2\.result/ })
    .click();
  await expect(dataColumn(page).getByText('null', { exact: true }).first()).toBeVisible();
});

test('an operation payload the store cannot read uses the unavailable treatment', async ({
  page,
}) => {
  await page.goto('./');
  // Seven calls on the triage visit, one of whose requests the payload store cannot serve.
  await page.locator('[data-action="many-operations"]').click();
  await inspect(page).click();
  await tab(page, 'Trace').click();
  await goToTop(page);
  await page.locator('[data-execution="102"]').click();

  await dialog(page)
    .getByRole('button', { name: /^op3\.request/ })
    .click();
  await dialog(page)
    .getByRole('button', { name: /Show value/ })
    .click();
  await expect(dialog(page).getByText("Recorded, but Isagi can't read it back.")).toBeVisible();
  await expect(dialog(page).getByText(/reports it missing/)).toBeVisible();
});

test('opening one operation payload does not fetch the others', async ({ page }) => {
  await open(page, 'waiting_questions');
  await tab(page, 'Trace').click();
  await goToTop(page);
  await page.locator('[data-execution="102"]').click();
  await expect(dialog(page).locator('article').first()).toBeVisible();
  await page.evaluate(() => window.inspectorFixture?.resetRequests());

  await dialog(page)
    .getByRole('button', { name: /^op1\.request/ })
    .click();
  await dialog(page)
    .getByRole('button', { name: /Show value/ })
    .click();
  await expect(dialog(page).getByText(/unbounded queries/)).toBeVisible();

  // Exactly one payload read: tabs show a size from the record, and fetch only when asked.
  const reads = (await requests(page)).filter((path) => path.includes('/payloads/'));
  expect(reads.length).toBe(1);
});

test("a subgraph's child executions are reachable from the dock, one level at a time", async ({
  page,
}) => {
  await open(page, 'done');
  await tab(page, 'Trace').click();
  await goToTop(page);
  await page.locator('[data-execution="103"]').click();

  // The direct children of the review frame, and not its grandchildren.
  const children = dialog(page).getByRole('list', { name: 'Executions inside this subgraph' });
  await expect(children.locator('[data-child-execution]')).toHaveCount(3);
  await expect(children.locator('[data-child-execution="106"]')).toBeVisible();
  // `scan` and `lint-pass` belong to the rules frame one level further in, and are not listed here.
  await expect(children.locator('[data-child-execution="107"]')).toHaveCount(0);

  // Selecting the nested subgraph opens its own list: depth is walked, never flattened.
  await children.locator('[data-child-execution="106"]').click();
  await expect(dialog(page).getByRole('region', { name: 'Selection details' })).toContainText(
    'deep-check',
  );
  await expect(children.locator('[data-child-execution="107"]')).toBeVisible();

  // And it is a keyboard target like any other.
  await children.locator('[data-child-execution="107"]').focus();
  await page.keyboard.press('Enter');
  await expect(dialog(page).getByRole('region', { name: 'Selection details' })).toContainText(
    'scan',
  );
});

test('a subgraph that has not opened its graph says so', async ({ page }) => {
  await open(page, 'ready');
  await tab(page, 'Trace').click();
  await goToTop(page);
  await page.locator('[data-execution="103"]').click();
  // The fixture's `ready` run has entered this subgraph, so this asserts the opposite branch is
  // reachable only when it is true; the honest sentence is checked in the unit tests.
  await expect(dialog(page).getByRole('region', { name: 'Selection details' })).toBeVisible();
});

test('the dock stays five dense columns and scrolls rather than reflowing', async ({ page }) => {
  // Narrow enough that a responsive layout would be tempted to stack. Behaviour is asserted, not
  // pixels: the columns keep their dense widths and the dock scrolls to reach them.
  await page.setViewportSize({ width: 900, height: 800 });
  await open(page, 'waiting_questions');
  await tab(page, 'Trace').click();
  await goToTop(page);
  await page.locator('[data-execution="102"]').click();

  const details = dialog(page).getByRole('region', { name: 'Selection details' });
  const strip = details.locator('[data-testid="dock-columns"]');
  // Five since captured evidence gained a column of its own, between Operations and Data.
  await expect(details.locator('[data-dock-column]')).toHaveCount(5);

  // Overflow rather than reflow: the columns are wider than the dock, and it scrolls horizontally.
  const overflow = await strip.evaluate((node) => ({
    scrollWidth: node.scrollWidth,
    clientWidth: node.clientWidth,
  }));
  expect(overflow.scrollWidth).toBeGreaterThan(overflow.clientWidth);

  // Nothing is clipped out of reach: the last column is reachable and usable once scrolled to.
  const data = details.locator('[data-dock-column="Data"]');
  await data.scrollIntoViewIfNeeded();
  await expect(data).toBeInViewport();
  await dialog(page)
    .getByRole('button', { name: /^op1\.request/ })
    .click();
  await expect(dialog(page).getByRole('button', { name: /Show value/ })).toBeVisible();

  // A content-heavy column scrolls inside the bounded dock rather than growing it.
  const recorded = details.locator('[data-dock-column="Recorded"] [data-dock-column-scroll]');
  const vertical = await recorded.evaluate((node) => ({
    scrollHeight: node.scrollHeight,
    clientHeight: node.clientHeight,
  }));
  expect(vertical.scrollHeight).toBeGreaterThan(vertical.clientHeight);

  // Focus survives having scrolled in both directions.
  const firstTab = dialog(page).getByRole('button', { name: /^state\.in/ });
  await firstTab.focus();
  await expect(firstTab).toBeFocused();

  // Both resize bounds keep every column reachable.
  const grip = details.getByRole('slider', { name: 'Resize details' });
  await grip.focus();
  await page.keyboard.press('End');
  // Five since captured evidence gained a column of its own, between Operations and Data.
  await expect(details.locator('[data-dock-column]')).toHaveCount(5);
  await expect(details.locator('[data-dock-column="Data"]')).toBeVisible();
  await page.keyboard.press('Home');
  // Five since captured evidence gained a column of its own, between Operations and Data.
  await expect(details.locator('[data-dock-column]')).toHaveCount(5);
  await expect(grip).toBeFocused();
});

test('a layout engine that cannot be constructed is reported, not waited on forever', async ({
  page,
}) => {
  await page.goto('./');
  await page.locator('[data-action="fail-engine"]').click();
  await inspect(page).click();

  // There is no request to attach this failure to — the engine never existed — so it has to be
  // reported on its own terms rather than filed against a shape and lost.
  await expect(dialog(page).getByText("Isagi couldn't lay this graph out.")).toBeVisible();
  await expect(dialog(page).getByText('Laying out the graph…')).toHaveCount(0);
  await expect(canvas(page).locator('[data-element]')).toHaveCount(0);
});

test('a pin that renames nothing still redraws the graph', async ({ page }) => {
  await open(page, 'done');
  await expect(canvas(page).locator('[data-element]').first()).toBeVisible();

  // `after-second` keeps its id across the two pins and changes where it can go. A layout identity
  // summarising element keys would have been identical, and the old geometry would have stayed.
  const before = await canvas(page)
    .locator('[data-element="::edge:after-second"]')
    .evaluate((node) => node.getBoundingClientRect().x);

  await page.keyboard.press('Escape');
  await page.locator('[data-action="adopt-pin"]').click();
  await inspect(page).click();
  await expect(canvas(page).locator('[data-element="::node:sign-off"]')).toHaveCount(1);

  await expect
    .poll(async () =>
      canvas(page)
        .locator('[data-element="::edge:after-second"]')
        .evaluate((node) => node.getBoundingClientRect().x),
    )
    .not.toBe(before);
});

test('a restart-interrupted visit reports an unknown end rather than a growing duration', async ({
  page,
}) => {
  await open(page, 'interrupted');
  await tab(page, 'Trace').click();
  await goToTop(page);
  await page.locator('[data-execution="102"]').click();

  const details = dialog(page).getByRole('region', { name: 'Selection details' });
  await expect(details).toContainText("unknown — the attempt's owner was interrupted");
  // The callback has no honest duration, so it claims none — and certainly not one that grows.
  await expect(details).not.toContainText('so far');

  const badge = canvas(page);
  await tab(page, 'Declared').click();
  await expect(badge.locator('[data-element="::node:triage"]')).not.toContainText('open');
});

test('a pin adopted while the inspector is open redraws it, executions unchanged', async ({
  page,
}) => {
  await open(page, 'done');
  const viewport = canvas(page);
  await expect(viewport.locator('[data-element]').first()).toBeVisible();
  await expect(viewport.locator('[data-element="::node:sign-off"]')).toHaveCount(0);

  const takenBefore = await viewport.locator('path:not([stroke-dasharray])').count();
  expect(takenBefore).toBeGreaterThan(0);

  // Delivered as a committed transition carrying no execution rows, with nothing unmounted — the
  // path the earlier pin test missed because it closed and reopened the inspector around adoption.
  await page.locator('[data-action="adopt-pin-live"]').click();

  await expect(viewport.locator('[data-element="::node:sign-off"]')).toHaveCount(1);
  await expect(viewport.locator('[data-element="::node:sign-off"]')).toHaveAttribute(
    'data-status',
    'unvisited',
  );
  // The edge overlay is rebuilt against the pin now on screen rather than carried over: edges the
  // run actually took are still drawn as taken.
  await expect
    .poll(async () => viewport.locator('path:not([stroke-dasharray])').count())
    .toBeGreaterThan(0);
});

test('a graph opens and closes from anywhere on its card, not just its header strip', async ({
  page,
}) => {
  await open(page, 'done');
  const viewport = canvas(page);
  const box = viewport.locator('[data-element="::node:first-pass"]');
  await expect(box).toBeVisible();

  // The body below the header strip — the part that used to do nothing.
  const card = (await box.boundingBox())!;
  const body = { x: card.x + card.width / 2, y: card.y + card.height - 12 };

  await page.mouse.dblclick(body.x, body.y);
  await expect(viewport.locator('[data-element="first-pass::node:read"]')).toHaveCount(1);

  // And closes the same way: an open graph's own surface is the same target, so the gesture that
  // opened it is the gesture that shuts it. Opening refits the canvas, so the card has moved —
  // its position is read again rather than reused.
  await expect
    .poll(async () => JSON.stringify(await box.boundingBox()))
    .toBe(await settledBox(page, box));
  const opened = (await box.boundingBox())!;
  // The strip along the bottom edge, inside the graph's padding and below every child in it.
  await page.mouse.dblclick(opened.x + opened.width / 2, opened.y + opened.height - 8);
  await expect(viewport.locator('[data-element="first-pass::node:read"]')).toHaveCount(0);
});

test('double-clicking a visit pip selects that visit without opening its graph', async ({
  page,
}) => {
  await open(page, 'done');
  const viewport = canvas(page);
  // `read` is visited twice, so it carries pips; open its graph to reach them.
  await viewport.locator('[data-element="::node:first-pass"] [data-node-key]').dblclick();
  const read = viewport.locator('[data-element="first-pass::node:read"]');
  await expect(read).toBeVisible();

  const pip = read.getByRole('button', { name: /^Visit 2/ });
  await expect(pip).toBeVisible();
  await pip.dblclick();

  // The pip is its own target: the visit is selected and the graph around it did not move.
  await expect(dialog(page).getByRole('region', { name: 'Selection details' })).toContainText(
    'visit 2',
  );
  await expect(viewport.locator('[data-element="first-pass::node:read"]')).toHaveCount(1);
});
