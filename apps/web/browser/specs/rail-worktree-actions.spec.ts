import { expect, test, type Page } from '@playwright/test';

/**
 * The worktree row's context menu, against the production `Rail` and the same
 * fake runtime the reorder specs use.
 *
 * `worktree-menu.ts` decides *which* commands a row offers and is unit-tested on
 * its own. What only exists in a browser is the seam this page exercises: a
 * right-click on a row that is not the active one, the menu the rail renders for
 * it, and the command that click dispatches — which must target the clicked
 * worktree rather than the one that happened to be active. Opening the wrong
 * worktree would frame the wrong folder, and nothing below the click handler can
 * catch that.
 */

const row = (page: Page, source: string) => page.locator(`[data-drag-source="${source}"]`);

/**
 * Right-click a worktree's *title* row. The drag source wraps the whole block,
 * so an active worktree's expanded surface list is inside it and a centred click
 * would land on a surface — and open the surface's menu instead.
 */
const openWorktreeMenu = (page: Page, source: string) =>
  row(page, source).click({ button: 'right', position: { x: 24, y: 8 } });
const menuItem = (page: Page, name: string) => page.getByRole('menuitem', { name });

/** The worktree ids the fixture runtime was asked to open an editor for. */
const editorOpens = (page: Page) => page.evaluate(() => window.railFixture!.editorOpens());

test.beforeEach(async ({ page }) => {
  await page.goto('./');
  // The rail is behind a real query, so wait for the snapshot rather than for
  // the shell that will render an empty rail while it loads.
  await expect(row(page, 'surfaces:12#121')).toBeVisible();
});

test('Open editor targets the clicked worktree, not the active one', async ({ page }) => {
  // 12 is the active worktree — the one an ambient-context dispatch would open.
  // 13 is the row actually clicked, and the only correct target.
  await openWorktreeMenu(page, 'worktrees:1#13');
  await menuItem(page, 'Open editor').click();

  await expect.poll(() => editorOpens(page)).toEqual([13]);
  // The placement the runtime answered with is what the rail activates: the
  // clicked worktree expands, and its new editor surface is the selected row.
  await expect(row(page, 'surfaces:13#139')).toBeVisible();
  await expect(page.locator('[aria-current="true"]').filter({ hasText: 'editor' })).toBeVisible();
});

test('a worktree that is already active opens its own editor', async ({ page }) => {
  await openWorktreeMenu(page, 'worktrees:1#12');
  await menuItem(page, 'Open editor').click();

  await expect.poll(() => editorOpens(page)).toEqual([12]);
  await expect(row(page, 'surfaces:12#129')).toBeVisible();
});

test('the menu offers no editor action while the runtime cannot open one', async ({ page }) => {
  await page.evaluate(() => window.railFixture!.setEditorAvailable(false));

  await openWorktreeMenu(page, 'worktrees:1#13');
  // The rest of the menu is still there, so an empty result cannot pass for a
  // menu that simply failed to open.
  await expect(menuItem(page, 'Delete worktree')).toBeVisible();
  await expect(menuItem(page, 'Open editor')).toHaveCount(0);
});
