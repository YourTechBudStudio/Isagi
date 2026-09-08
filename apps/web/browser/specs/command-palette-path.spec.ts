import { expect, test, type Locator, type Page } from '@playwright/test';

import type { ProjectPathRejectionReason, WorkflowQuestionSpecDto } from '@isagi/contracts';

/**
 * Keyboard path completion in the **production** command palette, over the fake
 * runtime in `browser/fixture/command-palette/fake-runtime.ts`.
 *
 * This is the story's integration boundary. Every earlier phase proved its own half
 * in isolation: the pure policy and the reducer under `pnpm -C apps/web test`, and
 * the real directory listing under `pnpm -C apps/runtime test`. What no unit test in
 * this repository can reach is the part that only exists in a browser — the caret, a
 * held key, an IME, focus after a click, `aria-activedescendant`, and the order two
 * responses actually arrive in. That is what lives here.
 *
 * **What this file is not evidence of.** The fake directory world is a flat list of
 * strings. It says nothing about real filesystem scope, ordering exactness, hidden
 * names, symlinks, permissions, or event-loop behaviour — `path.suggestions.test.ts`
 * owns all of that against a real filesystem. Nor does a fake rejection prove the
 * runtime validates before it inserts; that order lives in
 * `WorkspaceService.registerProject` and is asserted by the runtime's own tests.
 *
 * Three facts are kept apart throughout, because the story's claims turn on the
 * difference: a request **arrived** (`projectAddRequests()`), the fixture world
 * **changed** (`fixtureProjects()`), and the client **learned** (the palette closed).
 * "Registered exactly once" is counted from *inserted* outcomes; a rejected attempt,
 * and a reuse of an already-registered root, both appear in the request log without
 * inserting anything and must not be mistaken for a registration.
 */

const SCRIM = 'div.fixed.inset-0.z-50';
const PALETTE = `${SCRIM} > div[tabindex="-1"]`;

const palette = (page: Page) => page.locator(PALETTE);
/** The palette's single header input — the combobox on a path step. */
const input = (page: Page) => page.locator(`${PALETTE} input`);
const listbox = (page: Page) => page.locator(`${PALETTE} [role="listbox"]`);
const optionRows = (page: Page) => page.locator(`${PALETTE} [role="option"]`);

/**
 * A row located by the path it displays. The path *is* the row's meaning, so a
 * selector that stops matching means the row stopped saying where it points.
 */
const optionByPath = (page: Page, path: string) =>
  optionRows(page).filter({ has: page.locator(`span:text-is("${path}")`) });

/**
 * An element by id, as an attribute selector rather than `#id`: React's `useId`
 * mints values like `:r7:`, which are not valid CSS identifiers.
 */
const byId = (page: Page, id: string | null) => page.locator(`[id="${id ?? ''}"]`);

/** The hint paragraph, reached the way assistive technology reaches it. */
async function hintText(page: Page) {
  return byId(page, await input(page).getAttribute('aria-describedby')).textContent();
}

const fixture = {
  setPathTree: (page: Page, paths: readonly string[]) =>
    page.evaluate((value) => window.commandPaletteFixture!.setPathTree(value), paths),
  holdSuggestions: (page: Page, held: boolean) =>
    page.evaluate((value) => window.commandPaletteFixture!.holdPathSuggestions(value), held),
  releaseSuggestion: (page: Page, id: number) =>
    page.evaluate((value) => window.commandPaletteFixture!.releasePathSuggestion(value), id),
  releaseSuggestions: (page: Page) =>
    page.evaluate(() => window.commandPaletteFixture!.releasePathSuggestions()),
  failNextSuggestion: (page: Page) =>
    page.evaluate(() => window.commandPaletteFixture!.failNextSuggestion()),
  suggestionRequests: (page: Page) =>
    page.evaluate(() => window.commandPaletteFixture!.pathSuggestionRequests()),
  rejectNextProject: (page: Page, reason: ProjectPathRejectionReason) =>
    page.evaluate((value) => window.commandPaletteFixture!.rejectNextProject(value), reason),
  holdMutations: (page: Page, held: boolean) =>
    page.evaluate((value) => window.commandPaletteFixture!.holdProjectMutations(value), held),
  releaseMutations: (page: Page) =>
    page.evaluate(() => window.commandPaletteFixture!.releaseProjectMutations()),
  addRequests: (page: Page) =>
    page.evaluate(() => window.commandPaletteFixture!.projectAddRequests()),
  relocateRequests: (page: Page) =>
    page.evaluate(() => window.commandPaletteFixture!.projectRelocateRequests()),
  projects: (page: Page) => page.evaluate(() => window.commandPaletteFixture!.fixtureProjects()),
  workspaceFetchCount: (page: Page) =>
    page.evaluate(() => window.commandPaletteFixture!.workspaceFetchCount()),
  mountWorkflow: (page: Page, questions: readonly WorkflowQuestionSpecDto[]) =>
    page.evaluate(
      (value) => window.commandPaletteFixture!.mountWorkflowQuestions(value),
      questions,
    ),
  workflowSubmissions: (page: Page) =>
    page.evaluate(() => window.commandPaletteFixture!.workflowSubmissions()),
};

/**
 * Adds that inserted a project, as opposed to merely arriving, being refused, or
 * reusing a root already registered. This is what "registered exactly once" counts.
 */
async function insertedAdds(page: Page) {
  return (await fixture.addRequests(page)).filter((request) => request.outcome === 'inserted');
}

/** Open the palette and enter `Add project`, landing on its path step. */
async function openAddProject(page: Page) {
  await page.keyboard.press('ControlOrMeta+k');
  await expect(palette(page)).toBeVisible();
  await input(page).fill('Add project');
  await page.keyboard.press('Enter');
  // The combobox role is only present on a path screen, so this also asserts we
  // reached the right step rather than merely that something rendered.
  await expect(input(page)).toHaveAttribute('role', 'combobox');
  await expect(input(page)).toHaveValue('');
}

/** Open `Set project path`, whose first step is a select over missing projects. */
async function openRelocateProject(page: Page) {
  await page.keyboard.press('ControlOrMeta+k');
  await expect(palette(page)).toBeVisible();
  await input(page).fill('Set project path');
  await page.keyboard.press('Enter');
}

/**
 * Type into the focused input one key at a time, so every keystroke produces the
 * real `keydown` the palette's handlers read. `fill()` would set the value without
 * any of them, which would quietly skip the entire "/" routing this story is about.
 */
async function typePath(page: Page, text: string) {
  await input(page).pressSequentially(text);
}

/**
 * A row's two lines of text. The row renders a glyph, then a wrapper holding the
 * directory name over its full path, then an optional `hidden` badge — so the two
 * lines are exactly the spans nested inside another span.
 */
