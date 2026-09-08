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
    await expect(page.locator('[data-recheck]')).toBeVisible();
  });

  test('re-clicking the current scenario resets a folder that was restored', async ({ page }) => {
    await scenario(page, 'missing-folder');
    await outcome(page, 'restores');
    await page.locator('[data-recheck]').click();
    await expect(rootRow(page, 40)).toBeVisible();

    await scenario(page, 'missing-folder');
    await expect(page.locator('[data-recheck]')).toBeVisible();
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
    await page.locator('[data-recheck]').click();
    await expect(page.locator('[data-verdict="still-missing"]')).toBeVisible();

    await scenario(page, 'missing-folder');
    // A verdict belonging to the previous run must not be read as belonging to
    // this one.
    await expect(page.locator('[data-verdict]')).toHaveCount(0);
    await expect(page.locator('[data-recheck]')).toBeEnabled();
  });

  test('re-clicking the current scenario clears a settled failure and an armed removal', async ({
    page,
  }) => {
    await scenario(page, 'missing-folder');
    await outcome(page, 'reconcile_fails');
    await page.locator('[data-recheck]').click();
    await expect(page.locator('[data-verdict="failed"]')).toBeVisible();

    await page.locator('[data-remove-project]').click();
    await expect(page.locator('[data-confirm-panel]')).toBeVisible();

    await scenario(page, 'missing-folder');
    await expect(page.locator('[data-verdict]')).toHaveCount(0);
    // The confirmation is component-local too, and a half-armed destructive
    // action surviving a reset is worse than a stale verdict.
    await expect(page.locator('[data-confirm-panel]')).toHaveCount(0);
    await expect(page.locator('[data-recheck]')).toBeVisible();
  });

  test('a reset is not overtaken by a recheck that was already in flight', async ({ page }) => {
    await scenario(page, 'missing-folder');
    await page.locator('[data-latency="900"]').click();
    await outcome(page, 'restores');

    await page.locator('[data-recheck]').click();
    await expect(page.locator('[data-recheck]')).toBeDisabled();

    // Reset while that restore is still in its first stage. Remounting the
    // surface clears what is on screen, but the request itself keeps going.
    await scenario(page, 'missing-folder');
    await expect(page.locator('[data-recheck]')).toBeEnabled();

    // Past both stages of the superseded request. A fixed wait, deliberately:
    // the assertion is that something never happens, so there is no state to
    // wait *for* — only a window long enough for the old work to have landed.
    await page.waitForTimeout(2_500);

    // The reset run is still missing. Without the generation guard the old
    // restore writes into the fresh snapshot and this project quietly comes
    // back, leaving a "reset" scenario in a state the reset never produced.
    await expect(page.locator('[data-recheck]')).toBeVisible();
    await expect(rootRow(page, 40)).toHaveCount(0);
    await expect(page.locator('[data-verdict]')).toHaveCount(0);
  });

  test('a verdict does not survive a round trip through another scenario', async ({ page }) => {
    await scenario(page, 'missing-folder');
    await outcome(page, 'stays_missing');
    await page.locator('[data-recheck]').click();
    await expect(page.locator('[data-verdict="still-missing"]')).toBeVisible();

    // Out to a missing *Git* project and back. Every scenario here opens on a
    // missing project, so the recovery surface never unmounts on its own along
    // the way — and the return leg is what makes this bite: asserting only at
    // the Git stop would pass without any reset at all, because a Git project
    // renders no verdict slot to leak into.
    await scenario(page, 'missing-git');
    await expect(page.locator('[data-relocate]')).toBeVisible();

    await scenario(page, 'missing-folder');
    await expect(page.locator('[data-recheck]')).toBeVisible();
    await expect(page.locator('[data-verdict]')).toHaveCount(0);
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
    await expect(page.locator('[data-relocate]')).toBeVisible();
    await expect(page.locator('[data-recheck]')).toHaveCount(0);

    await scenario(page, 'missing-folder');
    await expect(page.locator('[data-recheck]')).toBeVisible();
    await expect(page.locator('[data-relocate]')).toHaveCount(0);
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
    await page.locator('[data-recheck]').click();

    await expect(page.locator('[data-verdict="still-missing"]')).toHaveText('Still not there.');
    await expect(page.locator('[data-recheck]')).toBeEnabled();
  });

  test('a failed reconcile reports the failure and never the absence', async ({ page }) => {
    await outcome(page, 'reconcile_fails');
    await page.locator('[data-recheck]').click();

    const verdict = page.locator('[data-verdict="failed"]');
    await expect(verdict).toContainText("Couldn't finish that check.");
    // The whole point of the two-outcome split: a check that did not complete
    // must not assert a fact the read never established.
    await expect(verdict).not.toContainText('Still not there');
    await expect(page.locator('[data-verdict="still-missing"]')).toHaveCount(0);
  });

  test('a failed snapshot read after a successful reconcile also reports failure', async ({
    page,
  }) => {
    await outcome(page, 'snapshot_fails');
    await page.locator('[data-recheck]').click();

    await expect(page.locator('[data-verdict="failed"]')).toBeVisible();
    await expect(page.locator('[data-verdict="still-missing"]')).toHaveCount(0);
  });

  test('a previous verdict is cleared before the next check, not after it', async ({ page }) => {
    await outcome(page, 'stays_missing');
    await page.locator('[data-recheck]').click();
    await expect(page.locator('[data-verdict="still-missing"]')).toBeVisible();

    await page.locator('[data-latency="900"]').click();
    await page.locator('[data-recheck]').click();

    // While the new check runs, the old answer is gone rather than sitting under
    // a request that might contradict it.
    await expect(page.locator('[data-recheck]')).toHaveText('Checking…');
    await expect(page.locator('[data-verdict]')).toHaveCount(0);
  });

  test('the button is disabled while a check is in flight', async ({ page }) => {
    await page.locator('[data-latency="900"]').click();
    await outcome(page, 'stays_missing');

    const button = page.locator('[data-recheck]');
    await button.click();
    await expect(button).toBeDisabled();

    // Dispatched rather than clicked, because a real click would wait for the
    // button to become actionable and so could only ever observe the *enabled*
    // state. This asks the disabled control directly, which is the only way to
    // show that a second check is genuinely refused rather than merely delayed.
    await button.dispatchEvent('click');

    await expect(page.locator('[data-verdict="still-missing"]')).toBeVisible({ timeout: 5_000 });
    const calls = await page.evaluate(() => window.folderProjectFixture?.reconcileCalls().length);
    expect(calls).toBe(1);
  });

  test('a restored folder swaps the canvas to the same environment', async ({ page }) => {
    await outcome(page, 'restores');
    await page.locator('[data-recheck]').click();

    // Same project, same environment identity, back on the canvas — which is why
    // the action never has to touch selection.
    await expect(rootRow(page, 40)).toBeVisible();
    await expect(page.locator('[data-recheck]')).toHaveCount(0);
  });

  test('a selection made while the check is in flight survives its completion', async ({
    page,
  }) => {
    await page.locator('[data-latency="900"]').click();
    await outcome(page, 'restores');
    await page.locator('[data-recheck]').click();

    // Move to the other project's worktree mid-flight. Production selection
    // reconciliation must leave this alone when the fresh snapshot lands.
    await worktreeRow(page, 10, 102).click();
    await expect(worktreeRow(page, 10, 102)).toHaveAttribute('aria-current', 'true');

    await expect(rootRow(page, 40)).toBeVisible({ timeout: 5_000 });
    await expect(worktreeRow(page, 10, 102)).toHaveAttribute('aria-current', 'true');
  });

  test('a restore is silent: the canvas swap is the entire feedback', async ({ page }) => {
    await outcome(page, 'restores');
    await page.locator('[data-recheck]').click();

    await expect(rootRow(page, 40)).toBeVisible();
    // No banner, no toast, no lingering verdict. Every outcome of this action
    // stays at the surface that started it, and the one that removes that
    // surface says nothing at all.
    await expect(page.locator('[data-verdict]')).toHaveCount(0);
    await expect(page.locator('[role="status"]')).toHaveCount(0);
  });
});

