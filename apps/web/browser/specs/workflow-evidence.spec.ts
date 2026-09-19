import { expect, test, type Page } from '@playwright/test';

/**
 * Captured evidence in the production inspector, over the same fake runtime.
 *
 * Everything here needs a real browser: a click that opens a Data tab, a toggle that mounts a
 * sandboxed frame, a download that has to produce a blob rather than a navigation, and two surfaces
 * that have to resolve to *one* cache entry. None of that can be seen from a string render, which
 * is why it is not in `WorkflowEvidence.test.tsx`.
 *
 * The fixture's records cover every content state on purpose, and one of them — `wev_gone` — has a
 * card that looks exactly like the rest until it is opened. That is the design, so proving the card
 * stays ordinary *and* the detail tells the truth is the point of two of these tests.
 */

const bar = (page: Page) => page.getByRole('region', { name: 'Workflow' });
const dialog = (page: Page) => page.getByRole('dialog');
const tab = (page: Page, name: 'Declared' | 'Trace' | 'Evidence') =>
  dialog(page).getByRole('tab', { name, exact: true });
const evidenceColumn = (page: Page) => dialog(page).locator('[data-dock-column="Evidence"]');
const dataColumn = (page: Page) => dialog(page).locator('[data-dock-column="Data"]');
const card = (page: Page, key: string) =>
  evidenceColumn(page).locator(`[data-evidence-card="${key}"]`);

/**
 * The default scenario, whose trace rows are all mounted.
 *
 * A finished run opens on the last thing that ran and the waterfall is windowed, so the early rows
 * are legitimately not in the DOM until somebody goes back to them. Nothing here is about that, so
 * these tests use a run whose rows are all on screen rather than scrolling to reach one.
 */
async function open(page: Page, scenario = 'waiting_questions') {
  await page.goto('./');
  await expect(bar(page)).toBeVisible();
  await page.locator(`[data-action="scenario-${scenario}"]`).click();
  await bar(page).getByRole('button', { name: 'Inspect', exact: true }).click();
  await expect(dialog(page).getByRole('region', { name: 'Selection details' })).toBeVisible();
}

/** Selects the visit that captured most of the fixture's records. */
async function selectCapturingVisit(page: Page) {
  await tab(page, 'Trace').click();
  // No explicit scroll: the waterfall is windowed and rows remount as it moves, so a scroll taken
  // by hand races the remount. Playwright's own click waits for the row it is about to act on.
  await page.locator('[data-execution="102"]').click();
  await expect(card(page, 'wev_plan')).toBeVisible();
}

async function requests(page: Page): Promise<readonly string[]> {
  return page.evaluate(() => [...(window.inspectorFixture?.requestPaths() ?? [])]);
}

/** Records every object URL the page releases, so a leak is observable rather than argued about. */
async function spyOnRevoke(page: Page) {
  await page.evaluate(() => {
    const scope = window as unknown as { revoked: string[] };
    scope.revoked = [];
    const original = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (url: string) => {
      scope.revoked.push(url);
      original(url);
    };
  });
}

async function revoked(page: Page): Promise<readonly string[]> {
  return page.evaluate(() => (window as unknown as { revoked?: string[] }).revoked ?? []);
}

test('the dock lists what the selected visit captured, and opens a card as its own Data tab', async ({
  page,
}) => {
  await open(page);
  await selectCapturingVisit(page);

  // Seven records on this visit; the eighth is inside the first-pass subgraph, not under this one.
  await expect(evidenceColumn(page).locator('[data-evidence-card]')).toHaveCount(7);
  await expect(card(page, 'wev_nested')).toHaveCount(0);

  await card(page, 'wev_verify').click();
  // Named by its position in the column beside it, which is the number that was just clicked.
  const opened = dataColumn(page).getByRole('button', { name: 'ev2 · content' });
  await expect(opened).toHaveAttribute('aria-pressed', 'true');
  await expect(dataColumn(page).getByText('"pnpm check"')).toBeVisible();
});