const rowLabel = (row: Locator) => row.locator('span > span').nth(0);
const rowPath = (row: Locator) => row.locator('span > span').nth(1);

/** Wait until the visible rows belong to the current buffer rather than an older one. */
async function expectFreshRows(page: Page, paths: readonly string[]) {
  await expect(optionRows(page)).toHaveCount(paths.length);
  for (const [index, path] of paths.entries()) {
    await expect(rowPath(optionRows(page).nth(index))).toHaveText(path);
  }
}

const HIGHLIGHTED = /border-blue/;

test.beforeEach(async ({ page }) => {
  await page.goto('./');
  await expect(page.locator('[data-fixture-shell]')).toBeVisible();
});

// --- AC1: suggestions come from the runtime, verbatim ------------------------

test('AC1 lists runtime suggestions for a typed partial path', async ({ page }) => {
  await openAddProject(page);
  await typePath(page, '~/work/i');

  await expectFreshRows(page, ['~/work/inbox', '~/work/isagi', '~/work/isagi-web']);
  // The label is the directory name; the path underneath is the runtime's own
  // spelling and is what a submission will carry.
  await expect(rowLabel(optionByPath(page, '~/work/isagi'))).toHaveText('isagi');
});

test('AC1 keeps tilde and outside-home payloads verbatim in both directions', async ({ page }) => {
  await openAddProject(page);
  await typePath(page, '/srv/d');
  await expectFreshRows(page, ['/srv/deploy']);

  const requests = await fixture.suggestionRequests(page);
  // The web must never expand, normalise, or re-root these strings: a remote
  // runtime's `~` is not this machine's home, which is exactly why the round trip
  // has to stay byte-identical.
  expect(requests.at(-1)?.input).toBe('/srv/d');

  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(input(page)).toHaveValue('/srv/deploy');
  // Polled, not read once: the accepted buffer's own listing is debounced by 80 ms,
  // so reading the log immediately would assert that the future has not happened.
  await expect
    .poll(async () => (await fixture.suggestionRequests(page)).at(-1)?.input)
    .toBe('/srv/deploy');
});

// --- AC2: cycling never registers or edits ------------------------------------

test('AC2 Tab, Shift+Tab, Down and Up cycle without touching the buffer', async ({ page }) => {
  await openAddProject(page);
  await typePath(page, '~/work/i');
  await expectFreshRows(page, ['~/work/inbox', '~/work/isagi', '~/work/isagi-web']);

  const requestsBefore = (await fixture.suggestionRequests(page)).length;
  // Rows arrive with nothing highlighted: the automatic first-row selection is
  // gone, which is what makes a typed path submittable in one Enter (AC7).
  await expect(page.locator(`${PALETTE} [aria-selected="true"]`)).toHaveCount(0);

  await page.keyboard.press('Tab');
  await expect(optionByPath(page, '~/work/inbox')).toHaveClass(HIGHLIGHTED);
  await page.keyboard.press('ArrowDown');
  await expect(optionByPath(page, '~/work/isagi')).toHaveClass(HIGHLIGHTED);
  await page.keyboard.press('Tab');
  await expect(optionByPath(page, '~/work/isagi-web')).toHaveClass(HIGHLIGHTED);
  // Forward off the end wraps to the first row.
  await page.keyboard.press('Tab');
  await expect(optionByPath(page, '~/work/inbox')).toHaveClass(HIGHLIGHTED);
  await page.keyboard.press('Shift+Tab');
  await expect(optionByPath(page, '~/work/isagi-web')).toHaveClass(HIGHLIGHTED);
  await page.keyboard.press('ArrowUp');
  await expect(optionByPath(page, '~/work/isagi')).toHaveClass(HIGHLIGHTED);

  await expect(input(page)).toHaveValue('~/work/i');
  expect((await fixture.suggestionRequests(page)).length).toBe(requestsBefore);
  expect(await fixture.addRequests(page)).toHaveLength(0);
});

test('AC2 backward entry from no highlight lands on the last row', async ({ page }) => {
  await openAddProject(page);
  await typePath(page, '~/work/i');
  await expectFreshRows(page, ['~/work/inbox', '~/work/isagi', '~/work/isagi-web']);

  await page.keyboard.press('Shift+Tab');
  await expect(optionByPath(page, '~/work/isagi-web')).toHaveClass(HIGHLIGHTED);
  expect(await fixture.addRequests(page)).toHaveLength(0);
});

test('AC2 a single-row result still wraps to an explicit highlight', async ({ page }) => {
  await openAddProject(page);
  await typePath(page, '~/solo/o');
  await expectFreshRows(page, ['~/solo/only-child']);

  await page.keyboard.press('Tab');
  await expect(optionByPath(page, '~/solo/only-child')).toHaveClass(HIGHLIGHTED);
  // Wrapping a one-row list is a no-op that must still leave the highlight *set* —
  // otherwise the next Enter would submit instead of accept.
  await page.keyboard.press('Tab');
  await expect(optionByPath(page, '~/solo/only-child')).toHaveClass(HIGHLIGHTED);
  expect(await hintText(page)).toContain('fill the highlighted folder');
});

// --- AC3 / AC4: accept, then submit -------------------------------------------

test('AC3 Enter over a highlight fills the buffer and registers nothing', async ({ page }) => {
  await openAddProject(page);
  await typePath(page, '~/work/i');
  await expectFreshRows(page, ['~/work/inbox', '~/work/isagi', '~/work/isagi-web']);

  await page.keyboard.press('Tab');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');

  await expect(input(page)).toHaveValue('~/work/isagi');
  await expect(palette(page)).toBeVisible();
  expect(await fixture.addRequests(page)).toHaveLength(0);
  // The highlight is cleared by the acceptance, so the *next* Enter submits.
  await expect(page.locator(`${PALETTE} [aria-selected="true"]`)).toHaveCount(0);
  await expect(input(page)).not.toHaveAttribute('aria-activedescendant', /./);
});

test('AC3 an explicitly selected equal path still accepts, without a new request', async ({
  page,
}) => {
  await openAddProject(page);
  await typePath(page, '~/work/notes');
  await expectFreshRows(page, ['~/work/notes']);
  const requestsBefore = (await fixture.suggestionRequests(page)).length;

  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');

  // Navigating onto a row is still browsing, even when it says what the buffer
  // says — so Enter accepts rather than submits, and the buffer did not move, so
  // there is nothing new to ask the runtime for.
  await expect(palette(page)).toBeVisible();
  expect(await fixture.addRequests(page)).toHaveLength(0);
  expect((await fixture.suggestionRequests(page)).length).toBe(requestsBefore);
  await expect(input(page)).toHaveValue('~/work/notes');
});

