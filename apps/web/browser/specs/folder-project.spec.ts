import { expect, test, type Page } from '@playwright/test';

/**
 * The folder-project fixture: presentation, availability, and same-path recovery.
 *
 * Since phase 07 the rail, the status strip and the palette on this page are the
 * *production* components, so what these assert about them is what the app does.
 * Locators are therefore production ones — roles, accessible names, `aria-current`,
 * and the drag attributes the rail genuinely ships — never fixture-only hooks
 * planted in production markup. The two exceptions are the scenario bar, which is
 * fixture chrome, and `[data-fixture-strip]`, a wrapper that only scopes to the
 * strip because the strip has no hook of its own and must not gain one.
 *
 * Every absence assertion is paired with a positive control that the surface it
 * is about actually rendered. An empty locator is otherwise indistinguishable
 * from a passing test.
 *
 * Scenario and outcome switching goes through the on-screen chips rather than
 * through `window.folderProjectFixture`, because those chips are the same path a
 * human uses; the fixture handle is reserved for the things no click can express.
 */

/** The palette's scrim and panel, as the production tree renders them. */
const PALETTE = 'div.fixed.inset-0.z-50 > div[tabindex="-1"]';

const strip = (page: Page) => page.locator('[data-fixture-strip]');

/**
 * The status strip's ref tag, located by the production treatment that *is* the
 * tag — the green mono span the strip renders only when there is a ref to name.
 * Asserting on the element rather than on its text means "no tag" cannot be
 * confused with "a tag whose text I failed to guess".
 */
const refTag = (page: Page) => strip(page).locator('span.text-green');
const palette = (page: Page) => page.locator(PALETTE);

/** A palette row by its visible label. */
const paletteRow = (page: Page, label: string) =>
  page.locator(`${PALETTE} button`).filter({ has: page.locator(`span:text-is("${label}")`) });

/** A project's slice of the rail, by the drag key the production rail emits. */
const projectGroup = (page: Page, projectId: number) =>
  page.locator(`[data-drag-source="projects#${projectId}"]`);

/** A project's worktree list, which is also its reorder scope. */
const worktreeScope = (page: Page, projectId: number) =>
  page.locator(`[data-drag-scope="worktrees:${projectId}"]`);

/**
 * A project's root environment row — the pinned one, which is the only row a
 * folder project has. `data-drag-pinned` is what makes it immovable in
 * production, so locating by it also asserts that it still is.
 */
const rootRow = (page: Page, projectId: number) =>
  worktreeScope(page, projectId).locator('[data-drag-pinned]').getByRole('button').first();

/**
 * The recovery actions, located by the production buttons the canvas renders.
 *
 * Phase 08 removed this page's last prototype, so the five `data-*` hooks the
 * recovery panel used are gone with it: these are ordinary accessible buttons
 * now, and naming them by their accessible name asserts the copy a user reads at
 * the same time. The recheck button's name changes while a check is running,
 * which is why it matches either form — the pending label is part of the control,
 * not a different control.
 */
const recheckButton = (page: Page) =>
  page.getByRole('button', { name: /^(Check again|Checking…)$/ });
const relocateButton = (page: Page) => page.getByRole('button', { name: 'Set new path…' });
const removeButton = (page: Page) => page.getByRole('button', { name: 'Remove project' });
const confirmPanel = (page: Page) => page.getByRole('button', { name: 'Remove from Isagi' });

/**
 * The two verdicts, by role *and* text.
 *
 * Role alone is not enough to identify them: the rail's update footer and its
 * order notice are `status` regions, and a toast is a `status` or an `alert`, so
 * a bare `getByRole('status')` on this page can match something that has nothing
 * to do with recovery. The text is what makes each locator name one verdict, and
 * the roles are what assert the split — confirmed unavailability is ordinary
 * feedback, a check that could not be completed is an alert.
 */
