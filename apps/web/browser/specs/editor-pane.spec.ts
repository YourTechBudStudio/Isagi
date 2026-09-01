import { expect, test, type Page } from '@playwright/test';

/**
 * The editor pane, mounted through the production `Surface` against a fake
 * runtime.
 *
 * Two kinds of thing live here, and nothing else does. First, the four
 * behaviours no markup can establish: the frame actually loading, the header
 * receding at a real computed height, activation across the iframe's own
 * document, and the focus router landing back inside the workbench. Second, the
 * container's lifecycle rules — which need effects, a client renderer, and a real
 * query cache, none of which the Node suite has (it is `node:test` plus
 * `renderToStaticMarkup`).
 *
 * Everything that markup *can* answer stays in `EditorPane.test.tsx`.
 */

const pane = (page: Page) => page.getByRole('region', { name: 'isagi · feat/embedded-editor' });
const section = (page: Page) => page.locator('section[aria-label="isagi · feat/embedded-editor"]');
const workbench = (page: Page) => page.frameLocator('iframe');
const activePaneId = (page: Page) => page.locator('[data-active-pane-id]');

const PANE_ID = 77;
const NEIGHBOUR_PANE_ID = 78;

test.beforeEach(async ({ page }) => {
  await page.goto('./');
});

// ---------------------------------------------------------------------------
// Container lifecycle — effects, mutations, and request records
// ---------------------------------------------------------------------------

test('a mounted context asks the runtime for a workbench exactly once', async ({ page }) => {
  await expect(workbench(page).locator('.status')).toBeVisible();

  // One `reuse`, from the mount. Not a second one when the projection then
  // transitions to ready — that would be a request loop against a settled state.
  await expect
    .poll(() => page.evaluate(() => window.editorTestSupport!.ensureRequests()))
    .toEqual([{ editorContextId: 7, intent: 'reuse' }]);

  // Hold long enough that a projection-driven retrigger would have landed.
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.editorTestSupport!.ensureRequests().length)).toBe(1);
});