test('AC4 the next distinct Enter registers exactly once and closes the palette', async ({
  page,
}) => {
  await openAddProject(page);
  await typePath(page, '~/work/i');
  await expectFreshRows(page, ['~/work/inbox', '~/work/isagi', '~/work/isagi-web']);

  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(input(page)).toHaveValue('~/work/isagi');

  // Counted before the mutation, so the assertion below is about reads that
  // happen *because* of it.
  const readsBefore = await fixture.workspaceFetchCount(page);
  await page.keyboard.press('Enter');
  await expect(palette(page)).toBeHidden();

  const inserted = await insertedAdds(page);
  expect(inserted).toHaveLength(1);
  expect(inserted[0]?.path).toBe('~/work/isagi');
  // Server state, not palette closure, is what proves a registration happened.
  const projects = await fixture.projects(page);
  expect(projects.map((project) => project.rootPath)).toContain('~/work/isagi');
  // And the client went back and looked. Without this the test would still pass
  // if `commitAddProjectSuccess` stopped invalidating the workspace query — the
  // fixture's own array would have changed and nothing would have read it.
  await expect.poll(() => fixture.workspaceFetchCount(page)).toBeGreaterThan(readsBefore);
});

test('a duplicate submission reuses the registered root instead of inserting again', async ({
  page,
}) => {
  await openAddProject(page);
  await typePath(page, '~/work/notes');
  await expectFreshRows(page, ['~/work/notes']);
  await page.keyboard.press('Enter');
  await expect(palette(page)).toBeHidden();
  expect(await insertedAdds(page)).toHaveLength(1);

  // Submitting the same root again answers successfully and changes nothing. One
  // project in the list cannot distinguish this from a request that never
  // happened, which is exactly why arrival and outcome are recorded separately.
  await openAddProject(page);
  await typePath(page, '~/work/notes');
  await expectFreshRows(page, ['~/work/notes']);
  await page.keyboard.press('Enter');
  await expect(palette(page)).toBeHidden();

  const requests = await fixture.addRequests(page);
  expect(requests.map((request) => request.outcome)).toEqual(['inserted', 'reused']);
  expect(requests[0]?.projectId).toBe(requests[1]?.projectId);
  expect(
    (await fixture.projects(page)).filter((project) => project.rootPath === '~/work/notes'),
  ).toHaveLength(1);
});

test('AC4 submission does not wait for the accepted folder’s children', async ({ page }) => {
  await openAddProject(page);
  await typePath(page, '~/work/i');
  await expectFreshRows(page, ['~/work/inbox', '~/work/isagi', '~/work/isagi-web']);

  // Hold every further listing, so the children of the accepted folder never
  // arrive. The window between accepting and their arrival is exactly where the
  // second Enter lands in real use.
  await fixture.holdSuggestions(page, true);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(input(page)).toHaveValue('~/work/isagi');
  // The hint survives the in-flight window: the sentence describing Enter is
  // exactly what the user needs while the panel is searching.
  expect(await hintText(page)).toContain('Press enter to use this path.');

  await page.keyboard.press('Enter');
  await expect(palette(page)).toBeHidden();
  expect(await insertedAdds(page)).toHaveLength(1);
});

// --- AC5: editing and navigating invalidate the prior intent -------------------

test('AC5 accept, navigate, Enter accepts again without registering', async ({ page }) => {
  await openAddProject(page);
  await typePath(page, '~/work/i');
  await expectFreshRows(page, ['~/work/inbox', '~/work/isagi', '~/work/isagi-web']);

  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(input(page)).toHaveValue('~/work/inbox');
  // The buffer moved, so a fresh listing lands and rows are selectable again. A
  // complete path filters its own parent, so the folder matches *itself* here —
  // only a trailing separator would list its children.
  await expectFreshRows(page, ['~/work/inbox']);

  // Navigating after an acceptance makes Enter accept again rather than submit,
  // even onto the very path the buffer already holds.
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');

  await expect(palette(page)).toBeVisible();
  expect(await fixture.addRequests(page)).toHaveLength(0);
});

test('AC5 accept, edit, Enter submits the edited text', async ({ page }) => {
  await openAddProject(page);
  await typePath(page, '~/work/i');
  await expectFreshRows(page, ['~/work/inbox', '~/work/isagi', '~/work/isagi-web']);

  await page.keyboard.press('Tab');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(input(page)).toHaveValue('~/work/isagi');

  // An edit invalidates the accepted intent: Enter now targets what is on screen.
  await typePath(page, '-web');
  await page.keyboard.press('Enter');
  await expect(palette(page)).toBeHidden();

  const inserted = await insertedAdds(page);
  expect(inserted).toHaveLength(1);
  expect(inserted[0]?.path).toBe('~/work/isagi-web');
});

test('AC5 editing away and back does not resurrect a cleared highlight', async ({ page }) => {
  await openAddProject(page);
  await typePath(page, '~/work/i');
  await expectFreshRows(page, ['~/work/inbox', '~/work/isagi', '~/work/isagi-web']);

  await page.keyboard.press('Tab');
  await expect(optionByPath(page, '~/work/inbox')).toHaveClass(HIGHLIGHTED);
  await typePath(page, 'n');
  await expectFreshRows(page, ['~/work/inbox']);
  await page.keyboard.press('Backspace');
  await expectFreshRows(page, ['~/work/inbox', '~/work/isagi', '~/work/isagi-web']);

  // Back at the same buffer with the same rows — and still no highlight, because
  // there is no replacement history to restore one from.
  await expect(page.locator(`${PALETTE} [aria-selected="true"]`)).toHaveCount(0);
  expect(await hintText(page)).toContain('Press enter to use this path.');
});

// --- AC6: slash descent --------------------------------------------------------

test('AC6 slash over a highlight descends with exactly one separator', async ({ page }) => {
  await openAddProject(page);
  await typePath(page, '~/work/is');
  await expectFreshRows(page, ['~/work/isagi', '~/work/isagi-web']);

  await page.keyboard.press('Tab');
  await page.keyboard.press('/');

  await expect(input(page)).toHaveValue('~/work/isagi/');
  await expectFreshRows(page, ['~/work/isagi/apps', '~/work/isagi/packages']);
  // Children arrive unhighlighted, like every other result.
  await expect(page.locator(`${PALETTE} [aria-selected="true"]`)).toHaveCount(0);
});

test('AC6 descent wins over the caret position', async ({ page }) => {
  await openAddProject(page);
  await typePath(page, '~/work/is');
  await expectFreshRows(page, ['~/work/isagi', '~/work/isagi-web']);

  await page.keyboard.press('Tab');
  // Caret to the very start: with a highlight, "/" is an operation on the
  // highlighted directory wherever the caret happens to sit.
  await page.keyboard.press('Home');
  await page.keyboard.press('/');
  await expect(input(page)).toHaveValue('~/work/isagi/');
});