const stillMissing = (page: Page) =>
  page.getByRole('status').filter({ hasText: 'Still not there.' });
const checkFailed = (page: Page) =>
  page.getByRole('alert').filter({ hasText: "Couldn't finish that check." });

/** Either verdict, for the assertions that require the surface to be showing none. */
const anyVerdict = (page: Page) =>
  page
    .locator('[role="status"], [role="alert"]')
    .filter({ hasText: /Still not there\.|Couldn't finish that check\./ });

/** Any toast, by the dismiss control every toast card renders. */
const toasts = (page: Page) => page.getByRole('button', { name: 'Dismiss notification' });

/** A non-root worktree row, by the drag key the production rail emits. */
const worktreeRow = (page: Page, projectId: number, worktreeId: number) =>
  page
    .locator(`[data-drag-source="worktrees:${projectId}#${worktreeId}"]`)
    .getByRole('button')
    .first();

async function scenario(page: Page, id: string) {
  await page.locator(`[data-scenario="${id}"]`).click();
}

async function outcome(page: Page, id: string) {
  await page.locator(`[data-outcome="${id}"]`).click();
}

async function openPalette(page: Page) {
  await page.keyboard.press('Meta+k');
  await expect(palette(page)).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.goto('./');
  await expect(page.locator('[data-fixture-shell]')).toBeVisible();
});

test.describe('honest presentation', () => {
  test('a folder environment is titled folder and subtitled with its path', async ({ page }) => {
    await scenario(page, 'present-folder');

    const row = rootRow(page, 40);
    await expect(row).toContainText('folder');
    await expect(row).toContainText('~/Documents/notes');
    // The word `detached` is what a folder used to inherit from `gitRef`, and
    // it was false: nothing is detached, because nothing was ever attached.
    await expect(row).not.toContainText('detached');
  });

  test('a Git subtitle is the path alone, with no ref repeated after it', async ({ page }) => {
    await scenario(page, 'git-branch');

    // `worktreeTitle` returns the branch when there is one, so the row already
    // names it. Appending it again after the path printed the same string twice.
    const row = worktreeRow(page, 10, 102);
    await expect(row).toContainText('feat/folders');
    await expect(row).toContainText('~/work/.isagi/wt/folder-projects');
    // Exactly once, which is the whole claim.
    expect((await row.innerText()).match(/feat\/folders/g)).toHaveLength(1);
  });

  test('the branch still reaches the status strip for a Git environment', async ({ page }) => {
    await scenario(page, 'git-branch');
    // Removed from the row, kept where it is load-bearing rather than repeated.
    await expect(refTag(page)).toHaveText('feat/folders');
  });

  test('a detached Git worktree names its commit in the strip once selected', async ({ page }) => {
    await scenario(page, 'git-detached');

    // The narrow cost of dropping the ref from rows: a branchless worktree
    // titles itself from its basename, so its commit is not in the row at all.
    const row = worktreeRow(page, 20, 202);
    await expect(row).toContainText('bisect');
    await expect(row).toContainText('~/work/.toph/wt/bisect');
    await expect(row).not.toContainText('9f2c1ab');
    // It is not lost from the app, though — the strip still names it.
    await expect(refTag(page)).toHaveText('9f2c1ab');
  });

  test('the status strip carries no ref tag for a folder environment', async ({ page }) => {
    // Positive control: the same locator finds exactly one tag for a Git
    // environment, so its absence below is a rendering decision rather than a
    // selector that matches nothing anywhere.
    await scenario(page, 'git-branch');
    await expect(refTag(page)).toHaveCount(1);

    await scenario(page, 'present-folder');
    await expect(strip(page)).toBeVisible();
    // The production strip's own words. The deleted prototype invented
    // "Nothing running here yet." here; `workbenchCopy.noCommandsRunning` is
    // what the app actually says, which is the point of mounting the real one.
    await expect(strip(page)).toContainText('// no commands running');
    await expect(refTag(page)).toHaveCount(0);
    // The word a folder used to inherit from `gitRef`, which was false rather
    // than merely unhelpful.
    await expect(strip(page)).not.toContainText('detached');
  });

  test('every folder environment reads the same, and its project header names it', async ({
    page,
  }) => {
    await scenario(page, 'all-folder');

    // Three folder projects, three identically titled environments. The title is
    // a constant, so the row's own identity comes from its path and from the
    // project header above it.
    await expect(rootRow(page, 40)).toContainText('folder');
    await expect(rootRow(page, 50)).toContainText('folder');
    await expect(rootRow(page, 40)).toContainText('~/Documents/notes');
    await expect(rootRow(page, 50)).toContainText('~/scratch');
    await expect(projectGroup(page, 40).locator('[data-project-header]')).toContainText('notes');
    await expect(projectGroup(page, 50).locator('[data-project-header]')).toContainText('scratch');
  });

  test('the switcher lists a folder environment by path and activates it', async ({ page }) => {
    await scenario(page, 'mixed');
    // Start somewhere else, so activation is an observable change.
    await worktreeRow(page, 10, 103).click();
    await expect(worktreeRow(page, 10, 103)).toHaveAttribute('aria-current', 'true');

    await openPalette(page);
    const switchRow = paletteRow(page, 'folder');
    await expect(switchRow).toBeVisible();
    // The reason filtering `open-worktree` to Git costs no navigation: this
    // group is kind-blind, and it names the path rather than a fictitious ref.
    await expect(switchRow).toContainText('~/Documents/notes');
    await expect(switchRow).not.toContainText('detached');

    await switchRow.click();
    await expect(palette(page)).toHaveCount(0);
    await expect(rootRow(page, 40)).toHaveAttribute('aria-current', 'true');
  });
});

test.describe('scenario switching', () => {
  test('switching to a scenario sharing no project still opens where it claims', async ({
    page,
  }) => {
    // `git-branch` holds only project 10; `missing-folder` opens on project 40.
    // If the selection were applied before the new snapshot landed, production
    // selection reconciliation would find no project 40, fall back to a default,
    // and the recovery surface would never appear.
    await scenario(page, 'git-branch');
    await scenario(page, 'missing-folder');
    await expect(recheckButton(page)).toBeVisible();
  });

  test('re-clicking the current scenario resets a folder that was restored', async ({ page }) => {
    await scenario(page, 'missing-folder');
    await outcome(page, 'restores');
    await recheckButton(page).click();
    await expect(rootRow(page, 40)).toBeVisible();

    await scenario(page, 'missing-folder');
    await expect(recheckButton(page)).toBeVisible();
  });

  // The restore case above passes for the wrong reason: its canvas swap unmounts
  // the recovery surface, so component-local state is discarded whether or not
  // the reset does anything. These two verdicts leave the surface mounted, which
  // is the only way to observe that a scenario click actually clears it.
  test('re-clicking the current scenario clears a settled still-missing verdict', async ({
    page,
  }) => {
    await scenario(page, 'missing-folder');
    await outcome(page, 'stays_missing');
    await recheckButton(page).click();
    await expect(stillMissing(page)).toBeVisible();

    await scenario(page, 'missing-folder');
    // A verdict belonging to the previous run must not be read as belonging to
    // this one.
    await expect(anyVerdict(page)).toHaveCount(0);
    await expect(recheckButton(page)).toBeEnabled();
  });

  test('re-clicking the current scenario clears a settled failure and an armed removal', async ({
    page,
  }) => {
    await scenario(page, 'missing-folder');
    await outcome(page, 'reconcile_fails');
    await recheckButton(page).click();
    await expect(checkFailed(page)).toBeVisible();

    await removeButton(page).click();
    await expect(confirmPanel(page)).toBeVisible();

    await scenario(page, 'missing-folder');
    await expect(anyVerdict(page)).toHaveCount(0);
    // The confirmation is component-local too, and a half-armed destructive
    // action surviving a reset is worse than a stale verdict.
    await expect(confirmPanel(page)).toHaveCount(0);
    await expect(recheckButton(page)).toBeVisible();
  });

  test('a reset is not overtaken by a recheck that was already in flight', async ({ page }) => {
    await scenario(page, 'missing-folder');
    await page.locator('[data-latency="900"]').click();
    await outcome(page, 'restores');

    await recheckButton(page).click();
    await expect(recheckButton(page)).toBeDisabled();

    // Reset while that restore is still in its first stage. Remounting the
    // surface clears what is on screen, but the request itself keeps going.
    await scenario(page, 'missing-folder');
    await expect(recheckButton(page)).toBeEnabled();

    // Past both stages of the superseded request. A fixed wait, deliberately:
    // the assertion is that something never happens, so there is no state to
    // wait *for* — only a window long enough for the old work to have landed.
    await page.waitForTimeout(2_500);

    // The reset run is still missing. Without the generation guard the old
    // restore writes into the fresh snapshot and this project quietly comes
    // back, leaving a "reset" scenario in a state the reset never produced.
    await expect(recheckButton(page)).toBeVisible();
    await expect(rootRow(page, 40)).toHaveCount(0);
    await expect(anyVerdict(page)).toHaveCount(0);
  });

  test('a verdict does not survive a round trip through another scenario', async ({ page }) => {
    await scenario(page, 'missing-folder');
    await outcome(page, 'stays_missing');
    await recheckButton(page).click();
    await expect(stillMissing(page)).toBeVisible();

    // Out to a missing *Git* project and back. Every scenario here opens on a
    // missing project, so the recovery surface never unmounts on its own along
    // the way — and the return leg is what makes this bite: asserting only at
    // the Git stop would pass without any reset at all, because a Git project
    // renders no verdict slot to leak into.
    await scenario(page, 'missing-git');
    await expect(relocateButton(page)).toBeVisible();

    await scenario(page, 'missing-folder');
    await expect(recheckButton(page)).toBeVisible();
    await expect(anyVerdict(page)).toHaveCount(0);
  });
});

test.describe('availability', () => {
  test('only a Git project offers Open worktree in the rail', async ({ page }) => {
    await scenario(page, 'mixed');

    // Positive control: both project groups are on screen, so the missing
    // affordance below is a filtered one and not an unrendered rail.
    await expect(projectGroup(page, 10)).toBeVisible();
    await expect(projectGroup(page, 40)).toBeVisible();

    await expect(projectGroup(page, 10).getByTitle('Open worktree')).toHaveCount(1);
    await expect(projectGroup(page, 40).getByTitle('Open worktree')).toHaveCount(0);
  });

  test('the palette omits folder projects from Open worktree', async ({ page }) => {
    await scenario(page, 'mixed');
    await openPalette(page);

    await paletteRow(page, 'Open worktree').click();
    // The project step lists its targets. Matched on the option's own label
    // span rather than on any text in the panel: a project's row prints its
    // name *and* its path, so a loose text match resolves to two elements.
    // The Git project is offered, which proves the step rendered at all; the
    // folder project is not.
    await expect(palette(page).locator('span:text-is("isagi")')).toBeVisible();
    await expect(palette(page).locator('span:text-is("notes")')).toHaveCount(0);
  });

  test('Open worktree is not offered at all in an all-folder workspace', async ({ page }) => {
    await scenario(page, 'all-folder');
    await openPalette(page);

    // Positive control: the palette is open and offering other commands, so the
    // absence below is this command being unavailable rather than an empty list.
    await expect(paletteRow(page, 'Add project')).toBeVisible();
    await expect(paletteRow(page, 'Open worktree')).toHaveCount(0);
  });

  test('relocation is offered for a missing Git project and never for a missing folder', async ({
    page,
  }) => {
    await scenario(page, 'missing-git');
    await openPalette(page);
    await expect(paletteRow(page, 'Set project path')).toBeVisible();
    await page.keyboard.press('Escape');

    await scenario(page, 'missing-folder');
    await openPalette(page);
    await expect(paletteRow(page, 'Add project')).toBeVisible();
    await expect(paletteRow(page, 'Set project path')).toHaveCount(0);
  });

  test('the recovery action matches the kind, in the canvas', async ({ page }) => {
    await scenario(page, 'missing-git');
    await expect(relocateButton(page)).toBeVisible();
    await expect(recheckButton(page)).toHaveCount(0);

    await scenario(page, 'missing-folder');
    await expect(recheckButton(page)).toBeVisible();
    await expect(relocateButton(page)).toHaveCount(0);
  });

  test('a folder environment is pinned and offers no delete', async ({ page }) => {
    // `mixed`, not `present-folder`, so the Git control below is a real one: a
    // workspace with no Git project would make the comparison trivially zero,
    // which is the empty-locator trap this suite is meant to avoid.
    await scenario(page, 'mixed');

    // Pinned: it registers no drag source, so it contributes no insertion
    // boundary and nothing can be dropped above it.
    //
    // Scoped to the *worktree* keys on purpose. The selected environment
    // expands its surface list inside this same container, and surfaces are a
    // reorder scope of their own — so a bare `[data-drag-source]` here matches
    // a surface row and says nothing about the worktree being pinned.
    await expect(worktreeScope(page, 40).locator('[data-drag-pinned]')).toHaveCount(1);
    await expect(page.locator('[data-drag-source^="worktrees:40#"]')).toHaveCount(0);
    // Positive control: the Git project in this same workspace registers a
    // source for each of its two non-root worktrees, so the prefix genuinely
    // matches rows and the zero above is a fact about the folder project.
    await expect(page.locator('[data-drag-source^="worktrees:10#"]')).toHaveCount(2);

    await rootRow(page, 40).click({ button: 'right' });
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    // The ordinary actions are still offered; only delete is absent, and it is
    // absent because the row is root — not because of a second kind rule.
    await expect(menu.getByRole('menuitem', { name: /terminal/i })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /Delete/i })).toHaveCount(0);
  });
});