test('the dock column and the Evidence tab are one query, not two', async ({ page }) => {
  await open(page);
  await selectCapturingVisit(page);
  await expect(card(page, 'wev_plan')).toBeVisible();

  await page.evaluate(() => window.inspectorFixture?.resetRequests());
  await evidenceColumn(page).locator('[data-evidence-open-all]').click();

  // The panel's visit scope asks the same question with the same shape, so React Query serves it
  // from the entry the dock already filled. A second request here would mean the two surfaces can
  // hold different answers.
  const listings = (await requests(page)).filter((path) => path.includes('/evidence?'));
  expect(listings).toEqual([]);

  // Entering from the dock is a question about one visit, and the subtree switch is on: the list is
  // exactly the column's length and exactly what `evidenceCaptured` counts.
  await expect(dialog(page).locator('[data-evidence-scope="visit"]')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(dialog(page).locator('[data-evidence-subtree]')).toHaveAttribute(
    'aria-checked',
    'true',
  );
});

test('entering from the tab strip asks about the run, not about the selection', async ({
  page,
}) => {
  await open(page);
  await selectCapturingVisit(page);
  await tab(page, 'Evidence').click();

  await expect(dialog(page).locator('[data-evidence-scope="run"]')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  // All eight, including the one captured three levels down inside the first-pass subgraph.
  await expect(dialog(page).locator('[data-evidence-row]')).toHaveCount(8);
  // And it is shown *inside* its subgraph visit rather than beside it.
  await expect(dialog(page).locator('[data-evidence-group]').first()).toBeVisible();
  await expect(dialog(page).locator('[data-evidence-row="wev_nested"]')).toBeVisible();
});

test('HTML opens as source, and rendering is a separate, sandboxed choice', async ({ page }) => {
  await open(page);
  await selectCapturingVisit(page);
  await tab(page, 'Evidence').click();
  await dialog(page).locator('[data-evidence-row="wev_coverage"]').click();

  const detail = dialog(page).locator('[data-html-mode="source"]');
  await expect(detail).toHaveAttribute('aria-pressed', 'true');
  // The markup is on screen as text. Nothing has been rendered.
  await expect(dialog(page).getByText('prettify.css')).toBeVisible();
  await expect(dialog(page).locator('iframe')).toHaveCount(0);

  await dialog(page).locator('[data-html-mode="render"]').click();
  const frame = dialog(page).locator('iframe');
  await expect(frame).toHaveCount(1);
  // The sandbox is the control, not the CSP. An empty attribute withholds scripts, same-origin,
  // forms and top-level navigation all at once, and nothing here may loosen it to make a preview
  // work.
  await expect(frame).toHaveAttribute('sandbox', '');
  await expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer');
  await expect(frame).toHaveAttribute('srcdoc', /Coverage/);
});

test('a record whose bytes are gone looks ordinary in the column and says so when opened', async ({
  page,
}) => {
  await open(page);
  await selectCapturingVisit(page);

  // A listing does not stat files, so the card claims nothing about availability and carries no
  // warning of any kind.
  const ordinary = card(page, 'wev_gone');
  await expect(ordinary).toBeVisible();
  await expect(ordinary.locator('.text-error, .text-amber')).toHaveCount(0);

  await ordinary.click();
  await expect(dataColumn(page).getByText("Captured, but Isagi can't read it back.")).toBeVisible();
  // The record is still true. Only the bytes are gone — and the metadata stays on screen to prove
  // the two are different facts.
  await expect(dataColumn(page).getByText('sha256:2c9af014')).toBeVisible();
  await expect(dataColumn(page).getByText('corrupt')).toBeVisible();
  await expect(dataColumn(page).getByText('decision-log')).toBeVisible();
});

test('a preview stops at the cap and says so, rather than pretending to be the whole thing', async ({
  page,
}) => {
  await open(page);
  await selectCapturingVisit(page);
  await tab(page, 'Evidence').click();
  await dialog(page).locator('[data-evidence-row="wev_long"]').click();

  // Over the cap, so it asks first: arrow-keying a tree must not pull megabytes per row.
  await dialog(page)
    .getByRole('button', { name: /Show content/ })
    .click();
  await expect(
    dialog(page).getByText('Preview stops at 256 KB. Download for the whole thing.'),
  ).toBeVisible();
});

test('a download is a blob the app made, never a navigation to the runtime', async ({ page }) => {
  await open(page);
  await selectCapturingVisit(page);
  await tab(page, 'Evidence').click();
  await dialog(page).locator('[data-evidence-row="wev_plan"]').click();

  await spyOnRevoke(page);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    dialog(page).locator('[data-evidence-download]').first().click(),
  ]);

  // A link to the runtime's `?download=true` route would be a navigation to a non-renderer origin,
  // which the desktop shell denies outright. The object URL keeps the save inside the web app.
  expect(download.url().startsWith('blob:')).toBe(true);
  expect(download.suggestedFilename()).toBe('plan.md');

  // And the URL is released. An object URL that is never revoked pins its blob for the life of the
  // document, which no cache eviction reaches — the one leak a download can produce.
  await expect.poll(async () => revoked(page)).toContain(download.url());
});