test('AC6 a duplicate end slash is swallowed and mid-buffer edits stay ordinary', async ({
  page,
}) => {
  await openAddProject(page);
  await typePath(page, '~/work/');
  await expectFreshRows(page, ['~/work/inbox', '~/work/isagi', '~/work/isagi-web', '~/work/notes']);

  // No highlight, collapsed caret at the end, buffer already ends in "/": the
  // second separator would be noise, so it never reaches the value.
  await page.keyboard.press('/');
  await expect(input(page)).toHaveValue('~/work/');

  // A collapsed caret in the middle of the buffer is ordinary editing.
  await input(page).fill('~/work/notes');
  await expectFreshRows(page, ['~/work/notes']);
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('/');
  await expect(input(page)).toHaveValue('~//work/notes');

  // So is a *range* selection, even one whose end sits at the end of a buffer
  // that ends in "/" — the swallow rule requires a collapsed caret, and replacing
  // selected text is a different intent from appending a separator.
  await input(page).fill('~/work/');
  await expectFreshRows(page, ['~/work/inbox', '~/work/isagi', '~/work/isagi-web', '~/work/notes']);
  await page.keyboard.press('End');
  await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.press('/');
  await expect(input(page)).toHaveValue('~/wor/');
});

test('AC6 root stays a single slash', async ({ page }) => {
  await openAddProject(page);
  await typePath(page, '/');
  await expectFreshRows(page, ['/srv', '/tmp']);

  // With no highlight, "/" at the end of a buffer that already ends in one is
  // swallowed — and at root that buffer *is* the separator, so it must not become
  // "//".
  await page.keyboard.press('/');
  await expect(input(page)).toHaveValue('/');
  await expectFreshRows(page, ['/srv', '/tmp']);

  // Navigation moves the highlight without touching the buffer.
  await page.keyboard.press('Tab');
  await expect(optionByPath(page, '/srv')).toHaveClass(HIGHLIGHTED);
  await page.keyboard.press('ArrowUp');
  await expect(optionByPath(page, '/tmp')).toHaveClass(HIGHLIGHTED);
  await expect(input(page)).toHaveValue('/');

  // Descending from root produces one separator, not two.
  await page.keyboard.press('/');
  await expect(input(page)).toHaveValue('/tmp/');
});

test('AC6 modified slash never descends', async ({ page }) => {
  await openAddProject(page);
  await typePath(page, '~/work/is');
  await expectFreshRows(page, ['~/work/isagi', '~/work/isagi-web']);
  await page.keyboard.press('Tab');

  // Meta/Ctrl/Alt are the deliberate escape hatch: a modified "/" is never a
  // completion gesture, so the highlight and the buffer both stand.
  await page.keyboard.press('Meta+/');
  await page.keyboard.press('Control+/');
  await page.keyboard.press('Alt+/');
  await expect(input(page)).toHaveValue('~/work/is');
  await expect(optionByPath(page, '~/work/isagi')).toHaveClass(HIGHLIGHTED);

  // An unmodified "/" still descends afterwards, so the guard did not disable it.
  await page.keyboard.press('/');
  await expect(input(page)).toHaveValue('~/work/isagi/');
});

// --- AC7: a typed directory submits itself ------------------------------------

test('AC7 a typed trailing-slash directory submits itself, not a child', async ({ page }) => {
  await openAddProject(page);
  await typePath(page, '~/work/isagi/');
  await expectFreshRows(page, ['~/work/isagi/apps', '~/work/isagi/packages']);

  // Children are listed and none is highlighted, so one Enter submits the folder
  // the user actually typed.
  await page.keyboard.press('Enter');
  await expect(palette(page)).toBeHidden();

  const inserted = await insertedAdds(page);
  expect(inserted).toHaveLength(1);
  expect(inserted[0]?.path).toBe('~/work/isagi/');
});

test('AC7 no matches, a stale list, and a listing error all still submit', async ({ page }) => {
  await openAddProject(page);

  // No matches at all.
  await typePath(page, '~/work/zzz');
  await expect(optionRows(page)).toHaveCount(0);
  expect(await hintText(page)).toContain('Press enter to use this path.');

  // A listing failure replaces the rows but not the buffer or the hint.
  await input(page).fill('');
  await fixture.failNextSuggestion(page);
  await typePath(page, '~/work/notes');
  await expect(page.locator(`${PALETTE} p.text-error`)).toBeVisible();
  expect(await hintText(page)).toContain('Press enter to use this path.');
  // The listbox the combobox points at must still exist in the error state.
  await expect(listbox(page)).toHaveCount(1);

  await page.keyboard.press('Enter');
  await expect(palette(page)).toBeHidden();
  const inserted = await insertedAdds(page);
  expect(inserted).toHaveLength(1);
  expect(inserted[0]?.path).toBe('~/work/notes');
});

// --- AC8: rejection is visible and registers nothing ---------------------------

for (const [reason, copy] of [
  ['path_not_found', "There's nothing at that path."],
  ['permission_denied', "Isagi isn't allowed to read that path."],
  ['not_git_repository', "That folder isn't a Git repository."],
] as const) {
  test(`AC8 a ${reason} rejection is shown and registers nothing`, async ({ page }) => {
    await openAddProject(page);
    await fixture.rejectNextProject(page, reason);
    await typePath(page, '~/work/notes');
    await expectFreshRows(page, ['~/work/notes']);
    await page.keyboard.press('Enter');

    await expect(page.locator(`${PALETTE} p.text-error`)).toHaveText(copy);
    await expect(palette(page)).toBeVisible();
    await expect(input(page)).toHaveValue('~/work/notes');

    // The attempt is in the log — it really was sent — but its outcome is a
    // refusal and nothing was inserted. Those are three separate facts and only
    // the last two are the claim.
    const requests = await fixture.addRequests(page);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.outcome).toBe('rejected');
    expect(requests[0]?.projectId).toBeNull();
    const projects = await fixture.projects(page);
    expect(projects.map((project) => project.rootPath)).not.toContain('~/work/notes');
  });
}

test('AC8 correcting a rejected path and retrying succeeds', async ({ page }) => {
  await openAddProject(page);
  await fixture.rejectNextProject(page, 'not_repository_root');
  await typePath(page, '~/work/notes');
  await expectFreshRows(page, ['~/work/notes']);
  await page.keyboard.press('Enter');
  await expect(page.locator(`${PALETTE} p.text-error`)).toBeVisible();

  // Accepting a different folder clears the rejection: it described a path the
  // buffer no longer holds.
  await input(page).fill('~/work/is');
  await expectFreshRows(page, ['~/work/isagi', '~/work/isagi-web']);
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(page.locator(`${PALETTE} p.text-error`)).toHaveCount(0);

  await page.keyboard.press('Enter');
  await expect(palette(page)).toBeHidden();
  const inserted = await insertedAdds(page);
  expect(inserted).toHaveLength(1);
  expect(inserted[0]?.path).toBe('~/work/isagi');
});

