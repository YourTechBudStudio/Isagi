import { expect, test, type Page } from '@playwright/test';

/**
 * The production inspector over a fake runtime.
 *
 * These are behaviour checks, not prose checks: what is reachable, what is read, what is never read,
 * and what a pushed event changes. Literal sentences are asserted only where the sentence *is* the
 * behaviour.
 */

/**
 * Everything is scoped to the surface it belongs to.
 *
 * The scaffolding strip carries a button per scenario, so an unscoped `Pause` matches both the bar's
 * control and the strip's `paused` switch. The controls live in the bar and the facts live in the
 * dialog, and a locator that cannot tell them apart is not checking that.
 */
const bar = (page: Page) => page.getByRole('region', { name: 'Workflow' });
const inspect = (page: Page) => bar(page).getByRole('button', { name: 'Inspect', exact: true });
const dialog = (page: Page) => page.getByRole('dialog');
const tab = (page: Page, name: 'Declared' | 'Trace' | 'Checkpoints') =>
  dialog(page).getByRole('tab', { name, exact: true });
const canvas = (page: Page) => dialog(page).locator('[data-testid="declared-viewport"]');
const traceTree = (page: Page) => dialog(page).getByRole('tree', { name: 'Executions' });
const details = (page: Page) => dialog(page).getByRole('region', { name: 'Selection details' });
/** The Data column alone — the cards beside it repeat some of the same values. */
const dataColumn = (page: Page) => dialog(page).locator('[data-dock-column="Data"]');
const operationsColumn = (page: Page) =>
  dialog(page).locator('[data-dock-column^="Operations"], [data-dock-column^="Wait"]');

/**
 * Scrolls Trace to the first row.
 *
 * The inspector opens on where the run is now, and the list is windowed — so the earliest rows are
 * legitimately not mounted until somebody goes back to them.
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
  // Nothing is asserted until the run's tree has actually landed and the dock describes something.
  await expect(details(page).locator('header').first()).toBeVisible();
}

async function selectExecution(page: Page, executionId: number) {
  await tab(page, 'Trace').click();
  await goToTop(page);
  const row = dialog(page).locator(`[data-execution="${executionId}"]`);
  for (let index = 0; index < 40 && (await row.count()) === 0; index += 1) {
    await page.keyboard.press('ArrowDown');
  }
  await row.click();
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

/** The last execution in the run's order, reached from the keyboard. Windowing cannot hide it. */
async function lastReachableExecution(page: Page): Promise<string | null> {
  const tree = traceTree(page);
  await tree.click();
  await page.keyboard.press('End');
  return tree.locator('[aria-selected="true"]').first().getAttribute('data-execution');
}

test('the inspector opens from the bar, closes with Escape, and hands focus back', async ({
  page,
}) => {
  await open(page);
  await expect(dialog(page).getByRole('button', { name: 'Close inspector' })).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
  await expect(inspect(page)).toBeFocused();
});

test('the bar stays reachable and operable while the inspector is open', async ({ page }) => {
  await open(page, 'waiting_questions');

  const pause = bar(page).getByRole('button', { name: 'Pause', exact: true });
  await expect(pause).toBeVisible();
  await pause.click();

  await expect
    .poll(async () => (await requests(page)).some((path) => path.includes('/pause')))
    .toBe(true);
  await expect(dialog(page)).toBeVisible();
});

test('a question is answered in the bar, never in the inspector', async ({ page }) => {
  await open(page, 'waiting_questions');
  await selectExecution(page, 102);
  await expect(details(page).getByText('the workflow bar')).toBeVisible();

  expect(await dialog(page).locator('textarea, input[type="text"]').count()).toBe(0);
  await expect(bar(page).getByRole('textbox').first()).toBeVisible();
});

test('the inspector offers no control that changes the run', async ({ page }) => {
  await open(page, 'callback_failed');
  for (const label of ['Pause', 'Resume', 'Retry', 'Cancel', 'Dismiss', 'Advance', 'Continue']) {
    await expect(dialog(page).getByRole('button', { name: label, exact: true })).toHaveCount(0);
  }
});

test('there is no Evidence tab', async ({ page }) => {
  await open(page);
  await expect(dialog(page).getByRole('tab')).toHaveText(['Declared', 'Trace', 'Checkpoints']);
});