test('an unresolved source says no operation matched; an exact one names the operation', async ({
  page,
}) => {
  await open(page);
  await selectCapturingVisit(page);
  await tab(page, 'Evidence').click();

  await dialog(page).locator('[data-evidence-row="wev_long"]').click();
  await expect(
    dialog(page).getByText('unresolved · no operation in this run matched the turn'),
  ).toBeVisible();

  await dialog(page).locator('[data-evidence-row="wev_plan"]').click();
  await expect(dialog(page).getByText('op-triage-0').first()).toBeVisible();
  // Provenance is fetched on demand through `getOperation`, because the dock can be resized away
  // entirely — and that route is the only one that answers the transcript question at all.
  await expect(
    dialog(page).getByText('unknown · inherited from the session').first(),
  ).toBeVisible();
  await expect(dialog(page).getByText('~/.claude/projects/fixture/d02f91ee.jsonl')).toHaveCount(0);
});

test('provenance is open on the first card under Trace, and present but closed under Evidence', async ({
  page,
}) => {
  await open(page);
  await selectCapturingVisit(page);

  // The heading reads `Wait · Operations` when the visit also armed a wait, so the column is
  // matched by its suffix rather than by a title that depends on the scenario.
  const operations = dialog(page).locator('[data-dock-column$="Operations"]');
  const disclosures = operations.locator('details');
  await expect(disclosures.first()).toHaveAttribute('open', '');
  // Ten rows on each of several cards would be a column nobody can read; the rest ask for a click.
  await expect(disclosures.nth(1)).not.toHaveAttribute('open', '');

  await tab(page, 'Evidence').click();
  // Still there, and now closed. The detail pane above shows this block for the selected record's
  // **source** operation only, so removing it here would leave every other operation of the visit
  // with no provenance anywhere in the product.
  // One per operation card, still. Vacuous self-comparison avoided: the visit made two calls.
  await expect(disclosures).toHaveCount(2);
  await expect(disclosures.first()).not.toHaveAttribute('open', '');
  await disclosures.first().locator('summary').click();
  await expect(operations.getByText('inherited from the session').first()).toBeVisible();
});

test('the visit arm of the scope toggle is reachable from run scope', async ({ page }) => {
  await open(page);
  await selectCapturingVisit(page);
  await tab(page, 'Evidence').click();
  await expect(dialog(page).locator('[data-evidence-row]')).toHaveCount(8);

  // A two-position toggle whose second position can never be pressed is a control that does
  // nothing. From run scope it resolves to the dock's visit; with a record selected, to that
  // record's own — and subtree is on either way.
  const visit = dialog(page).locator('[data-evidence-scope="visit"]');
  await expect(visit).toBeEnabled();
  await visit.click();
  await expect(visit).toHaveAttribute('aria-pressed', 'true');
  await expect(dialog(page).locator('[data-evidence-subtree]')).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(dialog(page).locator('[data-evidence-row]')).toHaveCount(7);

  // And back, so neither arm is a one-way door.
  await dialog(page).locator('[data-evidence-scope="run"]').click();
  await expect(dialog(page).locator('[data-evidence-row]')).toHaveCount(8);
});

test('an image renders from a blob URL, and the URL is released when it goes away', async ({
  page,
}) => {
  await open(page);
  await selectCapturingVisit(page);
  await spyOnRevoke(page);

  await tab(page, 'Evidence').click();
  await dialog(page).locator('[data-evidence-row="wev_shot"]').click();

  const image = dialog(page).locator('img');
  await expect(image).toBeVisible();
  const source = await image.getAttribute('src');
  expect(source?.startsWith('blob:')).toBe(true);

  // The only content state with a resource lifecycle. An object URL that is never revoked is a leak
  // nothing else in this suite would notice, so the release is asserted rather than assumed.
  await dialog(page).locator('[data-evidence-row="wev_plan"]').click();
  await expect(dialog(page).locator('img')).toHaveCount(0);
  await expect.poll(async () => revoked(page)).toContain(source);
});