// --- Pointer policy ------------------------------------------------------------

test('a differing row click fills the buffer and leaves focus in the input', async ({ page }) => {
  await openAddProject(page);
  await typePath(page, '~/work/i');
  await expectFreshRows(page, ['~/work/inbox', '~/work/isagi', '~/work/isagi-web']);

  await optionByPath(page, '~/work/isagi').click();
  await expect(input(page)).toHaveValue('~/work/isagi');
  expect(await fixture.addRequests(page)).toHaveLength(0);

  // The row's `onMouseDown` preventDefault is what keeps focus here; without it the
  // buffer a click just filled would not be typable.
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('INPUT');
  await page.keyboard.press('Enter');
  await expect(palette(page)).toBeHidden();
  expect(await insertedAdds(page)).toHaveLength(1);
});

test('an equal-path row click submits immediately', async ({ page }) => {
  await openAddProject(page);
  await typePath(page, '~/work/notes');
  await expectFreshRows(page, ['~/work/notes']);

  // Pointing at a row that already says what the buffer says is a decision, not
  // browsing — deliberately the opposite of Enter over the same row.
  await optionByPath(page, '~/work/notes').click();
  await expect(palette(page)).toBeHidden();
  const inserted = await insertedAdds(page);
  expect(inserted).toHaveLength(1);
  expect(inserted[0]?.path).toBe('~/work/notes');
});

test('equality is by path text, so it survives a result replacement', async ({ page }) => {
  await openAddProject(page);
  await typePath(page, '~/work/i');
  await expectFreshRows(page, ['~/work/inbox', '~/work/isagi', '~/work/isagi-web']);

  await optionByPath(page, '~/work/isagi').click();
  await expect(input(page)).toHaveValue('~/work/isagi');
  // A brand new result set, whose first row happens to say what the buffer now
  // says. Row identity and the earlier click on a row of the *previous* set are
  // both irrelevant; only the path text decides what this click means.
  await expectFreshRows(page, ['~/work/isagi', '~/work/isagi-web']);

  await optionByPath(page, '~/work/isagi').click();
  await expect(palette(page)).toBeHidden();
  expect(await insertedAdds(page)).toHaveLength(1);
});

test('hover never creates a keyboard highlight and stale rows cannot activate', async ({
  page,
}) => {
  await openAddProject(page);
  await typePath(page, '~/work/i');
  await expectFreshRows(page, ['~/work/inbox', '~/work/isagi', '~/work/isagi-web']);

  await optionByPath(page, '~/work/isagi').hover();
  await expect(page.locator(`${PALETTE} [aria-selected="true"]`)).toHaveCount(0);
  await expect(input(page)).not.toHaveAttribute('aria-activedescendant', /./);

  // Now make the rows stale by typing while the next listing is held. Unlike the
  // busy window, these rows are on screen, so this is where a forbidden pointer
  // activation could actually happen. `force` skips Playwright's actionability
  // wait so the attempt is really made; the browser then refuses to dispatch a
  // click on a `disabled` button, which is the mechanism under test — the
  // assertions below confirm nothing moved as a result.
  await fixture.holdSuggestions(page, true);
  await typePath(page, 's');
  await expect(optionRows(page).first()).toBeDisabled();
  const suggestionsBefore = (await fixture.suggestionRequests(page)).length;

  await optionByPath(page, '~/work/isagi').click({ force: true });

  // Buffer and highlight are both asserted, not just the request count: a stale
  // row that wrongly activated would *accept* — filling the buffer and issuing a
  // listing — without ever sending an add request, so counting registrations
  // alone would not notice.
  await expect(input(page)).toHaveValue('~/work/is');
  await expect(page.locator(`${PALETTE} [aria-selected="true"]`)).toHaveCount(0);
  await expect(input(page)).not.toHaveAttribute('aria-activedescendant', /./);
  expect((await fixture.suggestionRequests(page)).length).toBe(suggestionsBefore);
  expect(await fixture.addRequests(page)).toHaveLength(0);
});

// --- Request ordering ----------------------------------------------------------

test('stale rows are inert to the keyboard and carry no active descendant', async ({ page }) => {
  await openAddProject(page);
  await typePath(page, '~/work/i');
  await expectFreshRows(page, ['~/work/inbox', '~/work/isagi', '~/work/isagi-web']);

  await fixture.holdSuggestions(page, true);
  await typePath(page, 's');
  await expect(optionRows(page).first()).toBeDisabled();

  await page.keyboard.press('Tab');
  await page.keyboard.press('ArrowDown');
  await expect(page.locator(`${PALETTE} [aria-selected="true"]`)).toHaveCount(0);
  await expect(input(page)).not.toHaveAttribute('aria-activedescendant', /./);
  await expect(input(page)).toHaveValue('~/work/is');

  // Enter over a stale list submits the buffer rather than a row: there is no
  // resolvable highlight to accept.
  await page.keyboard.press('Enter');
  await expect(palette(page)).toBeHidden();
  expect((await insertedAdds(page))[0]?.path).toBe('~/work/is');
});

test('a late response cannot replace a newer one', async ({ page }) => {
  await openAddProject(page);
  await fixture.holdSuggestions(page, true);

  await typePath(page, '~/work/i');
  await expect
    .poll(async () => (await fixture.suggestionRequests(page)).some((r) => r.input === '~/work/i'))
    .toBe(true);
  const first = (await fixture.suggestionRequests(page)).find((r) => r.input === '~/work/i')!;

  await typePath(page, 'nb');
  await expect
    .poll(async () =>
      (await fixture.suggestionRequests(page)).some((r) => r.input === '~/work/inb'),
    )
    .toBe(true);
  const second = (await fixture.suggestionRequests(page)).find((r) => r.input === '~/work/inb')!;

  // Deliver them in reverse. The older attempt is discarded by the reducer's
  // attempt guard, so the newer, narrower result stands.
  await fixture.releaseSuggestion(page, second.id);
  await expectFreshRows(page, ['~/work/inbox']);
  await fixture.releaseSuggestion(page, first.id);
  await expectFreshRows(page, ['~/work/inbox']);
  await expect(input(page)).toHaveValue('~/work/inb');
});

test('a late failure cannot overwrite a newer success', async ({ page }) => {
  await openAddProject(page);
  await fixture.holdSuggestions(page, true);
  await fixture.failNextSuggestion(page);

  await typePath(page, '~/work/i');
  await expect
    .poll(async () => (await fixture.suggestionRequests(page)).some((r) => r.input === '~/work/i'))
    .toBe(true);
  const failing = (await fixture.suggestionRequests(page)).find((r) => r.input === '~/work/i')!;

  await typePath(page, 'nb');
  await expect
    .poll(async () =>
      (await fixture.suggestionRequests(page)).some((r) => r.input === '~/work/inb'),
    )
    .toBe(true);
  const succeeding = (await fixture.suggestionRequests(page)).find(
    (r) => r.input === '~/work/inb',
  )!;

  await fixture.releaseSuggestion(page, succeeding.id);
  await expectFreshRows(page, ['~/work/inbox']);
  await fixture.releaseSuggestion(page, failing.id);
  // The superseded failure belongs to a request nobody is waiting for.
  await expect(page.locator(`${PALETTE} p.text-error`)).toHaveCount(0);
  await expectFreshRows(page, ['~/work/inbox']);
});

