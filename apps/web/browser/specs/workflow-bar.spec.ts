import { expect, test, type Page } from '@playwright/test';

/**
 * The attached-run bar, end to end from the **production** `WorkflowBarContainer` down to `fetch`
 * (`browser/fixture/workflow-bar/`).
 *
 * Two things live here and both need the real wiring. The first is interaction a static render
 * cannot reach: what happens to a half-typed answer when the run moves on, whether a confirmation
 * is really two steps. The second is the wiring itself — which route a control actually hits, with
 * what body, and what the caches look like afterwards. A props-driven page would have rendered the
 * same pixels while proving neither.
 *
 * Facts about the run arrive as the runtime events a real client receives, so the attached-run
 * cache and its ordering rules are exercised rather than seeded. What the bar derives from a summary
 * alone is asserted in `src/routes/workspace/WorkflowBar.test.tsx`; nothing is duplicated here.
 */

interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

const bar = (page: Page) => page.getByRole('region', { name: 'Workflow' });
const control = (page: Page, name: string) => bar(page).getByRole('button', { name, exact: true });
const answerField = (page: Page) => bar(page).getByRole('textbox');

async function requests(page: Page): Promise<readonly RecordedRequest[]> {
  return JSON.parse((await page.locator('[data-requests]').textContent()) ?? '[]');
}

async function controlRequests(page: Page): Promise<readonly RecordedRequest[]> {
  return (await requests(page)).filter((request) => request.method === 'POST');
}

async function attached(page: Page) {
  return JSON.parse((await page.locator('[data-attached]').textContent()) ?? '[]') as readonly {
    runId: number;
    revision: number;
    status: string;
  }[];
}

test.beforeEach(async ({ page }) => {
  await page.goto('./');
  await expect(page.locator('[data-fixture-ready]')).toBeAttached();
  await expect(bar(page)).toBeVisible();
});

test('the bar resolves its run from the attached cache the runtime fed', async ({ page }) => {
  expect(await attached(page)).toEqual([{ runId: 77, revision: 1, status: 'waiting' }]);
  await expect(bar(page)).toContainText('The writer needs direction.');
});

test('an answer reaches the advance route naming its run and its wait', async ({ page }) => {
  await answerField(page).fill('Tighten the opening.');
  await answerField(page).press('Enter');

  await expect
    .poll(async () => await controlRequests(page))
    .toEqual([
      {
        method: 'POST',
        path: '/workflows/runs/77/advance',
        body: { waitId: 5, answers: { verdict: 'Tighten the opening.' } },
      },
    ]);
});

test('a wait that changes while someone is typing resets the draft, and the next answer names the new wait', async ({
  page,
}) => {
  await answerField(page).fill('Half-written thought');
  await page.locator('[data-action="change-wait"]').click();

  // The draft belonged to wait 5. Wait 6 is a different question, and carrying the text over would
  // submit an answer nobody wrote for it.
  await expect(answerField(page)).toHaveValue('');

  await answerField(page).fill('Answer for the new wait');
  await answerField(page).press('Enter');
  await expect
    .poll(async () => (await controlRequests(page)).map((request) => request.body))
    .toEqual([{ waitId: 6, answers: { verdict: 'Answer for the new wait' } }]);
});

test('an unrelated summary change does not wipe a half-typed answer', async ({ page }) => {
  await answerField(page).fill('Still writing this');
  // Toggling the log re-renders the bar against a fresh summary object, which is what every
  // committed transition does. The draft belongs to the wait, not to the render.
  await control(page, 'Show log').click();
  await expect(answerField(page)).toHaveValue('Still writing this');
});