test.describe('same-path recovery', () => {
  test.beforeEach(async ({ page }) => {
    await scenario(page, 'missing-folder');
  });

  test('a confirmed-unavailable check says so and leaves the button armed', async ({ page }) => {
    await outcome(page, 'stays_missing');
    await recheckButton(page).click();

    await expect(stillMissing(page)).toHaveText('Still not there.');
    await expect(recheckButton(page)).toBeEnabled();
  });

  test('a failed reconcile reports the failure and never the absence', async ({ page }) => {
    await outcome(page, 'reconcile_fails');
    await recheckButton(page).click();

    const verdict = checkFailed(page);
    await expect(verdict).toContainText("Couldn't finish that check.");
    // The whole point of the two-outcome split: a check that did not complete
    // must not assert a fact the read never established.
    await expect(verdict).not.toContainText('Still not there');
    await expect(stillMissing(page)).toHaveCount(0);
  });

  test('a failed snapshot read after a successful reconcile also reports failure', async ({
    page,
  }) => {
    await outcome(page, 'snapshot_fails');
    await recheckButton(page).click();

    await expect(checkFailed(page)).toBeVisible();
    await expect(stillMissing(page)).toHaveCount(0);
  });

  test('a previous verdict is cleared before the next check, not after it', async ({ page }) => {
    await outcome(page, 'stays_missing');
    await recheckButton(page).click();
    await expect(stillMissing(page)).toBeVisible();

    await page.locator('[data-latency="900"]').click();
    await recheckButton(page).click();

    // While the new check runs, the old answer is gone rather than sitting under
    // a request that might contradict it.
    await expect(recheckButton(page)).toHaveText('Checking…');
    await expect(anyVerdict(page)).toHaveCount(0);
  });

  test('the button is disabled while a check is in flight', async ({ page }) => {
    await page.locator('[data-latency="900"]').click();
    await outcome(page, 'stays_missing');

    const button = recheckButton(page);
    await button.click();
    await expect(button).toBeDisabled();

    // Dispatched rather than clicked, because a real click would wait for the
    // button to become actionable and so could only ever observe the *enabled*
    // state. This asks the disabled control directly, which is the only way to
    // show that a second check is genuinely refused rather than merely delayed.
    await button.dispatchEvent('click');

    await expect(stillMissing(page)).toBeVisible({ timeout: 5_000 });
    const calls = await page.evaluate(() => window.folderProjectFixture?.reconcileCalls().length);
    expect(calls).toBe(1);
  });

  test('a restored folder swaps the canvas to the same environment', async ({ page }) => {
    await outcome(page, 'restores');
    await recheckButton(page).click();

    // Same project, same environment identity, back on the canvas — which is why
    // the action never has to touch selection.
    await expect(rootRow(page, 40)).toBeVisible();
    await expect(recheckButton(page)).toHaveCount(0);
  });

  test('a selection made while the check is in flight survives its completion', async ({
    page,
  }) => {
    await page.locator('[data-latency="900"]').click();
    await outcome(page, 'restores');
    await recheckButton(page).click();

    // Move to the other project's worktree mid-flight. Production selection
    // reconciliation must leave this alone when the fresh snapshot lands.
    await worktreeRow(page, 10, 102).click();
    await expect(worktreeRow(page, 10, 102)).toHaveAttribute('aria-current', 'true');

    await expect(rootRow(page, 40)).toBeVisible({ timeout: 5_000 });
    await expect(worktreeRow(page, 10, 102)).toHaveAttribute('aria-current', 'true');
  });

  test('a restore is silent: the canvas swap is the entire feedback', async ({ page }) => {
    await outcome(page, 'restores');
    await recheckButton(page).click();

    await expect(rootRow(page, 40)).toBeVisible();
    // No banner, no toast, no lingering verdict. Every outcome of this action
    // stays at the surface that started it, and the one that removes that
    // surface says nothing at all.
    await expect(anyVerdict(page)).toHaveCount(0);
    await expect(toasts(page)).toHaveCount(0);
  });
});