test('the dock column lists a subgraph visit and everything below it', async ({ page }) => {
  await open(page);
  await tab(page, 'Trace').click();
  // The subgraph itself captured nothing; the record belongs to a visit inside its child frame.
  // "this visit and below" is a claim the heading makes, so it is pinned rather than assumed.
  await page.locator('[data-execution="103"]').click();
  await expect(card(page, 'wev_nested')).toBeVisible();
  await expect(evidenceColumn(page).locator('[data-evidence-card]')).toHaveCount(1);
});

test('role and label chips narrow the list without asking the runtime again', async ({ page }) => {
  await open(page);
  await selectCapturingVisit(page);
  await tab(page, 'Evidence').click();
  await expect(dialog(page).locator('[data-evidence-row]')).toHaveCount(8);

  await page.evaluate(() => window.inspectorFixture?.resetRequests());
  await dialog(page).locator('[data-evidence-filter="verification"]').click();
  await expect(dialog(page).locator('[data-evidence-row]')).toHaveCount(3);

  // The panel already holds every page, so a filter is a view over what is in hand. Sending it
  // would change the query key and split this list off the dock column's cache entry.
  const listings = (await requests(page)).filter((path) => path.includes('/evidence?'));
  expect(listings).toEqual([]);

  await dialog(page).locator('[data-evidence-filter="all roles"]').click();
  await expect(dialog(page).locator('[data-evidence-row]')).toHaveCount(8);
});

test('a trace row says how much was kept, and a row that kept nothing says nothing', async ({
  page,
}) => {
  await open(page);
  await tab(page, 'Trace').click();

  const captured = page.locator('[data-execution="102"]');
  await expect(captured.getByText('7', { exact: true })).toBeVisible();

  // The subgraph's number covers its whole child frame, and is spelled so nobody adds it to the
  // nested row's own.
  const subgraph = page.locator('[data-execution="103"]');
  await expect(subgraph.getByText('1 inside')).toBeVisible();

  // `collect` captured nothing, and carries no badge at all rather than a badge reading zero.
  const nothing = page.locator('[data-execution="101"]');
  await expect(nothing).toBeVisible();
  await expect(nothing.locator('.border-cyan\\/35')).toHaveCount(0);
});

test('a declared node carries its element total, and an unvisited-in-this-respect node carries none', async ({
  page,
}) => {
  await open(page);
  await tab(page, 'Declared').click();
  const canvas = dialog(page).locator('[data-testid="declared-viewport"]');

  // The sum across this element's visits, which `aggregate.test.ts` already proves is counted once
  // per capture. What is asserted here is that the number reaches the card at all, and how it reads.
  await expect(
    canvas.locator('[data-element="::node:triage"]').getByText('7', { exact: true }),
  ).toBeVisible();

  // A subgraph spells it as containment, matching its trace row, because the figure covers the
  // whole child frame.
  await expect(
    canvas.locator('[data-element="::node:first-pass"]').getByText('1 inside'),
  ).toBeVisible();

  // `collect` captured nothing and carries no badge at all, rather than one reading zero.
  await expect(canvas.locator('[data-element="::node:collect"] .border-cyan\\/35')).toHaveCount(0);
});

test("a selection that is not a visit gets no evidence column, and no other visit's records", async ({
  page,
}) => {
  await open(page);
  await tab(page, 'Declared').click();
  const canvas = dialog(page).locator('[data-testid="declared-viewport"]');

  // `second-pass` is declared and never visited in this scenario, so it has a full dock view and no
  // execution behind it. Falling back to the run's listing here would put seven other nodes'
  // records under a heading that reads "this visit and below".
  await canvas.locator('[data-element="::node:second-pass"] [data-node-key]').first().click();
  await expect(
    evidenceColumn(page).getByText('Evidence belongs to a node visit. This selection is not one.'),
  ).toBeVisible();
  await expect(evidenceColumn(page).locator('[data-evidence-card]')).toHaveCount(0);
  // The link is not offered either, so the tab and the column cannot be opened into disagreement.
  await expect(evidenceColumn(page).locator('[data-evidence-open-all]')).toHaveCount(0);
  // And the column's heading drops its scope qualifier rather than claiming a visit.
  await expect(dialog(page).locator('[data-dock-column="Evidence"]')).not.toContainText(
    'this visit and below',
  );

  // Nothing was asked of the runtime for a selection with no evidence question.
  await page.evaluate(() => window.inspectorFixture?.resetRequests());
  await canvas.locator('[data-element="::node:second-pass"] [data-node-key]').first().click();
  expect((await requests(page)).filter((path) => path.includes('/evidence'))).toEqual([]);
});