test('each control hits its own route, and Dismiss is never Cancel', async ({ page }) => {
  await control(page, 'Cancel').click();
  await bar(page).getByRole('button', { name: 'Cancel workflow' }).click();
  await expect
    .poll(async () => (await controlRequests(page)).map((request) => request.path))
    .toEqual(['/workflows/runs/77/cancel']);

  await page.locator('[data-action="scenario-done"]').click();
  await expect(control(page, 'Cancel')).toHaveCount(0);
  await control(page, 'Dismiss').click();

  // Two different verbs on two different routes. Sharing either would put one action's outcome
  // under the other's name.
  await expect
    .poll(async () => (await controlRequests(page)).map((request) => request.path))
    .toEqual(['/workflows/runs/77/cancel', '/workflows/runs/77/dismiss']);
});

test('cancel takes two steps and says what it really does', async ({ page }) => {
  await control(page, 'Cancel').click();

  await expect(bar(page)).toContainText('Cancel this workflow?');
  await expect(bar(page)).toContainText('records everything so far');
  await expect(bar(page)).not.toContainText('cleared');
  expect(await controlRequests(page)).toEqual([]);

  await bar(page).getByRole('button', { name: 'Keep running' }).click();
  await expect(bar(page)).not.toContainText('Cancel this workflow?');
  expect(await controlRequests(page)).toEqual([]);
});

test('a refused control is explained in Isagi’s words and leaves the run in the cache', async ({
  page,
}) => {
  await page.locator('[data-action="reject-next"]').click();
  await control(page, 'Pause').click();

  await expect(bar(page)).toContainText("Couldn't pause the workflow.");
  await expect(bar(page)).toContainText('This workflow moved on.');
  // The runtime's own message is a diagnostic for a bug report, never product copy.
  await expect(bar(page)).not.toContainText('raw runtime diagnostic text');

  // A refusal is not a reason to lose the attachment: the run is still in the cache, unchanged, and
  // still has its bar.
  expect(await attached(page)).toEqual([{ runId: 77, revision: 1, status: 'waiting' }]);
  await expect(bar(page)).toBeVisible();
  await expect(control(page, 'Pause')).toBeVisible();
});

test('a successful control writes no outcome of its own', async ({ page }) => {
  await control(page, 'Pause').click();
  await expect.poll(async () => (await controlRequests(page)).length).toBe(1);

  // The runtime publishes what actually happened. The client claiming success on its behalf is how
  // a bar comes to show a state the run never reached.
  expect(await attached(page)).toEqual([{ runId: 77, revision: 1, status: 'waiting' }]);
});

test('a stale detach cannot take the bar down, and a stale summary cannot rewind it', async ({
  page,
}) => {
  await page.locator('[data-action="scenario-failed"]').click();
  await expect.poll(async () => (await attached(page))[0]?.status).toBe('failed');

  await page.locator('[data-action="stale-detach"]').click();
  await expect(bar(page)).toBeVisible();
  expect((await attached(page)).map((run) => run.runId)).toEqual([77]);

  await page.locator('[data-action="stale-summary"]').click();
  // Revision decides. An older summary arriving late describes a state the run has already left.
  expect((await attached(page))[0]?.status).toBe('failed');

  await page.locator('[data-action="detach"]').click();
  await expect(bar(page)).toHaveCount(0);
  expect(await attached(page)).toEqual([]);
});

test('a paused run can be advanced, and says the answer will not restart it', async ({ page }) => {
  await page.locator('[data-action="scenario-paused_continue"]').click();

  await expect(bar(page)).toContainText('This workflow stays paused after you answer.');
  await expect(control(page, 'Resume')).toBeVisible();
  await bar(page).getByRole('button', { name: 'Continue' }).click();

  await expect
    .poll(async () => await controlRequests(page))
    .toEqual([{ method: 'POST', path: '/workflows/runs/77/advance', body: { waitId: 5 } }]);
});

