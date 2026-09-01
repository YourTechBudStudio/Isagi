import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * The editor surfaces, against the fixture contact sheet. What lives here is
 * everything static markup cannot answer: the frame actually loading, the header
 * receding once it has, keyboard reachability, and the disclosure's behavior
 * across a real click.
 */

const pane = (page: Page, id: string): Locator => page.locator(`[data-pane-fixture="${id}"]`);

test.beforeEach(async ({ page }) => {
  await page.goto('./');
});

test('the workbench frame loads and hands over from its cover', async ({ page }) => {
  const ready = pane(page, 'ready');
  const frame = ready.locator('iframe');

  await expect(frame).toHaveCount(1);
  // The stand-in workbench is a real document, so this is a real cross-document
  // load rather than a simulated one.
  const workbench = ready.frameLocator('iframe');
  await expect(workbench.locator('.status')).toContainText('feat/embedded-editor');
  await expect(ready.getByText('Loading the workbench…')).toHaveCount(0);
});

test('the header recedes once the workbench has painted, and returns on hover', async ({
  page,
}) => {
  const ready = pane(page, 'ready');
  const header = ready.locator('section > div').first();
  await expect(ready.frameLocator('iframe').locator('.status')).toBeVisible();

  // At rest the workbench owns the pane: the header is a hairline.
  await expect(header).toHaveCSS('height', '1px');

  await ready.locator('section').hover();
  await expect(header).not.toHaveCSS('height', '1px');
});

test('a request-local failure pins the header open over a working workbench', async ({ page }) => {
  const noticed = pane(page, 'ready-notice');
  const header = noticed.locator('section > div').first();
  await expect(noticed.frameLocator('iframe').locator('.status')).toBeVisible();

  // The user has to see this without going looking for it.
  await expect(header).not.toHaveCSS('height', '1px');
  await expect(noticed.getByText("The editor isn't installed yet.")).toBeVisible();
});

test('the disclosure opens on demand and closes again', async ({ page }) => {
  const exited = pane(page, 'exited');
  const output = exited.getByRole('region', { name: /raw output · code-server · pid 48120/ });

  await expect(output).toHaveCount(0);
  await exited.getByRole('button', { name: 'Show startup output' }).click();
  await expect(output).toBeVisible();
  await expect(output).toContainText('EADDRINUSE');
  await expect(output).toContainText('dropped from the front');

  await exited.getByRole('button', { name: 'Hide startup output' }).click();
  await expect(output).toHaveCount(0);
});

test('a failed diagnostics read stays inside the disclosure', async ({ page }) => {
  const failed = pane(page, 'diagnostics-failed');
  await failed.getByRole('button', { name: 'Show startup output' }).click();

  // The editor's own Retry and the read's Try again are distinct affordances:
  // failing to read a log says nothing about the editor's state.
  await expect(failed.getByText('editor_diagnostics_unavailable · request 8f21')).toBeVisible();
  await expect(failed.getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect(failed.getByRole('button', { name: 'Retry' })).toBeVisible();
});

test('idle starts with reuse and a settled state replaces', async ({ page }) => {
  await pane(page, 'idle').getByRole('button', { name: 'Start editor' }).click();
  await expect(pane(page, 'idle').locator('[data-started-intent="reuse"]')).toBeVisible();

  await pane(page, 'exited').getByRole('button', { name: 'Retry' }).click();
  await expect(pane(page, 'exited').locator('[data-started-intent="replace"]')).toBeVisible();
});

test('nothing is pressable while a launch or a probe is still running', async ({ page }) => {
  for (const id of ['launching', 'waiting']) {
    // Scoped to the pane itself: the gallery's own caption controls sit in the
    // same figure and are not part of what the pane offers.
    await expect(pane(page, id).locator('section').first().getByRole('button')).toHaveCount(0);
  }
});

test('every pane action is reachable from the keyboard', async ({ page }) => {
  const start = pane(page, 'idle').getByRole('button', { name: 'Start editor' });
  await start.focus();
  await expect(start).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(pane(page, 'idle').locator('[data-started-intent="reuse"]')).toBeVisible();
});

test('entering the workbench activates its pane, by pointer and by keyboard', async ({ page }) => {
  // Pointer events inside the frame belong to its own document and never reach
  // the pane's handler. If this regressed, clicking into a workbench would leave
  // another pane marked active and point Cmd+W at the wrong one.
  const ready = pane(page, 'ready');
  await expect(ready.frameLocator('iframe').locator('.status')).toBeVisible();
  await expect(ready).not.toHaveAttribute('data-pane-focused', '');

  await ready.frameLocator('iframe').locator('.code').click();
  await expect(ready).toHaveAttribute('data-pane-focused', '');

  // The keyboard path is a plain focus on the frame element in our document.
  const noticed = pane(page, 'ready-notice');
  await expect(noticed).not.toHaveAttribute('data-pane-focused', '');
  await noticed.locator('iframe').focus();
  await expect(noticed).toHaveAttribute('data-pane-focused', '');
});

test('the focus router can land keyboard focus back inside the workbench', async ({ page }) => {
  // The return leg of activation. When focus-owning chrome closes, Isagi asks the
  // shared router for the active pane's focus target; an editor that registered
  // none would leave the user having to click back into Code Server.
  const ready = pane(page, 'ready');
  await expect(ready.frameLocator('iframe').locator('.status')).toBeVisible();

  await ready.locator('[data-restore-focus]').click();
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.tagName ?? null))
    .toBe('IFRAME');

  // With no workbench up the pane itself is the honest landing place, which is
  // what keeps a failed editor reachable from the keyboard at all.
  const idle = pane(page, 'idle');
  await idle.locator('[data-restore-focus]').click();
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? null))
    .toBe('isagi · feat/embedded-editor');
});