test.describe('removal, unchanged', () => {
  test.beforeEach(async ({ page }) => {
    await scenario(page, 'missing-folder');
  });

  test('removal still confirms in place, and Cancel backs out', async ({ page }) => {
    await page.locator('[data-remove-project]').click();
    await expect(page.locator('[data-confirm-panel]')).toBeVisible();

    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.locator('[data-confirm-panel]')).toHaveCount(0);
    await expect(page.locator('[data-recheck]')).toBeVisible();
  });

  test('Escape backs out of an armed confirmation', async ({ page }) => {
    await page.locator('[data-remove-project]').click();
    await expect(page.locator('[data-confirm-panel]')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.locator('[data-confirm-panel]')).toHaveCount(0);
  });

  test('Cancel takes focus, so Enter cannot fire the destructive action', async ({ page }) => {
    await page.locator('[data-remove-project]').click();
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeFocused();
  });
});

test.describe('keyboard access', () => {
  test('the recheck and removal actions are reachable and operable by keyboard', async ({
    page,
  }) => {
    await scenario(page, 'missing-folder');
    await outcome(page, 'stays_missing');

    await page.locator('[data-recheck]').focus();
    await expect(page.locator('[data-recheck]')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-verdict="still-missing"]')).toBeVisible();

    await page.keyboard.press('Tab');
    await expect(page.locator('[data-remove-project]')).toBeFocused();
  });

  test('rail rows take focus and select without a pointer', async ({ page }) => {
    await scenario(page, 'mixed');
    await worktreeRow(page, 10, 103).focus();
    await page.keyboard.press('Enter');
    await expect(worktreeRow(page, 10, 103)).toHaveAttribute('aria-current', 'true');
  });
});