test('opening the log reads one bounded window and no payloads', async ({ page }) => {
  await page.locator('[data-action="seed-log"]').click();
  await control(page, 'Show log').click();

  await expect(bar(page)).toContainText('recorded line');
  const reads = (await requests(page)).filter((request) => request.method === 'GET');
  const windowReads = reads.filter((request) => request.path.includes('/events'));
  expect(windowReads).toHaveLength(1);
  // A window, not the run's whole history: the lower bound is sent explicitly.
  expect(windowReads[0]?.path).toContain('sinceRevision=');
  // Opening the log must not drag executions, frames, operations or payloads across the wire.
  expect(reads.some((request) => request.path.includes('/payloads/'))).toBe(false);
  expect(reads.some((request) => request.path.includes('/executions'))).toBe(false);
});

test('the bar, the surface and the palette all read one attached-run cache', async ({ page }) => {
  // The named integration check: three production readers, one QueryClient, one cache entry. None
  // of them is handed the summary — each resolves it through the same query — so the only way they
  // can agree is by genuinely sharing it, and the only way they can drift is if a second authority
  // appears.
  const surface = page.locator('[data-surface-host]');
  const glow = surface.locator('div.pointer-events-none.absolute.inset-0.z-20');

  // 1 + 2. The run arrived through the ordinary synchronization path, and the surface reflects it.
  await expect(bar(page)).toBeVisible();
  await expect(glow).toHaveCount(1);
  await expect
    .poll(async () => JSON.parse((await page.locator('[data-attention]').textContent()) ?? '{}'))
    .toEqual({ surface: 'waiting', worktree: 'waiting' });

  // 3. The palette withholds a launch from a surface that is already occupied, naming the same run.
  await page.keyboard.press('ControlOrMeta+k');
  const releaseRow = page
    .getByRole('button')
    .filter({ has: page.locator('span:text-is("Release")') });
  await expect(releaseRow).toContainText('Dismiss the current workflow first.');
  await page.keyboard.press('Escape');

  // 4. A later event on the same run: it fails, so the whole page must move together.
  await page.locator('[data-action="scenario-failed"]').click();
  await expect
    .poll(async () => JSON.parse((await page.locator('[data-attention]').textContent()) ?? '{}'))
    .toEqual({ surface: 'error', worktree: 'error' });
  await expect(glow).toHaveCount(1);

  // 5. And a detach: the bar goes, the surface stops indicating a workflow, the worktree settles,
  // and the palette offers the launch again — all from the one event, with nothing updated by hand.
  await page.locator('[data-action="detach"]').click();
  await expect(bar(page)).toHaveCount(0);
  await expect(glow).toHaveCount(0);
  await expect
    .poll(async () => JSON.parse((await page.locator('[data-attention]').textContent()) ?? '{}'))
    .toEqual({ surface: 'idle', worktree: 'idle' });

  await page.keyboard.press('ControlOrMeta+k');
  await expect(releaseRow).not.toContainText('Dismiss the current workflow first.');
  await expect(releaseRow).toContainText('Runs the release checklist.');
});

test('a log that cannot be read says so, and the retry actually re-reads', async ({ page }) => {
  await page.locator('[data-action="seed-log"]').click();
  await page.locator('[data-action="fail-log"]').click();
  await control(page, 'Show log').click();

  // An unreadable history is not an empty one. Claiming "nothing recorded yet" here would invent a
  // fact about the run out of the client's own inability to read one.
  await expect(bar(page)).toContainText("Isagi couldn't read this workflow's recent activity.");
  await expect(bar(page)).not.toContainText('nothing recorded yet');

  await bar(page).getByRole('button', { name: 'Try again' }).click();
  await expect(bar(page)).toContainText('recorded line');
  await expect(bar(page)).not.toContainText("Isagi couldn't read this workflow's recent activity.");
});