/**
 * Everything the recovery surface holds is about *one* project: an armed
 * removal, a settled verdict, a failed check. Production keys the surface on the
 * project id (`Canvas`), and these are the cases that key exists for.
 *
 * The fixture renders the production `Canvas` for this branch precisely so these
 * tests exercise that key rather than one of the fixture's own.
 */
test.describe('recovery state is scoped to one project', () => {
  /**
   * A disconnected project's rail row.
   *
   * Scoped to the rail deliberately. Playwright matches an accessible name by
   * substring, and the recovery canvas has a `Remove from Isagi` button, so an
   * unscoped `name: 'isagi'` matches that too — which is how the first run of
   * this suite failed. The rail is where these rows live, so scoping to it is
   * both the fix and the more honest claim.
   */
  const missingRow = (page: Page, name: string) =>
    page.locator('aside').getByRole('button', { name });

  test.beforeEach(async ({ page }) => {
    await scenario(page, 'two-missing');
  });

  test('a settled verdict does not follow the user to another missing project', async ({
    page,
  }) => {
    await outcome(page, 'stays_missing');
    await recheckButton(page).click();
    await expect(stillMissing(page)).toBeVisible();

    await missingRow(page, 'isagi').click();
    // Positive control first: the Git recovery surface really rendered, so the
    // absence below is about the verdict and not about an empty page.
    await expect(relocateButton(page)).toBeVisible();
    await expect(anyVerdict(page)).toHaveCount(0);

    await missingRow(page, 'notes').click();
    await expect(recheckButton(page)).toBeVisible();
    // The return leg is what bites: a Git project renders no verdict slot to
    // leak into, so stopping at the assertion above would pass without any
    // isolation at all.
    await expect(anyVerdict(page)).toHaveCount(0);
  });

  test('an armed removal does not follow the user to another missing project', async ({ page }) => {
    await removeButton(page).click();
    await expect(confirmPanel(page)).toBeVisible();

    await missingRow(page, 'isagi').click();
    await expect(relocateButton(page)).toBeVisible();
    // A half-armed destructive action arriving over a project the user never
    // armed it for is worse than a stale verdict.
    await expect(confirmPanel(page)).toHaveCount(0);

    await missingRow(page, 'notes').click();
    await expect(recheckButton(page)).toBeVisible();
    await expect(confirmPanel(page)).toHaveCount(0);
  });

  test('a check that lands after the user leaves does not surface on their return', async ({
    page,
  }) => {
    await page.locator('[data-latency="900"]').click();
    await outcome(page, 'stays_missing');
    await recheckButton(page).click();
    await expect(recheckButton(page)).toBeDisabled();

    // Leaving unmounts the panel. It does not cancel the operation: the reconcile
    // and the refresh carry on and update the shared workspace facts, and only
    // the panel's local verdict is dropped.
    await missingRow(page, 'isagi').click();
    await expect(relocateButton(page)).toBeVisible();

    // Past both stages of the check that is still running. A fixed wait,
    // deliberately: the assertion is that something never appears, so there is
    // no state to wait *for*.
    await page.waitForTimeout(2_500);

    await missingRow(page, 'notes').click();
    // Back on an idle action rather than on a verdict from a check the user
    // walked away from.
    await expect(recheckButton(page)).toBeEnabled();
    await expect(recheckButton(page)).toHaveText('Check again');
    await expect(anyVerdict(page)).toHaveCount(0);
  });
});