test('a delete reports the affordance it started from', async ({ page }) => {
  const chrome = pane(page, 'chrome');

  // The cluster is the pane's own inline control.
  await chrome.locator('section').hover();
  await chrome.getByRole('button', { name: 'Delete pane' }).click();
  await expect(chrome).toHaveAttribute('data-delete-origin', 'pane');
  await chrome.locator('[data-clear-delete]').click();

  // The header's context menu is a different origin, and hosts its own sweep.
  await chrome.locator('section').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete pane' }).click();
  await expect(chrome).toHaveAttribute('data-delete-origin', 'menu');
});

test('a provisioning failure retries from the boot surface, and an unsupported platform does not', async ({
  page,
}) => {
  const stage = page.locator('[data-boot-stage]');

  await page.click('[data-boot-option="failed-download"]');
  await stage.getByRole('button', { name: 'Try again' }).click();
  await expect(page.locator('[data-retry-count="1"]')).toBeVisible();

  // A retry that could only fail identically forever is not offered at all.
  await page.click('[data-boot-option="failed-platform"]');
  await expect(stage.getByRole('button')).toHaveCount(0);
});

test('a transient phase is one status line, with nothing to press and nothing to count', async ({
  page,
}) => {
  const stage = page.locator('[data-boot-stage]');

  for (const id of ['checking', 'downloading', 'verifying', 'extracting']) {
    await page.click(`[data-boot-option="${id}"]`);
    await expect(stage.getByRole('button')).toHaveCount(0);
    await expect(stage).not.toContainText('MB');
    await expect(stage).not.toContainText('%');
  }
  await expect(stage.getByText('Fetching the editor…')).toHaveCount(0);
  await page.click('[data-boot-option="downloading"]');
  await expect(stage.getByText('Fetching the editor…')).toBeVisible();
});

test('onboarding hears about failures only', async ({ page }) => {
  const lines = page.getByText('(nothing)');
  // Every transient state, plus ready and not_applicable, resolve to no line.
  await expect(lines).toHaveCount(6);
});

test('an onboarding failure is a manifest comment and a named retry in the existing row', async ({
  page,
}) => {
  const stage = page.locator('[data-onboarding-stage]');

  // The real PolicyForm, with the real manifest around it: the failure has to
  // read as one more config line, not as a second surface bolted onto setup.
  await expect(stage.getByRole('switch', { name: 'codex' })).toBeVisible();
  await expect(stage.getByText("# the editor download didn't finish.")).toBeVisible();

  // Named for what it retries, beside the Save it shares the row with.
  await expect(stage.getByRole('button', { name: 'Save and continue' })).toBeVisible();
  await stage.getByRole('button', { name: 'Retry download' }).click();
  await expect(page.locator('[data-onboarding-retry="1"]')).toBeVisible();

  // A retry that could only fail identically forever is not offered here either.
  await page.click('[data-onboarding-option="failed-platform"]');
  await expect(stage.getByText('# no editor build for this machine.')).toBeVisible();
  await expect(stage.getByRole('button', { name: 'Retry download' })).toHaveCount(0);
});

test('the onboarding manifest stays keyboard-first with a failure on it', async ({ page }) => {
  const stage = page.locator('[data-onboarding-stage]');
  const first = stage.getByRole('switch', { name: 'pi' });

  await first.focus();
  await page.keyboard.press('ArrowDown');
  await expect(stage.getByRole('switch', { name: 'opencode' })).toBeFocused();
  // Every harness in this snapshot is detected, so the manifest arrives fully
  // enabled and space is the affordance that turns one off.
  await page.keyboard.press('Space');
  await expect(stage.getByRole('switch', { name: 'opencode' })).toHaveAttribute(
    'aria-checked',
    'false',
  );
});