test('a launch failure is reported once, by the projection, never twice', async ({ page }) => {
  await page.goto('./?failFirstEnsure=launch');

  // The settled state, read back from the durable attempt record.
  await expect(pane(page).getByText('Retry')).toBeVisible();
  // The runtime recorded it, so the request-local notice must stay silent: one
  // fact, said once. Both sentences are the same, so a duplicate is countable.
  const sentences = await pane(page)
    .getByText(/Couldn't reserve a local port for the editor/i)
    .count();
  expect(sentences).toBe(1);
});

test('a failure the runtime never recorded shows as a notice, and idle keeps its action', async ({
  page,
}) => {
  await page.goto('./?failFirstEnsure=database');

  // The projection still reads `idle` — nothing was recorded — which is exactly
  // the case a notice scoped to `settled` would have hidden.
  await expect(pane(page).getByRole('button', { name: 'Start editor' })).toBeVisible();
  await expect(pane(page).getByText(/local database didn't cooperate/i)).toBeVisible();
});

test('the notice clears on the next successful ensure', async ({ page }) => {
  await page.goto('./?failFirstEnsure=database');
  await expect(pane(page).getByText(/local database didn't cooperate/i)).toBeVisible();

  await pane(page).getByRole('button', { name: 'Start editor' }).click();

  await expect(pane(page).getByText(/local database didn't cooperate/i)).toHaveCount(0);
  await expect(workbench(page).locator('.status')).toBeVisible();
});

test('a durable launch failure retires the notice the previous attempt left', async ({ page }) => {
  await page.goto('./?failFirstEnsure=database');
  await expect(pane(page).getByText(/local database didn't cooperate/i)).toBeVisible();

  // The retry reaches the runtime this time and is *recorded* as a failed
  // attempt. Two failures would now be on screen — the stale request-local one
  // and the authoritative projection — describing the same pane.
  await page.evaluate(() => window.editorTestSupport!.failNextEnsure('launch'));
  await pane(page).getByRole('button', { name: 'Start editor' }).click();

  await expect(pane(page).getByText(/Couldn't reserve a local port for the editor/i)).toBeVisible();
  await expect(pane(page).getByText(/local database didn't cooperate/i)).toHaveCount(0);
});

test('a slow ensure cannot install its notice over an incarnation that replaced it', async ({
  page,
}) => {
  await page.goto('./?failFirstEnsure=database&ensureDelay=700');

  // While that first ensure is still in flight, the incarnation changes under the
  // pane and the client *learns about it* — in production, an
  // `editor_context_changed` event invalidating surface detail. The read has to
  // land before the stale response, or the ensure's own settle-invalidation
  // would clear the notice anyway and this would prove nothing.
  await page.evaluate(async () => {
    window.editorTestSupport!.setEditor({
      activePtyProcessId: 90210,
      processStatus: 'running',
      workbenchReadiness: 'ready',
      endpoint: { host: '127.0.0.1', port: 41287, url: '/test-support/editor/workbench.html' },
    });
    await window.editorTestSupport!.refetchSurface();
  });
  await expect(workbench(page).locator('.status')).toBeVisible();

  // The stale response lands here. Its notice describes a request against a
  // process that no longer exists, so it must be dropped.
  await page.waitForTimeout(900);
  await expect(pane(page).getByText(/local database didn't cooperate/i)).toHaveCount(0);
});

test('diagnostics are read on demand, keyed to the incarnation on screen', async ({ page }) => {
  await page.goto('./?settled=1');
  await expect(pane(page).getByRole('button', { name: 'Show startup output' })).toBeVisible();

  // Closed by default: no speculative fetch on mount.
  expect(await page.evaluate(() => window.editorTestSupport!.diagnosticsRequests())).toEqual([]);

  await pane(page).getByRole('button', { name: 'Show startup output' }).click();
  await expect(pane(page).getByText('EADDRINUSE')).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.editorTestSupport!.diagnosticsRequests()))
    .toEqual([{ editorContextId: 7, ptyProcessId: 48120 }]);
});

test('the disclosure closes on an incarnation change, and starts no read for its replacement', async ({
  page,
}) => {
  await page.goto('./?settled=1');
  await pane(page).getByRole('button', { name: 'Show startup output' }).click();
  await expect(pane(page).getByText('EADDRINUSE')).toBeVisible();

  // A replacement. What the disclosure was showing belonged to a process that
  // no longer exists, so it closes rather than re-reading under the new id.
  await page.evaluate(async () => {
    window.editorTestSupport!.setEditor({ activePtyProcessId: 90210, hasDiagnostics: true });
    await window.editorTestSupport!.refetchSurface();
  });

  await expect(pane(page).getByRole('button', { name: 'Show startup output' })).toBeVisible();
  await expect(pane(page).getByText('EADDRINUSE')).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      window.editorTestSupport!.diagnosticsRequests().map((entry) => entry.ptyProcessId),
    ),
  ).toEqual([48120]);
});

test('a failed diagnostics read stays inside the disclosure', async ({ page }) => {
  await page.goto('./?settled=1&failFirstDiagnostics=1');
  await pane(page).getByRole('button', { name: 'Show startup output' }).click();

  // A failed read of the log says nothing about the editor's own state, so the
  // pane keeps its own retry and the failure stays where the user opened it.
  await expect(pane(page).getByText(/startup output/i)).toBeVisible();
  await expect(pane(page).getByRole('button', { name: 'Retry' })).toBeVisible();
});

// ---------------------------------------------------------------------------
// Cross-document — what markup cannot establish at all
// ---------------------------------------------------------------------------

test('the workbench frame loads and hands over from its cover', async ({ page }) => {
  const frame = section(page).locator('iframe');
  await expect(frame).toHaveCount(1);

  // The stand-in workbench is a real document, so this is a real cross-document
  // load rather than a simulated one.
  await expect(workbench(page).locator('.status')).toContainText('feat/embedded-editor');
  await expect(pane(page).getByText('Loading the workbench…')).toHaveCount(0);
});

test('the header recedes once the workbench has painted, and returns on hover', async ({
  page,
}) => {
  const header = section(page).locator('> div').first();
  await expect(workbench(page).locator('.status')).toBeVisible();

  // At rest the workbench owns the pane: the header is a hairline. This is only
  // observable as a computed height, in a real layout.
  await expect(header).toHaveCSS('height', '1px');

  await section(page).hover();
  await expect(header).not.toHaveCSS('height', '1px');
});

/**
 * The regression. `focus-within` on the pane counted the workbench itself, so
 * the header animated back the instant the user clicked into the editor — the
 * one moment it is supposed to be gone. Only a real browser can tell: focus is
 * not a property of markup.
 *
 * The wait is load-bearing rather than lazy. `toHaveCSS` retries until it sees
 * the expected value, so asserting `1px` immediately after focusing passes on
 * the first poll no matter what — the height animates over `--duration-ui`
 * (190ms) and has not moved yet. Proving that nothing happens means letting the
 * transition window elapse first. Verified by restoring `group-focus-within`:
 * the settled height is 36px and this fails.
 */
test('working in the workbench does not bring the header back', async ({ page }) => {
  const header = section(page).locator('> div').first();
  await expect(workbench(page).locator('.status')).toBeVisible();
  await expect(header).toHaveCSS('height', '1px');

  await section(page).locator('iframe').focus();
  await page.waitForTimeout(700);

  await expect(header).toHaveCSS('height', '1px');
  // The pointer still reveals it, so the chrome stays reachable.
  await section(page).hover();
  await expect(header).not.toHaveCSS('height', '1px');
});

test('a request-local failure pins the header open over a working workbench', async ({ page }) => {
  // The pane mounts against an editor that is already serving, and its
  // confirming `reuse` fails transiently. A ready pane offers no action of its
  // own, so this — not a button — is how the two facts come to coexist.
  await page.goto('./?ready=1&failFirstEnsure=database');
  const header = section(page).locator('> div').first();
  await expect(workbench(page).locator('.status')).toBeVisible();

  await expect(pane(page).getByText(/local database didn't cooperate/i)).toBeVisible();
  // The workbench has painted, so the header would otherwise have receded. A
  // fact the user must not have to hover to discover pins it open instead.
  await page.mouse.move(0, 0);
  await expect(header).not.toHaveCSS('height', '1px');
});

test('entering the workbench activates its pane, by pointer and by keyboard', async ({ page }) => {
  // Pointer events inside the frame belong to its own document and never reach
  // the pane's handler. If this regressed, clicking into a workbench would leave
  // another pane marked active and point Cmd+W at the wrong one.
  await expect(workbench(page).locator('.status')).toBeVisible();
  // The neighbouring shell pane holds activation to start with, so this is a
  // genuine move rather than a value that was already standing.
  await expect(activePaneId(page)).toHaveAttribute(
    'data-active-pane-id',
    String(NEIGHBOUR_PANE_ID),
  );

  await workbench(page).locator('.code').click();
  await expect(activePaneId(page)).toHaveAttribute('data-active-pane-id', String(PANE_ID));
});

test('the keyboard path into the workbench activates the pane too', async ({ page }) => {
  await expect(workbench(page).locator('.status')).toBeVisible();
  await expect(activePaneId(page)).toHaveAttribute(
    'data-active-pane-id',
    String(NEIGHBOUR_PANE_ID),
  );

  // Tabbing into a frame is an ordinary focus event in the parent document.
  await section(page).locator('iframe').focus();
  await expect(activePaneId(page)).toHaveAttribute('data-active-pane-id', String(PANE_ID));
});

test('the focus router can land keyboard focus back inside the workbench', async ({ page }) => {
  // The return leg. When focus-owning chrome closes, Isagi asks the shared router
  // for the active pane's focus target; an editor registering none would leave
  // the user having to click back into Code Server.
  await expect(workbench(page).locator('.status')).toBeVisible();
  await workbench(page).locator('.code').click();

  await page.locator('[data-restore-focus]').click();
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.tagName ?? null))
    .toBe('IFRAME');
});

test('with no workbench up, focus lands on the pane itself', async ({ page }) => {
  await page.goto('./?failFirstEnsure=database');
  await expect(pane(page).getByRole('button', { name: 'Start editor' })).toBeVisible();

  await section(page).click({ position: { x: 5, y: 5 } });
  await page.locator('[data-restore-focus]').click();

  // Which is what keeps a failed or idle editor keyboard-reachable at all.
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? null))
    .toBe('isagi · feat/embedded-editor');
});