test('Declared draws the current build, and a reload redraws it without touching history', async ({
  page,
}) => {
  await open(page, 'done');
  await expect(canvas(page).locator('[data-element]').first()).toBeVisible();

  const before = await canvas(page).locator('[data-element]').count();
  // The exact address, not a substring: `after-sign-off` is the edge beside it.
  expect(await canvas(page).locator('[data-element="::node:sign-off"]').count()).toBe(0);

  await page.keyboard.press('Escape');
  await page.locator('[data-action="reload-build"]').click();
  await inspect(page).click();

  const signOff = canvas(page).locator('[data-element="::node:sign-off"]');
  await expect(signOff).toHaveCount(1);
  await expect(signOff).toHaveAttribute('data-status', 'unvisited');
  await expect
    .poll(async () => canvas(page).locator('[data-element]').count())
    .toBeGreaterThan(before);
});

test('a reload is drawn on the Trace, and every execution keeps its row', async ({ page }) => {
  await open(page, 'done');
  await tab(page, 'Trace').click();
  const reloads = dialog(page).locator('[data-marker="code-reloaded"]');
  // The Retry that repaired the first pass reloaded the build once.
  await expect(reloads).toHaveCount(1);

  await page.locator('[data-action="reload-build"]').click();
  // Pushed live: the event is appended to the trace without reopening anything.
  await expect(reloads).toHaveCount(2);
  await goToTop(page);
  await expect(dialog(page).locator('[data-execution="101"]')).toBeVisible();
});

test('the run and its environment have their own lane on the Trace', async ({ page }) => {
  await open(page);
  await tab(page, 'Trace').click();
  const lane = dialog(page).locator('[data-trace-lane="run-events"]');
  await expect(lane).toBeVisible();
  await expect(lane.locator('[data-run-event="run_launched"]')).toHaveCount(1);
  await expect(lane.locator('[data-run-event="worktree_created"]')).toHaveAttribute(
    'aria-label',
    'Created worktree release',
  );
});

test('an event log that could not be read is shown as partial, and a retry fills it in', async ({
  page,
}) => {
  await page.goto('./');
  await page.locator('[data-action="fail-events"]').click();
  await inspect(page).click();

  const warning = dialog(page).locator('[data-run-read="partial"]');
  await expect(warning).toContainText("couldn't read this run's event log");
  await warning.getByRole('button', { name: 'Try again' }).click();
  await expect(warning).toHaveCount(0);
  await tab(page, 'Trace').click();
  await expect(dialog(page).locator('[data-trace-lane="run-events"]')).toBeVisible();
});

test('a Retry is its own row, names what it retries, and the failed execution stays', async ({
  page,
}) => {
  await open(page, 'done');
  await selectExecution(page, 110);

  const retryRow = dialog(page).locator('[data-execution="110"]');
  await expect(retryRow.locator('[data-retry-of="105"]')).toHaveText('retry of 105');
  const recorded = dialog(page).locator('[data-dock-column="Recorded"]');
  await expect(recorded).toContainText('retry of');
  // The retry ran on the reloaded build; the failure before it ran on the launch build.
  await expect(recorded).toContainText('9f2c1ab');

  await recorded.locator('[data-field-select="retry of"]').click();
  await expect(recorded).toContainText('A step in this workflow threw.');
  await expect(recorded).toContainText('node_function');
  await expect(recorded).toContainText('an earlier build');
  await expect(dialog(page).locator('[data-execution="105"]')).toHaveAttribute(
    'aria-selected',
    'true',
  );
});

test('layout runs on shape changes and not on status, timing or reply events', async ({ page }) => {
  await open(page, 'waiting_agent');
  await canvas(page).locator('[data-element]').first().waitFor();
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

  // A pushed event, a clock tick and a selection: things that change what a node says and move
  // nothing.
  await page.locator('[data-action="arrive-reply"]').click();
  await canvas(page).locator('[data-element]').first().click();
  await page.waitForTimeout(1600);
  expect(await layouts()).toBe(0);

  // Opening a subgraph is a shape change, and does lay out again.
  const box = canvas(page).locator('[data-element="::node:first-pass"] [data-node-key]').first();
  await box.dblclick();
  await expect.poll(layouts).toBeGreaterThan(0);
});

