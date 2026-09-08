import { expect, test, type Page } from '@playwright/test';

/**
 * The folder-project fixture: presentation, availability, and same-path recovery.
 *
 * These assert the claims the mock is supposed to make, so that a later visual
 * refinement cannot quietly drop one of them. They are not a substitute for
 * looking at the page — the design questions the fixture exists to answer are
 * decided by a human — but "the word `detached` never reaches a folder" and "a
 * failed check never reports the folder absent" are facts, and facts belong here.
 *
 * Scenario and variant switching goes through the on-screen chips rather than
 * through `window.folderProjectFixture`, because those chips are the same path a
 * human uses; the fixture handle is reserved for the things no click can express.
 */

const subtitle = (page: Page, worktreeId: number) =>
  page.locator(`[data-worktree-subtitle="${worktreeId}"]`);

async function scenario(page: Page, id: string) {
  await page.locator(`[data-scenario="${id}"]`).click();
}

async function variant(page: Page, id: string) {
  await page.locator(`[data-variant="${id}"]`).click();
}

async function outcome(page: Page, id: string) {
  await page.locator(`[data-outcome="${id}"]`).click();
}

test.beforeEach(async ({ page }) => {
  await page.goto('./');
  await expect(page.locator('[data-fixture-shell]')).toBeVisible();
});

test.describe('honest presentation', () => {
  test('a folder environment is titled folder and subtitled with its path', async ({ page }) => {
    await scenario(page, 'present-folder');

    await expect(page.locator('[data-worktree-row="401"]')).toContainText('folder');
    await expect(subtitle(page, 401)).toHaveText('~/Documents/notes');
    // The word `detached` is what a folder used to inherit from `gitRef`, and
    // it was false: nothing is detached, because nothing was ever attached.
    await expect(subtitle(page, 401)).not.toContainText('detached');
  });

  test('a Git subtitle is the path alone, with no ref repeated after it', async ({ page }) => {
    await scenario(page, 'git-branch');

    // `worktreeTitle` returns the branch when there is one, so the row already
    // names it. Appending it again after the path printed the same string twice.
    await expect(page.locator('[data-worktree-row="102"]')).toContainText('feat/folders');
    await expect(subtitle(page, 102)).toHaveText('~/work/.isagi/wt/folder-projects');
    await expect(subtitle(page, 102)).not.toContainText('feat/folders');
  });

  test('the branch still reaches the status strip for a Git environment', async ({ page }) => {
    await scenario(page, 'git-branch');
    // Removed from the row, kept where it is load-bearing rather than repeated.
    await expect(page.locator('[data-branch-tag]')).toHaveText('feat/folders');
  });

  test('a detached Git worktree names its commit in the strip once selected', async ({ page }) => {
    await scenario(page, 'git-detached');

    // The narrow cost of dropping the ref from rows: a branchless worktree
    // titles itself from its basename, so its commit is not in the row at all.
    await expect(page.locator('[data-worktree-row="202"]')).toContainText('bisect');
    await expect(subtitle(page, 202)).toHaveText('~/work/.toph/wt/bisect');
    // It is not lost from the app, though — the strip still names it.
    await expect(page.locator('[data-branch-tag]')).toHaveText('9f2c1ab');
  });

  test('the status strip carries no branch tag for a folder environment', async ({ page }) => {
    await scenario(page, 'present-folder');
    await expect(page.locator('[data-branch-tag]')).toHaveCount(0);
  });

  test("today's treatment reproduces the decoration being removed", async ({ page }) => {
    await scenario(page, 'present-folder');
    await variant(page, 'show-current');

    // The "before". If this ever stops saying `detached`, the fixture has lost
    // its ability to show what the change is for.
    await expect(subtitle(page, 401)).toHaveText('~/Documents/notes · detached');
    await expect(page.locator('[data-branch-tag]')).toHaveText('detached');
  });

  test('every folder environment reads the same, and its project header names it', async ({
    page,
  }) => {
    await scenario(page, 'all-folder');

    // Three folder projects, three identically titled environments. The title is
    // a constant, so the row's own identity comes from its path and from the
    // project header above it.
    await expect(page.locator('[data-worktree-row="401"]')).toContainText('folder');
    await expect(page.locator('[data-worktree-row="501"]')).toContainText('folder');
    await expect(subtitle(page, 401)).toHaveText('~/Documents/notes');
    await expect(subtitle(page, 501)).toHaveText('~/scratch');
    await expect(page.locator('[data-project-header="40"]')).toContainText('notes');
    await expect(page.locator('[data-project-header="50"]')).toContainText('scratch');
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
    await expect(page.locator('[data-worktree-row="401"]')).toBeVisible();

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
    await expect(page.locator('[data-worktree-row="401"]')).toHaveCount(0);
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
    await expect(page.locator('[data-open-worktree="10"]')).toHaveCount(1);
    await expect(page.locator('[data-open-worktree="40"]')).toHaveCount(0);
  });

  test('the palette omits folder projects from both commands', async ({ page }) => {
    await scenario(page, 'mixed');
    await page.locator('[data-scenario="mixed"]').press('Meta+k');

    await expect(page.locator('[data-command-option="open-worktree:10"]')).toHaveCount(1);
    await expect(page.locator('[data-command-option="open-worktree:40"]')).toHaveCount(0);
  });

  test('Open worktree goes unavailable in an all-folder workspace', async ({ page }) => {
    await scenario(page, 'all-folder');
    await page.locator('[data-scenario="all-folder"]').press('Meta+k');

    await expect(page.locator('[data-command-unavailable="open-worktree"]')).toBeVisible();
  });

  test('a missing Git project keeps relocation; a missing folder does not', async ({ page }) => {
    await scenario(page, 'missing-git');
    await expect(page.locator('[data-relocate]')).toBeVisible();
    await expect(page.locator('[data-recheck]')).toHaveCount(0);

    await scenario(page, 'missing-folder');
    await expect(page.locator('[data-recheck]')).toBeVisible();
    await expect(page.locator('[data-relocate]')).toHaveCount(0);
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
    await expect(page.locator('[data-worktree-row="401"]')).toBeVisible();
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
    await page.locator('[data-worktree-row="102"]').click();
    await expect(page.locator('[data-worktree-row="102"]')).toHaveAttribute('aria-current', 'true');

    await expect(page.locator('[data-worktree-row="401"]')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('[data-worktree-row="102"]')).toHaveAttribute('aria-current', 'true');
  });

  test('a restore is silent: the canvas swap is the entire feedback', async ({ page }) => {
    await outcome(page, 'restores');
    await page.locator('[data-recheck]').click();

    await expect(page.locator('[data-worktree-row="401"]')).toBeVisible();
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
    await page.locator('[data-worktree-row="103"]').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-worktree-row="103"]')).toHaveAttribute('aria-current', 'true');
  });
});