test('a late success cannot overwrite a newer failure', async ({ page }) => {
  await openAddProject(page);
  await fixture.holdSuggestions(page, true);

  await typePath(page, '~/work/i');
  await expect
    .poll(async () => (await fixture.suggestionRequests(page)).some((r) => r.input === '~/work/i'))
    .toBe(true);
  const succeeding = (await fixture.suggestionRequests(page)).find((r) => r.input === '~/work/i')!;

  // The newer attempt is the one that fails.
  await fixture.failNextSuggestion(page);
  await typePath(page, 'nb');
  await expect
    .poll(async () =>
      (await fixture.suggestionRequests(page)).some((r) => r.input === '~/work/inb'),
    )
    .toBe(true);
  const failing = (await fixture.suggestionRequests(page)).find((r) => r.input === '~/work/inb')!;

  await fixture.releaseSuggestion(page, failing.id);
  await expect(page.locator(`${PALETTE} p.text-error`)).toBeVisible();

  // The superseded success must not clear the newer error or repopulate the rows.
  // This is the mirror of the failure-after-success case: the attempt guard has to
  // discard a stale result whichever way it settled.
  await fixture.releaseSuggestion(page, succeeding.id);
  await expect(page.locator(`${PALETTE} p.text-error`)).toBeVisible();
  await expect(optionRows(page)).toHaveCount(0);
  await expect(input(page)).toHaveValue('~/work/inb');
});

test('a same-length replacement still clears the highlight', async ({ page }) => {
  await openAddProject(page);
  await typePath(page, '~/work/is');
  await expectFreshRows(page, ['~/work/isagi', '~/work/isagi-web']);
  await page.keyboard.press('Tab');
  await expect(optionByPath(page, '~/work/isagi')).toHaveClass(HIGHLIGHTED);

  // A replacement result of the same length: an index-preserving implementation
  // would leave the highlight pointing at a different directory.
  await fixture.setPathTree(page, ['~/work', '~/work/issue-1', '~/work/issue-2']);
  await input(page).fill('~/work/iss');
  await expectFreshRows(page, ['~/work/issue-1', '~/work/issue-2']);
  await expect(page.locator(`${PALETTE} [aria-selected="true"]`)).toHaveCount(0);
});

test('closing and reopening cannot revive a previous interaction', async ({ page }) => {
  await openAddProject(page);
  await fixture.holdSuggestions(page, true);
  await typePath(page, '~/work/i');
  await expect.poll(async () => (await fixture.suggestionRequests(page)).length).toBeGreaterThan(0);

  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(palette(page)).toBeHidden();

  // The held response lands after the step is gone. It must not revive it.
  await fixture.releaseSuggestions(page);
  await expect(palette(page)).toBeHidden();

  await fixture.holdSuggestions(page, false);
  await openAddProject(page);
  await expect(input(page)).toHaveValue('');
  await expect(page.locator(`${PALETTE} [aria-selected="true"]`)).toHaveCount(0);
  expect(await fixture.addRequests(page)).toHaveLength(0);
});

test('a suggestion landing during a held run cannot revive or retarget it', async ({ page }) => {
  await openAddProject(page);
  await typePath(page, '~/work/is');
  await expectFreshRows(page, ['~/work/isagi', '~/work/isagi-web']);

  // Arrange a suggestion that has not been delivered yet, then start a run and
  // hold its acknowledgement open.
  await fixture.holdSuggestions(page, true);
  await typePath(page, 'a');
  await expect
    .poll(async () =>
      (await fixture.suggestionRequests(page)).some((r) => r.input === '~/work/isa'),
    )
    .toBe(true);
  const pending = (await fixture.suggestionRequests(page)).find((r) => r.input === '~/work/isa')!;

  await fixture.holdMutations(page, true);
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await fixture.addRequests(page)).length).toBe(1);

  // Now let the listing land *inside* the busy window. It must not repopulate a
  // selectable list, create a highlight, or retarget the run that is in flight.
  await fixture.releaseSuggestion(page, pending.id);
  await expect(page.locator(`${PALETTE} [aria-selected="true"]`)).toHaveCount(0);

  // Pointer activation during a run is not merely ignored — there is nothing to
  // activate. The running panel replaces the whole body, so no row, and not even
  // the input, is on screen. That is a stronger guarantee than an ignored click,
  // and it is why this test asserts absence rather than force-clicking: a
  // conditional click on a row that never exists would pass while proving
  // nothing. Busy rows that *are* present and disabled is the stale case, which
  // has its own test above.
  await expect(optionRows(page)).toHaveCount(0);
  await expect(page.locator(`${PALETTE} input`)).toHaveCount(0);
  await expect(page.locator(`${PALETTE} button`)).toHaveCount(0);
  await expect(palette(page)).toContainText('Working…');

  // Keys are inert too, and neither reaches the command.
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  expect(await fixture.addRequests(page)).toHaveLength(1);

  await fixture.releaseMutations(page);
  await expect(palette(page)).toBeHidden();
  const inserted = await insertedAdds(page);
  expect(inserted).toHaveLength(1);
  // The run targets the buffer as it stood when Enter was pressed, not the list
  // that arrived afterwards.
  expect(inserted[0]?.path).toBe('~/work/isa');
});

// --- Input safety ---------------------------------------------------------------

test('a held Enter cannot accept and then submit', async ({ page }) => {
  await openAddProject(page);
  await typePath(page, '~/work/i');
  await expectFreshRows(page, ['~/work/inbox', '~/work/isagi', '~/work/isagi-web']);
  await page.keyboard.press('Tab');

  // One physical press that auto-repeats: `keydown` fires repeatedly, and only the
  // first may act. Without the repeat guard this accepts and then registers.
  await page.keyboard.down('Enter');
  await page.evaluate(() => {
    const element = document.activeElement as HTMLElement;
    for (let index = 0; index < 4; index += 1) {
      element.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', repeat: true, bubbles: true }),
      );
    }
  });
  await page.keyboard.up('Enter');

  await expect(input(page)).toHaveValue('~/work/inbox');
  await expect(palette(page)).toBeVisible();
  expect(await fixture.addRequests(page)).toHaveLength(0);
});