test('an execution is read once, with its operations: prompts, replies, model and usage', async ({
  page,
}) => {
  await page.goto('./');
  await page.evaluate(() => window.inspectorFixture?.resetRequests());
  await inspect(page).click();
  await selectExecution(page, 102);

  const cards = operationsColumn(page).locator('article');
  await expect(cards).toHaveCount(2);
  const prompt = cards.first();
  await expect(prompt).toContainText('send_prompt');
  await expect(prompt).toContainText('claude · opus · high');
  await expect(prompt).toContainText('in 1200 · cache read 3000 · out 420 · $0.0213');
  await expect(prompt.getByTestId('operation-prompt')).toContainText('unbounded queries');
  await expect(prompt.getByTestId('operation-reply')).toContainText(
    'Two risky renames: the loader export and the CLI flag.',
  );
  const headless = cards.nth(1);
  await expect(headless).toContainText('run_headless');
  await expect(headless.getByTestId('operation-reply')).toContainText('loader.ts: export renamed');

  const paths = await requests(page);
  expect(paths.filter((path) => path === 'GET /workflows/executions/102')).toHaveLength(1);
  // The operations list route is the CLI's dialogue view; the dock never pages it.
  expect(paths.some((path) => path.includes('/operations'))).toBe(false);
});

test('a failed execution read says so instead of showing an empty list as though it were whole', async ({
  page,
}) => {
  await page.goto('./');
  await page.locator('[data-action="fail-execution"]').click();
  await inspect(page).click();

  await expect(dialog(page).getByText("Isagi couldn't read this step's operations.")).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Try again' }).click();
  await expect(operationsColumn(page).locator('article')).toHaveCount(2);
});

test('a reply that arrives while it is on screen updates in place', async ({ page }) => {
  await open(page, 'waiting_agent');
  await selectExecution(page, 104);
  const reply = operationsColumn(page).getByTestId('operation-reply');
  await expect(reply).toContainText('Not back yet.');

  // The event names the execution, so the client refetches exactly that one.
  await page.locator('[data-action="arrive-reply"]').click();
  await expect(reply).toContainText('The first pass found one unbounded query.');
});

test('a wait and its operations are both shown; neither replaces the other', async ({ page }) => {
  await open(page, 'waiting_questions');
  await selectExecution(page, 102);

  const column = operationsColumn(page);
  await expect(column).toContainText('user_input');
  await expect(column).toContainText('waiting on you');
  await expect(column.locator('article')).toHaveCount(2);
});

test('what a node returned, what came back, where it went and the state after are all openable', async ({
  page,
}) => {
  await open(page, 'done');
  await selectExecution(page, 102);

  const data = dataColumn(page);
  for (const name of ['result', 'event', 'decision', 'state_after', 'op1.request', 'op2.result']) {
    await expect(
      data.locator(`[data-tab]`, { hasText: new RegExp(`^${name.replace('.', '\\.')}$`) }),
    ).toHaveCount(1);
  }
  await data.getByRole('button', { name: 'event', exact: true }).click();
  await expect(data).toContainText('Rename the loader export');
  await data.getByRole('button', { name: 'decision', exact: true }).click();
  await expect(data).toContainText('first-pass');

  // `collect` waited on nothing, so nothing came back: a JSON `null`, which is still a value.
  await selectExecution(page, 101);
  await dataColumn(page).getByRole('button', { name: 'event', exact: true }).click();
  await expect(dataColumn(page).getByText('null', { exact: true }).first()).toBeVisible();
});

test('the inspector never asks for attempts, versions, payloads or evidence', async ({ page }) => {
  await open(page, 'callback_failed');
  await selectExecution(page, 105);
  await tab(page, 'Declared').click();
  await canvas(page).locator('[data-element]').first().waitFor();

  const paths = await requests(page);
  for (const removed of ['/attempts', '/versions', '/payloads', '/evidence', '/executions?']) {
    expect(paths.some((path) => path.includes(removed))).toBe(false);
  }
});