test('a stored log detail is fetched only when asked for, and then replaces the line', async ({
  page,
}) => {
  await page.locator('[data-action="stored-detail"]').click();
  await control(page, 'Show log').click();

  await expect(bar(page)).toContainText('This entry is too large to show inline.');
  // Opening the log must not drag a run's stored payloads across the wire.
  expect((await requests(page)).some((request) => request.path.includes('/payloads/'))).toBe(false);

  await bar(page).getByRole('button', { name: 'Load detail' }).click();

  await expect(bar(page)).toContainText('the whole recorded line');
  await expect
    .poll(
      async () =>
        (await requests(page)).filter((request) => request.path.includes('/payloads/')).length,
    )
    .toBe(1);
});

test('action feedback does not outlive the run it belonged to', async ({ page }) => {
  await page.locator('[data-action="reject-next"]').click();
  await control(page, 'Pause').click();
  await expect(bar(page)).toContainText("Couldn't pause the workflow.");

  // A different run takes the surface. The previous run's refusal describes something nobody is
  // looking at any more, and showing it against the new run would be a plain lie about it.
  await page.locator('[data-action="swap-run"]').click();
  await expect.poll(async () => (await attached(page))[0]?.runId).toBe(88);
  await expect(bar(page)).not.toContainText("Couldn't pause the workflow.");
});

async function eventReads(page: Page) {
  return (await requests(page)).filter(
    (request) => request.method === 'GET' && request.path.includes('/events'),
  );
}

test('a long-lived run opens its log on a recent window, never on its whole history', async ({
  page,
}) => {
  await page.locator('[data-action="seed-log"]').click();
  await page.locator('[data-action="high-revision"]').click();
  await expect.poll(async () => (await attached(page))[0]?.revision).toBe(1000);

  await control(page, 'Show log').click();
  await expect(bar(page)).toContainText('recorded line');

  const reads = await eventReads(page);
  expect(reads).toHaveLength(1);
  // The window is derived where the run is, not assigned after the first request has gone out.
  // History is retained indefinitely, so `sinceRevision=0` here would page the entire run to draw
  // a handful of lines — and would then keep that result under an infinitely stale key.
  expect(reads[0]?.path).toContain('sinceRevision=950');
  expect(reads[0]?.path).not.toContain('sinceRevision=0');
});

test('swapping runs while the log is open rebases the window on the new run', async ({ page }) => {
  await page.locator('[data-action="seed-log"]').click();
  await page.locator('[data-action="high-revision"]').click();
  await control(page, 'Show log').click();
  await expect.poll(async () => (await eventReads(page)).length).toBe(1);

  await page.locator('[data-action="swap-high-revision"]').click();
  await expect.poll(async () => (await attached(page))[0]?.runId).toBe(88);

  const reads = await eventReads(page);
  expect(reads).toHaveLength(2);
  // The new run's own position, not the previous run's window and not zero.
  expect(reads[1]?.path).toContain('/runs/88/events');
  expect(reads[1]?.path).toContain('sinceRevision=1950');
});

test('while a control is in flight the whole cluster waits', async ({ page }) => {
  await page.locator('[data-action="hold-control"]').click();
  await control(page, 'Pause').click();

  // Not just the button that was pressed. Two run-level controls at once mean nothing, and leaving
  // the rest live let a fast one clear the indicator while a slower one was still outstanding.
  await expect(control(page, 'Pause')).toBeDisabled();
  await expect(control(page, 'Cancel')).toBeDisabled();

  await page.locator('[data-action="release-control"]').click();
  await expect(control(page, 'Pause')).toBeEnabled();
  await expect(control(page, 'Cancel')).toBeEnabled();
});

test('a rejection that arrives after a run swap is not shown against the new run', async ({
  page,
}) => {
  await page.locator('[data-action="reject-next"]').click();
  await page.locator('[data-action="hold-control"]').click();
  await control(page, 'Pause').click();
  await expect(control(page, 'Pause')).toBeDisabled();

  // The run lets go of the surface while its Pause is still outstanding.
  await page.locator('[data-action="swap-run"]').click();
  await expect.poll(async () => (await attached(page))[0]?.runId).toBe(88);

  await page.locator('[data-action="release-control"]').click();

  // The refusal belongs to run 77. Drawing it against run 88 would be a plain lie about run 88.
  await expect(bar(page)).not.toContainText("Couldn't pause the workflow.");
  await expect(control(page, 'Pause')).toBeEnabled();
});