test('an IME composition never commits the step', async ({ page }) => {
  await openAddProject(page);
  await typePath(page, '~/work/i');
  await expectFreshRows(page, ['~/work/inbox', '~/work/isagi', '~/work/isagi-web']);
  await page.keyboard.press('Tab');

  await page.evaluate(() => {
    const element = document.activeElement as HTMLElement;
    element.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true }),
    );
    element.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }),
    );
  });

  // Neither the accept nor the submit happened: a composing editor's Enter is the
  // editor's, not the palette's.
  await expect(input(page)).toHaveValue('~/work/i');
  await expect(palette(page)).toBeVisible();
  expect(await fixture.addRequests(page)).toHaveLength(0);

  // A distinct, non-composing Enter still works afterwards.
  await page.keyboard.press('Enter');
  await expect(input(page)).toHaveValue('~/work/inbox');
});

// --- Accessibility ---------------------------------------------------------------

test('the path input is a named combobox wired to its listbox and hint', async ({ page }) => {
  await openAddProject(page);
  await typePath(page, '~/work/i');
  await expectFreshRows(page, ['~/work/inbox', '~/work/isagi', '~/work/isagi-web']);

  await expect(input(page)).toHaveAttribute('role', 'combobox');
  await expect(input(page)).toHaveAttribute('aria-autocomplete', 'list');
  await expect(input(page)).toHaveAttribute('aria-expanded', 'true');
  // The label is visually a label but associated with nothing, so the combobox
  // carries the same string as its name.
  await expect(input(page)).toHaveAttribute('aria-label', 'Project root path');

  const listId = await input(page).getAttribute('aria-controls');
  await expect(byId(page, listId)).toHaveAttribute('role', 'listbox');
  expect(await hintText(page)).toContain('Press enter to use this path.');

  // Not a live region: the active descendant already announces each move, and
  // this sentence changes on every keystroke.
  await expect(input(page)).not.toHaveAttribute('aria-live', /./);
  const hintId = await input(page).getAttribute('aria-describedby');
  await expect(byId(page, hintId)).not.toHaveAttribute('aria-live', /./);
});

test('the active descendant follows the highlight and exactly one option is selected', async ({
  page,
}) => {
  await openAddProject(page);
  await typePath(page, '~/work/i');
  await expectFreshRows(page, ['~/work/inbox', '~/work/isagi', '~/work/isagi-web']);

  await page.keyboard.press('Tab');
  const active = await input(page).getAttribute('aria-activedescendant');
  expect(active).toBeTruthy();
  await expect(byId(page, active)).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator(`${PALETTE} [aria-selected="true"]`)).toHaveCount(1);
  expect(await hintText(page)).toContain('Press enter to fill the highlighted folder.');
});

test('no active descendant after an edit, an acceptance, or a descent', async ({ page }) => {
  await openAddProject(page);
  await typePath(page, '~/work/is');
  await expectFreshRows(page, ['~/work/isagi', '~/work/isagi-web']);

  await page.keyboard.press('Tab');
  await expect(input(page)).toHaveAttribute('aria-activedescendant', /./);
  await page.keyboard.press('Enter');
  await expect(input(page)).not.toHaveAttribute('aria-activedescendant', /./);

  await expectFreshRows(page, ['~/work/isagi', '~/work/isagi-web']);
  await page.keyboard.press('Tab');
  await page.keyboard.press('/');
  await expect(input(page)).toHaveValue('~/work/isagi/');
  await expect(input(page)).not.toHaveAttribute('aria-activedescendant', /./);

  await typePath(page, 'a');
  await expect(input(page)).not.toHaveAttribute('aria-activedescendant', /./);
});

test('an empty result collapses the combobox but keeps the listbox resolvable', async ({
  page,
}) => {
  await openAddProject(page);
  await typePath(page, '~/empty/');
  await expect(optionRows(page)).toHaveCount(0);

  await expect(input(page)).toHaveAttribute('aria-expanded', 'false');
  const listId = await input(page).getAttribute('aria-controls');
  await expect(byId(page, listId)).toHaveCount(1);
  await expect(input(page)).not.toHaveAttribute('aria-activedescendant', /./);
});

test('a listing failure keeps aria-controls resolving to a present listbox', async ({ page }) => {
  await openAddProject(page);
  await fixture.failNextSuggestion(page);
  await typePath(page, '~/work/i');
  await expect(page.locator(`${PALETTE} p.text-error`)).toBeVisible();

  // The error replaces the rows, not the element that owns the relationship.
  const listId = await input(page).getAttribute('aria-controls');
  await expect(byId(page, listId)).toHaveAttribute('role', 'listbox');
  await expect(input(page)).not.toHaveAttribute('aria-activedescendant', /./);
});

// --- Shared-consumer regression ---------------------------------------------------
//
// The path work changed one shared module: `useKeyboardSelection`. Two of its
// changes reach *every* consumer — the key-repeat guard and the composition guard,
// which sit in kind-agnostic branches ahead of any capability check — and one
// changed only for path screens (Tab now cycles where it was previously swallowed
// and inert). These tests hold the unchanged behaviour still.
//
// **Bounded claim.** They exercise the common routing branches on representative
// production consumers. They are not proof that every consumer is regression-free:
// `combo` and `review` screens have no browser fixture on this page, and standing up
// the open-worktree world to reach one would buy no new information about a branch
// that runs before any screen kind is consulted. Their unit coverage is retained and
// their hook configuration was inspected; browser integration for those two kinds
// remains untested, deliberately.

/** A palette list row, located by the command name it displays. */
const listRow = (page: Page, label: string) =>
  page.locator(`${PALETTE} button`).filter({ has: page.locator(`span:text-is("${label}")`) });

const LIST_HIGHLIGHT = /bg-white\/8/;

/** Walk the list highlight onto a row with real arrow presses. */
async function highlightRow(page: Page, label: string) {
  const target = listRow(page, label);
  await expect(target).toBeVisible();
  const budget = await page.locator(`${PALETTE} button`).count();
  for (let step = 0; step < budget + 1; step += 1) {
    if (LIST_HIGHLIGHT.test((await target.getAttribute('class')) ?? '')) return;
    await page.keyboard.press('ArrowDown');
  }
  await expect(target).toHaveClass(LIST_HIGHLIGHT);
}

test('a non-path select step still auto-highlights and commits on Enter', async ({ page }) => {
  await openRelocateProject(page);

  // The automatic first-row highlight is gone only for path screens. A select step
  // still snaps, so Enter commits without an arrow press.
  const missing = listRow(page, 'archive-2025');
  await expect(missing).toHaveClass(LIST_HIGHLIGHT);
  await page.keyboard.press('Enter');

  await expect(input(page)).toHaveAttribute('role', 'combobox');
  await expect(input(page)).toHaveAttribute('aria-label', 'New project root path');
});