test.describe('removal, unchanged', () => {
  test.beforeEach(async ({ page }) => {
    await scenario(page, 'missing-folder');
  });

  test('removal still confirms in place, and Cancel backs out', async ({ page }) => {
    await removeButton(page).click();
    await expect(confirmPanel(page)).toBeVisible();

    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirmPanel(page)).toHaveCount(0);
    await expect(recheckButton(page)).toBeVisible();
  });

  test('Escape backs out of an armed confirmation', async ({ page }) => {
    await removeButton(page).click();
    await expect(confirmPanel(page)).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(confirmPanel(page)).toHaveCount(0);
  });

  test('Cancel takes focus, so Enter cannot fire the destructive action', async ({ page }) => {
    await removeButton(page).click();
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeFocused();
  });
});

test.describe('keyboard access', () => {
  test('the recheck and removal actions are reachable and operable by keyboard', async ({
    page,
  }) => {
    await scenario(page, 'missing-folder');
    await outcome(page, 'stays_missing');

    await recheckButton(page).focus();
    await expect(recheckButton(page)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(stillMissing(page)).toBeVisible();

    await page.keyboard.press('Tab');
    await expect(removeButton(page)).toBeFocused();
  });

  test('rail rows take focus and select without a pointer', async ({ page }) => {
    await scenario(page, 'mixed');

    // Focus is asserted before Enter is pressed, rather than assumed to have
    // stuck. `focus()` waits only for the element to be attached, and the rail's
    // rows travel under Motion layout animation while a scenario settles — so a
    // press sent immediately can land after the focused node has been replaced,
    // and select nothing. Retrying on `toBeFocused` waits for the row that is
    // actually going to receive the key.
    const row = worktreeRow(page, 10, 103);
    await expect(row).toBeVisible();
    await row.focus();
    await expect(row).toBeFocused();

    await page.keyboard.press('Enter');
    await expect(row).toHaveAttribute('aria-current', 'true');
  });
});