test('a cancel confirmation cannot retarget itself to the run that replaced it', async ({
  page,
}) => {
  await control(page, 'Cancel').click();
  await expect(bar(page)).toContainText('Cancel this workflow?');

  // Run 77 lets go of the surface and run 88 takes it while the confirmation is on screen. The bar
  // is one component across that swap, so a confirmation that outlived its run would be sitting
  // there wired to the new run's Cancel — one click from cancelling a workflow nobody confirmed.
  await page.locator('[data-action="swap-run"]').click();
  await expect.poll(async () => (await attached(page))[0]?.runId).toBe(88);

  await expect(bar(page)).not.toContainText('Cancel this workflow?');
  expect((await controlRequests(page)).map((request) => request.path)).toEqual([]);

  // And the new run's own confirmation still works, from scratch.
  await control(page, 'Cancel').click();
  await expect(bar(page)).toContainText('Cancel this workflow?');
  await bar(page).getByRole('button', { name: 'Cancel workflow' }).click();
  await expect
    .poll(async () => (await controlRequests(page)).map((request) => request.path))
    .toEqual(['/workflows/runs/88/cancel']);
});

test('the panel announces missing activity only while something is genuinely missing', async ({
  page,
}) => {
  const withheld = () => bar(page).getByText('Earlier activity is not loaded.');

  // Opens on an empty history: the read covers nothing, so anything evicted really is gone.
  await control(page, 'Show log').click();
  await expect.poll(async () => (await eventReads(page)).length).toBe(1);
  await expect(withheld()).toHaveCount(0);

  // Exactly the cap. The panel is full, but nothing has been lost — announcing withheld activity
  // here would claim a loss that has not happened.
  await page.locator('[data-action="flood-log"]').click();
  await expect(bar(page)).toContainText('recorded line 200');
  await expect(withheld()).toHaveCount(0);

  // One past it. Revision 1 is evicted and no history read covers it, so it really is missing.
  await page.locator('[data-action="one-more-line"]').click();
  await expect(bar(page)).toContainText('recorded line 201');
  await expect(withheld()).toHaveCount(1);

  // The window is already at zero, so deepening it would change nothing — the affordance has to
  // re-read, or it is offering something it can never deliver. The re-read covers revisions 1..8.
  await page.locator('[data-action="seed-log"]').click();
  await bar(page).getByRole('button', { name: 'Load earlier activity' }).click();
  await expect.poll(async () => (await eventReads(page)).length).toBe(2);
  await expect(withheld()).toHaveCount(0);

  // The next line evicts revision 2 — which the refreshed history now carries, so it is still on
  // screen. A buffer that merely noticed it had overflowed would have claimed a loss here, and gone
  // on claiming one after every line.
  await page.locator('[data-action="one-more-line"]').click();
  await expect(bar(page)).toContainText('recorded line 202');
  await expect(withheld()).toHaveCount(0);

  // Only once eviction passes revision 8 — the end of what that read covered — is anything actually
  // missing again.
  for (let line = 0; line < 7; line += 1) {
    await page.locator('[data-action="one-more-line"]').click();
  }
  await expect(withheld()).toHaveCount(1);
});