test('Tab stays inert and focus-retaining outside path screens', async ({ page }) => {
  await page.keyboard.press('ControlOrMeta+k');
  await expect(palette(page)).toBeVisible();
  await highlightRow(page, 'Add project');

  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');

  // Tab never traverses focus out of the panel and never moves a non-path
  // highlight — the behaviour that predates this story and had to survive it.
  await expect(listRow(page, 'Add project')).toHaveClass(LIST_HIGHLIGHT);
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('INPUT');
});

test('returning from a controlled path step to the same list retains its highlight', async ({
  page,
}) => {
  await page.keyboard.press('ControlOrMeta+k');
  await expect(palette(page)).toBeVisible();
  // Entered from the *unfiltered* recents list, so the view key the hook stored
  // before the path step is the one it comes back to.
  await highlightRow(page, 'Add project');
  await page.keyboard.press('Enter');
  await expect(input(page)).toHaveAttribute('role', 'combobox');

  await page.keyboard.press('Escape');
  await expect(input(page)).not.toHaveAttribute('role', 'combobox');
  // The path step never wrote to the hook's stored index, so nothing snapped it
  // back to the first row on the way out.
  await expect(listRow(page, 'Add project')).toHaveClass(LIST_HIGHLIGHT);
});

test('returning to a different list still snaps to its first row', async ({ page }) => {
  await page.keyboard.press('ControlOrMeta+k');
  await expect(palette(page)).toBeVisible();
  // Entered from a *filtered* search, so `back` lands on a different view key.
  await input(page).fill('Add project');
  await page.keyboard.press('Enter');
  await expect(input(page)).toHaveAttribute('role', 'combobox');

  await page.keyboard.press('Escape');
  await expect(input(page)).toHaveValue('');
  // Normal uncontrolled snapping resumed: the recents list highlights its first row.
  await expect(page.locator(`${PALETTE} button`).first()).toHaveClass(LIST_HIGHLIGHT);
});

test('relocation submits to its own endpoint against its own target', async ({ page }) => {
  await openRelocateProject(page);
  await page.keyboard.press('Enter');
  await expect(input(page)).toHaveAttribute('role', 'combobox');

  await typePath(page, '~/work/is');
  await expectFreshRows(page, ['~/work/isagi', '~/work/isagi-web']);
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(input(page)).toHaveValue('~/work/isagi');
  await page.keyboard.press('Enter');
  await expect(palette(page)).toBeHidden();

  // Path behaviour is inherited; the mutation is not. A relocation must move the
  // missing project, never register a second one.
  const relocations = await fixture.relocateRequests(page);
  expect(relocations).toHaveLength(1);
  expect(relocations[0]?.outcome).toBe('relocated');
  expect(relocations[0]?.projectId).toBe(8);
  expect(relocations[0]?.path).toBe('~/work/isagi');
  expect(await fixture.addRequests(page)).toHaveLength(0);

  const projects = await fixture.projects(page);
  expect(projects).toHaveLength(2);
  expect(projects.find((project) => project.id === 8)).toMatchObject({
    rootPath: '~/work/isagi',
    status: 'present',
  });
});

// --- Shared consumer: the production workflow input flow ----------------------------

const WORKFLOW_QUESTIONS = [
  {
    kind: 'select',
    key: 'target',
    label: 'Pick a target',
    options: [{ value: 'alpha' }, { value: 'beta' }, { value: 'gamma' }],
  },
  {
    kind: 'multi-select',
    key: 'extras',
    label: 'Pick extras',
    options: [{ value: 'lint' }, { value: 'types' }],
  },
  { kind: 'text', key: 'note', label: 'Add a note' },
] as const;

const workflow = (page: Page) => page.locator('[data-fixture-workflow]');
const workflowRow = (page: Page, value: string) =>
  workflow(page)
    .locator('button')
    .filter({ has: page.locator(`span:text-is("${value}")`) });

/** Mount the workflow with the palette closed, so exactly one surface owns the keys. */
async function mountWorkflow(page: Page) {
  await expect(palette(page)).toBeHidden();
  await fixture.mountWorkflow(page, WORKFLOW_QUESTIONS);
  await expect(workflow(page)).toBeVisible();
}

test('workflow select keeps its own uncontrolled highlight and arrows', async ({ page }) => {
  await mountWorkflow(page);

  // Uncontrolled: the hook owns this index and snapped it to the first row.
  await expect(workflowRow(page, 'alpha')).toHaveClass(LIST_HIGHLIGHT);
  await page.keyboard.press('ArrowDown');
  await expect(workflowRow(page, 'beta')).toHaveClass(LIST_HIGHLIGHT);
  await page.keyboard.press('ArrowUp');
  await expect(workflowRow(page, 'alpha')).toHaveClass(LIST_HIGHLIGHT);
});

test('workflow multi-select keeps Tab inert and Space toggling', async ({ page }) => {
  await mountWorkflow(page);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(workflowRow(page, 'lint')).toBeVisible();

  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  // Tab cycles only where the path screen asks for it; here it stays swallowed.
  await expect(workflowRow(page, 'lint')).toHaveClass(LIST_HIGHLIGHT);

  await page.keyboard.press(' ');
  await expect(workflowRow(page, 'lint').locator('span:text-is("set")')).toBeVisible();
  await page.keyboard.press(' ');
  await expect(workflowRow(page, 'lint').locator('span:text-is("set")')).toHaveCount(0);
});

test('workflow text treats slash as ordinary input', async ({ page }) => {
  await mountWorkflow(page);
  // Select commits the highlighted option; multi-select is a required field, so it
  // needs an actual choice before Enter will advance.
  await page.keyboard.press('Enter');
  await page.keyboard.press(' ');
  await page.keyboard.press('Enter');
  const note = workflow(page).locator('input');
  await expect(note).toBeVisible();

  // No `separator` capability here, so "/" is text — including a trailing one,
  // which the path screen would have swallowed.
  await note.pressSequentially('a/b/');
  await expect(note).toHaveValue('a/b/');
});

test('workflow commit is guarded against key repeat and composition', async ({ page }) => {
  await mountWorkflow(page);

  // A composing Enter belongs to the editor, not to the flow.
  await page.evaluate(() => {
    const element = document.activeElement as HTMLElement;
    element.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true }),
    );
  });
  await expect(workflowRow(page, 'alpha')).toBeVisible();

  // A single physical press that auto-repeats must advance exactly one step.
  await page.keyboard.down('Enter');
  await page.evaluate(() => {
    const element = document.activeElement as HTMLElement;
    for (let index = 0; index < 3; index += 1) {
      element.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', repeat: true, bubbles: true }),
      );
    }
  });
  await page.keyboard.up('Enter');

  await expect(workflowRow(page, 'lint')).toBeVisible();
  expect(await fixture.workflowSubmissions(page)).toHaveLength(0);
});