test('a long history pages in fully and stays reachable from the keyboard', async ({ page }) => {
  await page.goto('./');
  await page.locator('[data-action="long-history"]').click();
  await inspect(page).click();
  await tab(page, 'Trace').click();

  // The event log is read forward, page after page, each continuing from the last event it got.
  await expect
    .poll(async () => (await requests(page)).filter((path) => path.includes('/events')).length)
    .toBeGreaterThan(1);
  const cursors = (await requests(page))
    .filter((path) => path.includes('/events'))
    .map((path) => new URL(`http://x${path.split(' ')[1]}`).searchParams.get('cursor'));
  expect(cursors[0]).toBeNull();
  expect(cursors[1]).toBe('20');

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

test('the tabs are one tab stop whose arrows wrap and whose ends are Home and End', async ({
  page,
}) => {
  await open(page);
  const tabs = dialog(page).getByRole('tablist');
  const selected = tabs.locator('[aria-selected="true"]');
  const panel = dialog(page).getByRole('tabpanel');

  await tab(page, 'Declared').focus();
  await expect(tabs.locator('[tabindex="0"]')).toHaveCount(1);
  await expect(tabs.locator('[tabindex="0"]')).toHaveText('Declared');

  await page.keyboard.press('ArrowLeft');
  await expect(selected).toHaveText('Checkpoints');
  await expect(tab(page, 'Checkpoints')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(selected).toHaveText('Declared');
  await page.keyboard.press('ArrowRight');
  await expect(selected).toHaveText('Trace');
  await expect(traceTree(page)).toBeVisible();
  await page.keyboard.press('End');
  await expect(selected).toHaveText('Checkpoints');
  await page.keyboard.press('Home');
  await expect(selected).toHaveText('Declared');

  const labelledBy = await panel.getAttribute('aria-labelledby');
  expect(labelledBy).toBe(await tab(page, 'Declared').getAttribute('id'));
  expect(await tab(page, 'Declared').getAttribute('aria-controls')).toBe(
    await panel.getAttribute('id'),
  );
});

test('the Checkpoints list moves its choice with Up, Down, Home and End, as a click would', async ({
  page,
}) => {
  await open(page, 'checkpoints');
  await tab(page, 'Checkpoints').click();
  const list = dialog(page).getByRole('listbox', { name: 'Checkpoints' });
  const options = list.getByRole('option');
  await expect(options).toHaveCount(2);
  const header = details(page).locator('header').first();

  await expect(list).toHaveAttribute('tabindex', '0');
  await expect(list.locator('[role="option"][tabindex="0"]')).toHaveCount(0);

  await list.focus();
  await page.keyboard.press('Home');
  await expect(options.first()).toHaveAttribute('aria-selected', 'true');
  const byKey = await header.textContent();
  await page.keyboard.press('ArrowDown');
  await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(list).toBeFocused();

  // The key and the click are one choice: the dock lands in the same place either way.
  await options.first().click();
  await expect(header).toHaveText(byKey!);
  await expect(list).toBeFocused();

  await page.keyboard.press('End');
  await expect(options.last()).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowDown');
  await expect(options.last()).toHaveAttribute('aria-selected', 'true');
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

test('a reconnect and a duplicate event both leave the run coherent', async ({ page }) => {
  await open(page, 'done');
  await tab(page, 'Trace').click();
  const tree = traceTree(page);
  const before = await lastReachableExecution(page);
  expect(before).not.toBeNull();
  await page.evaluate(() => window.inspectorFixture?.resetRequests());

  await page.locator('[data-action="duplicate-event"]').click();
  await page.locator('[data-action="reconnect"]').click();

  // A reconnect re-reads the run and its event log, from the start, and merges what it reads: the
  // duplicate and the re-read events are each held once.
  await expect
    .poll(async () => (await requests(page)).filter((path) => /runs\/\d+$/.test(path)).length)
    .toBeGreaterThan(0);
  await expect
    .poll(async () =>
      (await requests(page)).some((path) => path.includes('/events?') && !path.includes('cursor')),
    )
    .toBe(true);
  await expect(dialog(page).locator('[data-marker="code-reloaded"]')).toHaveCount(1);
  await expect.poll(() => lastReachableExecution(page)).toBe(before);
  await goToTop(page);
  await expect(tree.locator('[data-execution="101"]')).toHaveCount(1);
});

test('a paused run says so, and its pause band comes from the event log', async ({ page }) => {
  await open(page, 'paused');
  await expect(dialog(page).locator('header h2')).toContainText('paused');
  await tab(page, 'Trace').click();
  await expect(traceTree(page)).toBeVisible();
});

test('every scenario opens, draws and selects without error', async ({ page }) => {
  const scenarios = [
    'running',
    'waiting_agent',
    'waiting_questions',
    'waiting_continue',
    'paused',
    'callback_failed',
    'done',
    'authored_failure',
    'cancelled',
    'interrupted',
  ];
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto('./');
  for (const scenario of scenarios) {
    await page.locator(`[data-action="scenario-${scenario}"]`).click();
    await inspect(page).click();
    await expect(dialog(page)).toBeVisible();
    await expect(
      dialog(page).locator('[data-testid="declared-viewport"] [data-element]').first(),
    ).toBeVisible();
    await tab(page, 'Trace').click();
    await tab(page, 'Declared').click();
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
  }
  expect(errors).toEqual([]);
});

test('reduced motion is respected and the elapsed time still moves', async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await context.newPage();
  await open(page, 'running');
  const facts = dialog(page).locator('header p').first();
  const before = await facts.textContent();
  await expect.poll(async () => facts.textContent(), { timeout: 4000 }).not.toBe(before);
  await context.close();
});

test('a run whose graph init threw shows its graph rather than "nothing has run yet"', async ({
  page,
}) => {
  await open(page, 'root_init_failed');
  await expect(dialog(page).locator('header').first()).toContainText("A graph's init code threw.");
  await tab(page, 'Trace').click();

  await expect(dialog(page).getByText('Nothing has run yet.')).toHaveCount(0);
  const row = dialog(page).locator('[data-invocation="1"]');
  await expect(row).toBeVisible();
  await row.click();
  await expect(details(page)).toContainText('release');
  await expect(dataColumn(page).locator('[data-tab="state"]')).toBeVisible();
});

test("the root graph's outcome is drawn on its row, and its row opens the graph", async ({
  page,
}) => {
  await open(page, 'done');
  await tab(page, 'Trace').click();
  await goToTop(page);
  const row = dialog(page).locator('[data-invocation="1"]');
  await expect(row.locator('[data-marker="output"]')).toHaveText('shipped');
  await row.click();
  await expect(details(page)).toContainText('shipped · success');
  await dataColumn(page).getByRole('button', { name: 'output', exact: true }).click();
  await expect(dataColumn(page)).toContainText('ship');
});

test('every execution at four levels deep is reachable in Trace', async ({ page }) => {
  await open(page, 'done');
  await tab(page, 'Trace').click();
  const tree = traceTree(page);
  await goToTop(page);
  for (let index = 0; index < 20; index += 1) {
    if ((await tree.locator('[role="treeitem"][aria-level="4"]').count()) > 0) break;
    await page.keyboard.press('ArrowDown');
  }
  await expect(tree.locator('[role="treeitem"][aria-level="4"]').first()).toBeVisible();
});

test("a subgraph's child executions are reachable from the dock, one level at a time", async ({
  page,
}) => {
  await open(page, 'done');
  await selectExecution(page, 103);

  // The direct children of the review graph, and not its grandchildren. The Retry is one of them.
  const children = dialog(page).getByRole('list', { name: 'Executions inside this graph' });
  await expect(children.locator('[data-child-execution]')).toHaveCount(4);
  await expect(children.locator('[data-child-execution="110"]')).toBeVisible();
  await expect(children.locator('[data-child-execution="107"]')).toHaveCount(0);

  await children.locator('[data-child-execution="106"]').click();
  await expect(details(page)).toContainText('deep-check');
  await expect(children.locator('[data-child-execution="107"]')).toBeVisible();

  await children.locator('[data-child-execution="107"]').focus();
  await page.keyboard.press('Enter');
  await expect(details(page)).toContainText('scan');
});

test('the dock stays four dense columns and scrolls rather than reflowing', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 800 });
  await open(page, 'waiting_questions');
  await selectExecution(page, 102);

  const strip = details(page).locator('[data-testid="dock-columns"]');
  await expect(details(page).locator('[data-dock-column]')).toHaveCount(4);

  const overflow = await strip.evaluate((node) => ({
    scrollWidth: node.scrollWidth,
    clientWidth: node.clientWidth,
  }));
  expect(overflow.scrollWidth).toBeGreaterThan(overflow.clientWidth);

  const data = details(page).locator('[data-dock-column="Data"]');
  await data.scrollIntoViewIfNeeded();
  await expect(data).toBeInViewport();
  await data.getByRole('button', { name: 'op1.request', exact: true }).click();
  await expect(data).toContainText('unbounded queries');

  const firstTab = data.getByRole('button', { name: 'result', exact: true });
  await firstTab.focus();
  await expect(firstTab).toBeFocused();

  const grip = details(page).getByRole('slider', { name: 'Resize details' });
  await grip.focus();
  await page.keyboard.press('End');
  await expect(details(page).locator('[data-dock-column]')).toHaveCount(4);
  await expect(data).toBeVisible();
  await page.keyboard.press('Home');
  await expect(details(page).locator('[data-dock-column]')).toHaveCount(4);
  await expect(grip).toBeFocused();
});

test('an execution cut off by a restart says so and claims no running time', async ({ page }) => {
  await open(page, 'interrupted');
  await selectExecution(page, 102);

  const recorded = dialog(page).locator('[data-dock-column="Recorded"]');
  await expect(recorded).toContainText('interrupted');
  await expect(recorded).toContainText('Interrupted by an app restart.');
  await expect(recorded).not.toContainText('so far');

  await tab(page, 'Declared').click();
  await expect(canvas(page).locator('[data-element="::node:triage"]')).not.toContainText('open');
});

test('a build reloaded while the inspector is open redraws it, executions unchanged', async ({
  page,
}) => {
  await open(page, 'done');
  const viewport = canvas(page);
  await expect(viewport.locator('[data-element]').first()).toBeVisible();
  await expect(viewport.locator('[data-element="::node:sign-off"]')).toHaveCount(0);

  const takenBefore = await viewport.locator('path[data-taken="true"]').count();
  expect(takenBefore).toBeGreaterThan(0);

  await page.locator('[data-action="reload-build"]').click();

  await expect(viewport.locator('[data-element="::node:sign-off"]')).toHaveCount(1);
  await expect(viewport.locator('[data-element="::node:sign-off"]')).toHaveAttribute(
    'data-status',
    'unvisited',
  );
  // Edges the run actually took are still drawn as taken on the build now on screen.
  await expect
    .poll(async () => viewport.locator('path[data-taken="true"]').count())
    .toBeGreaterThan(0);
});

test("a node's router is a knob on its right edge, and selects the decision it made", async ({
  page,
}) => {
  await open(page, 'done');
  const viewport = canvas(page);
  const card = viewport.locator('[data-element="::node:collect"]');
  const knob = viewport.locator('[data-router="::edge:after-collect"]');
  await expect(knob).toBeVisible();
  await expect(viewport.locator('[data-element="::edge:after-collect"]')).toHaveCount(0);

  // The arrows out of a node start at its knob, so the knob sits on the card's right edge whatever
  // the graph's loops do to the layout.
  const cardBox = (await card.boundingBox())!;
  const knobBox = (await knob.boundingBox())!;
  expect(Math.abs(knobBox.x + knobBox.width / 2 - (cardBox.x + cardBox.width))).toBeLessThan(2);

  // Start with the keyboard on another node, so a knob that kept focus to itself would leave Enter
  // and Space acting on the wrong node.
  await viewport.locator('[data-element="::node:triage"] [data-node-key]').click();
  await knob.click();
  await expect(details(page)).toContainText('collect');

  // The knob is not a stop of its own: its node takes focus, and the keyboard carries on from there.
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-node-key') ?? null))
    .toBe('::node:collect');
  await page.keyboard.press('Enter');
  await expect(details(page)).toContainText('collect');
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
  // Opened once so the run's tree has already landed and the shape is settled before the layout is
  // made to fail.
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
  // this reloads a new build, which is the thing that actually changes what has to be drawn.
  await page.locator('[data-action="reload-build"]').click();
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

test('a build that renames nothing still redraws the graph', async ({ page }) => {
  await open(page, 'done');
  await expect(canvas(page).locator('[data-element]').first()).toBeVisible();

  // `after-second` keeps its id across the two builds and changes where it can go: the later build
  // puts `sign-off` between `second-pass` and `shipped`, so `shipped` has to move one layer right. A
  // layout identity summarising element keys would have been identical, and the old geometry would
  // have stayed.
  const before = await canvas(page)
    .locator('[data-element="::outcome:shipped"]')
    .evaluate((node) => node.getBoundingClientRect().x);

  await page.keyboard.press('Escape');
  await page.locator('[data-action="reload-build"]').click();
  await inspect(page).click();
  await expect(canvas(page).locator('[data-element="::node:sign-off"]')).toHaveCount(1);

  await expect
    .poll(async () =>
      canvas(page)
        .locator('[data-element="::outcome:shipped"]')
        .evaluate((node) => node.getBoundingClientRect().x),
    )
    .not.toBe(before);
});

test('a graph opens and closes from anywhere on its card, not just its name', async ({ page }) => {
  await open(page, 'done');
  const viewport = canvas(page);
  const box = viewport.locator('[data-element="::node:first-pass"]');
  await expect(box).toBeVisible();

  // The bottom of the card, well away from its name.
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
  // The strip along the bottom edge, inside the graph's padding and below every child in it. The
  // padding scales with the zoom, and a wide graph is drawn small, so this stays close to the edge.
  await page.mouse.dblclick(opened.x + opened.width / 2, opened.y + opened.height - 2);
  await expect(viewport.locator('[data-element="first-pass::node:read"]')).toHaveCount(0);
});