test('reopening the log reads history again, so nothing recorded while it was closed is lost', async ({
  page,
}) => {
  await page.locator('[data-action="seed-log"]').click();
  await control(page, 'Show log').click();
  await expect(bar(page)).toContainText('recorded line 8');
  await expect.poll(async () => (await eventReads(page)).length).toBe(1);

  // Closed, so nothing is listening. The run records more activity — diagnostics only, which is the
  // case that matters: a run that merely logged changes nothing the summary reports, so its
  // revision does not move and cannot serve as an identity for this reading of history.
  await control(page, 'Hide log').click();
  await page.locator('[data-action="grow-log"]').click();
  expect((await attached(page))[0]?.revision).toBe(1);

  await control(page, 'Show log').click();

  // The lower bound is unchanged and so is the run's revision, but the read runs to the present —
  // so reusing the previous answer would silently omit everything recorded in between, with
  // nothing on screen to say so.
  await expect.poll(async () => (await eventReads(page)).length).toBe(2);
  await expect(bar(page)).toContainText('recorded line 12');
});

test('a bar that unmounts and comes back reads history again rather than trusting the cache', async ({
  page,
}) => {
  await page.locator('[data-action="seed-log"]').click();
  await control(page, 'Show log').click();
  await expect(bar(page)).toContainText('recorded line 8');
  await expect.poll(async () => (await eventReads(page)).length).toBe(1);

  // Zen mode unmounts the bar. The React Query cache outlives it, so anything the bar remembered
  // about its own readings is gone while the entry those readings produced is still there.
  await page.locator('[data-action="toggle-bar"]').click();
  await expect(bar(page)).toHaveCount(0);

  await page.locator('[data-action="grow-log"]').click();
  await page.locator('[data-action="toggle-bar"]').click();
  await expect(bar(page)).toBeVisible();
  // Diagnostics alone: the summary reports nothing new, so its revision cannot stand in for one.
  expect((await attached(page))[0]?.revision).toBe(1);

  await control(page, 'Show log').click();
  await expect.poll(async () => (await eventReads(page)).length).toBe(2);
  await expect(bar(page)).toContainText('recorded line 12');
});

test('a read still in flight cannot serve the next opening of the log', async ({ page }) => {
  await page.locator('[data-action="seed-log"]').click();
  await page.locator('[data-action="hold-log"]').click();
  await control(page, 'Show log').click();
  await expect.poll(async () => (await eventReads(page)).length).toBe(1);

  // Closed while that first read is still outstanding. Keeping the data stale is not enough here:
  // a re-enabled observer deduplicates onto the request already in flight, so the next opening
  // would be served an answer taken before it happened — complete-looking, and missing whatever was
  // recorded in between.
  await control(page, 'Hide log').click();
  await page.locator('[data-action="grow-log"]').click();
  expect((await attached(page))[0]?.revision).toBe(1);

  await control(page, 'Show log').click();
  await expect.poll(async () => (await eventReads(page)).length).toBe(2);
  await expect(bar(page)).toContainText('recorded line 12');

  // The abandoned read settling afterwards changes nothing: it was cancelled, not merely ignored.
  await page.locator('[data-action="release-log"]').click();
  await expect(bar(page)).toContainText('recorded line 12');
});

test('a read still in flight cannot survive the bar unmounting', async ({ page }) => {
  await page.locator('[data-action="seed-log"]').click();
  await page.locator('[data-action="hold-log"]').click();
  await control(page, 'Show log').click();
  await expect.poll(async () => (await eventReads(page)).length).toBe(1);

  await page.locator('[data-action="toggle-bar"]').click();
  await expect(bar(page)).toHaveCount(0);
  await page.locator('[data-action="grow-log"]').click();
  await page.locator('[data-action="toggle-bar"]').click();
  await expect(bar(page)).toBeVisible();

  await control(page, 'Show log').click();
  await expect.poll(async () => (await eventReads(page)).length).toBe(2);
  await expect(bar(page)).toContainText('recorded line 12');
});

test('the question is reachable and answerable from the keyboard alone', async ({ page }) => {
  await answerField(page).focus();
  await page.keyboard.type('Keyboard only');
  await page.keyboard.press('Enter');

  await expect
    .poll(async () => (await controlRequests(page)).map((request) => request.body))
    .toEqual([{ waitId: 5, answers: { verdict: 'Keyboard only' } }]);
});
