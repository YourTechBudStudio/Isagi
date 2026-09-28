import { expect, test, type Page } from '@playwright/test';

/**
 * The attached-run bar, end to end from the **production** `WorkflowBarContainer` down to `fetch`
 * (`browser/fixture/workflow-bar/`).
 *
 * Two things live here and both need the real wiring. The first is interaction a static render
 * cannot reach: what happens to a half-typed answer when the run moves on, whether a confirmation
 * is really two steps. The second is the wiring itself — which route a control actually hits, with
 * what body, and what the caches look like afterwards.
 *
 * Facts about the run arrive as the runtime events a real client receives, so the attached-run
 * cache and the live event flow are exercised rather than seeded. What the bar derives from a
 * summary alone is asserted in `src/routes/workspace/WorkflowBar.test.tsx`; nothing is duplicated
 * here.
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

async function eventReads(page: Page) {
  return (await requests(page)).filter(
    (request) => request.method === 'GET' && request.path.includes('/events'),
  );
}

async function attached(page: Page) {
  return JSON.parse((await page.locator('[data-attached]').textContent()) ?? '[]') as readonly {
    runId: number;
    status: string;
  }[];
}

test.beforeEach(async ({ page }) => {
  await page.goto('./');
  await expect(page.locator('[data-fixture-ready]')).toBeAttached();
  await expect(bar(page)).toBeVisible();
});

test('the bar resolves its run from the attached cache the runtime fed', async ({ page }) => {
  expect(await attached(page)).toEqual([{ runId: 77, status: 'waiting' }]);
  await expect(bar(page)).toContainText('What should the writer change?');
});

test('an answer reaches the advance route naming its run and its waiting execution', async ({
  page,
}) => {
  await answerField(page).fill('Tighten the opening.');
  await answerField(page).press('Enter');

  await expect
    .poll(async () => await controlRequests(page))
    .toEqual([
      {
        method: 'POST',
        path: '/workflows/runs/77/advance',
        body: { executionId: 5, answers: { verdict: 'Tighten the opening.' } },
      },
    ]);
});

test('a wait that changes while someone is typing resets the draft, and the next answer names the new execution', async ({
  page,
}) => {
  await answerField(page).fill('Half-written thought');
  await page.locator('[data-action="change-wait"]').click();

  // The draft belonged to execution 5. Execution 6 asks its own question, and carrying the text
  // over would submit an answer nobody wrote for it.
  await expect(answerField(page)).toHaveValue('');

  await answerField(page).fill('Answer for the new wait');
  await answerField(page).press('Enter');
  await expect
    .poll(async () => (await controlRequests(page)).map((request) => request.body))
    .toEqual([{ executionId: 6, answers: { verdict: 'Answer for the new wait' } }]);
});

test('an unrelated re-render does not wipe a half-typed answer', async ({ page }) => {
  await answerField(page).fill('Still writing this');
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

  await expect
    .poll(async () => (await controlRequests(page)).map((request) => request.path))
    .toEqual(['/workflows/runs/77/cancel', '/workflows/runs/77/dismiss']);
});

test('cancel takes two steps and says what it really does', async ({ page }) => {
  await control(page, 'Cancel').click();

  await expect(bar(page)).toContainText('Cancel this workflow?');
  await expect(bar(page)).toContainText('keeps everything recorded so far');
  await expect(bar(page)).toContainText('agent panes stay open');
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
  await expect(bar(page)).toContainText("That doesn't apply to this run right now.");
  // The runtime's own message is a diagnostic for a bug report, never product copy.
  await expect(bar(page)).not.toContainText('raw runtime diagnostic text');

  expect(await attached(page)).toEqual([{ runId: 77, status: 'waiting' }]);
  await expect(control(page, 'Pause')).toBeVisible();
});

test('a successful control writes no outcome of its own', async ({ page }) => {
  await control(page, 'Pause').click();
  await expect.poll(async () => (await controlRequests(page)).length).toBe(1);

  // The runtime pushes what actually happened. The client claiming success on its behalf is how a
  // bar comes to show a state the run never reached.
  expect(await attached(page)).toEqual([{ runId: 77, status: 'waiting' }]);
});

test('the latest summary wins, and a summary with no surface takes the bar down', async ({
  page,
}) => {
  await page.locator('[data-action="scenario-failed"]').click();
  await expect.poll(async () => (await attached(page))[0]?.status).toBe('failed');
  await expect(bar(page)).toContainText('A step in this workflow threw.');
  await expect(bar(page)).toContainText('node_function release/triage');

  await page.locator('[data-action="detach"]').click();
  await expect(bar(page)).toHaveCount(0);
  expect(await attached(page)).toEqual([]);
});

test('a paused run can be answered, and says the answer is kept until it resumes', async ({
  page,
}) => {
  await page.locator('[data-action="scenario-paused_continue"]').click();

  await expect(bar(page)).toContainText('Ready to carry on?');
  await expect(bar(page)).toContainText('Your answer is kept.');
  await expect(control(page, 'Resume')).toBeVisible();
  await bar(page).getByRole('button', { name: 'Continue' }).click();

  await expect
    .poll(async () => await controlRequests(page))
    .toEqual([{ method: 'POST', path: '/workflows/runs/77/advance', body: { executionId: 5 } }]);
});

test('opening the log reads the event log and nothing else', async ({ page }) => {
  await page.locator('[data-action="seed-log"]').click();
  await control(page, 'Show log').click();

  await expect(bar(page)).toContainText('recorded line 8');
  const reads = (await requests(page)).filter((request) => request.method === 'GET');
  const logReads = reads.filter((request) => request.path.includes('/events'));
  expect(logReads).toHaveLength(1);
  // From the start of the log: no cursor on the first read.
  expect(logReads[0]?.path).not.toContain('cursor=');
  // Opening the log must not drag the run's tree or executions across the wire.
  expect(reads.some((request) => /\/workflows\/runs\/\d+$/.test(request.path))).toBe(false);
  expect(reads.some((request) => request.path.includes('/executions'))).toBe(false);
});

test('a long log is followed page by page to its end', async ({ page }) => {
  await page.locator('[data-action="long-log"]').click();
  await control(page, 'Show log').click();

  await expect(bar(page)).toContainText('recorded line 600');
  const reads = await eventReads(page);
  // 600 events at 250 a page: three reads, each continuing from the last event it received.
  expect(reads.map((read) => new URL(`http://x${read.path}`).searchParams.get('cursor'))).toEqual([
    null,
    '250',
    '500',
  ]);
});

test('a live log event is appended without reading the log again', async ({ page }) => {
  await page.locator('[data-action="seed-log"]').click();
  await control(page, 'Show log').click();
  await expect(bar(page)).toContainText('recorded line 8');
  await expect.poll(async () => (await eventReads(page)).length).toBe(1);

  await page.locator('[data-action="one-more-line"]').click();
  await expect(bar(page)).toContainText('recorded line 9');
  expect(await eventReads(page)).toHaveLength(1);
});

test('a bar that unmounts and comes back keeps the log it already read', async ({ page }) => {
  await page.locator('[data-action="seed-log"]').click();
  await control(page, 'Show log').click();
  await expect(bar(page)).toContainText('recorded line 8');

  await page.locator('[data-action="toggle-bar"]').click();
  await expect(bar(page)).toHaveCount(0);
  // Pushed while nobody shows the log: the cached list still takes it.
  await page.locator('[data-action="one-more-line"]').click();
  await page.locator('[data-action="toggle-bar"]').click();

  await control(page, 'Show log').click();
  await expect(bar(page)).toContainText('recorded line 9');
  expect(await eventReads(page)).toHaveLength(1);
});

test('the bar, the surface and the palette all read one attached-run cache', async ({ page }) => {
  // Three production readers, one QueryClient, one cache entry. None of them is handed the
  // summary, so the only way they can agree is by genuinely sharing it.
  const surface = page.locator('[data-surface-host]');
  const glow = surface.locator('div.pointer-events-none.absolute.inset-0.z-20');

  await expect(bar(page)).toBeVisible();
  await expect(glow).toHaveCount(1);
  await expect
    .poll(async () => JSON.parse((await page.locator('[data-attention]').textContent()) ?? '{}'))
    .toEqual({ surface: 'waiting', worktree: 'waiting' });

  // The palette withholds a launch from a surface that is already occupied.
  await page.keyboard.press('ControlOrMeta+k');
  const releaseRow = page
    .getByRole('button')
    .filter({ has: page.locator('span:text-is("Release")') });
  await expect(releaseRow).toContainText('Dismiss the current workflow first.');
  await page.keyboard.press('Escape');

  // A later event on the same run: it fails, so the whole page must move together.
  await page.locator('[data-action="scenario-failed"]').click();
  await expect
    .poll(async () => JSON.parse((await page.locator('[data-attention]').textContent()) ?? '{}'))
    .toEqual({ surface: 'error', worktree: 'error' });
  await expect(glow).toHaveCount(1);

  // And a dismissal: the bar goes, the surface stops indicating a workflow, and the palette offers
  // the launch again — all from the one pushed summary.
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

  // An unreadable history is not an empty one.
  await expect(bar(page)).toContainText("Isagi couldn't read this workflow's activity.");
  await expect(bar(page)).not.toContainText('nothing recorded yet');

  await bar(page).getByRole('button', { name: 'Try again' }).click();
  await expect(bar(page)).toContainText('recorded line');
  await expect(bar(page)).not.toContainText("Isagi couldn't read this workflow's activity.");
});

test('action feedback does not outlive the run it belonged to', async ({ page }) => {
  await page.locator('[data-action="reject-next"]').click();
  await control(page, 'Pause').click();
  await expect(bar(page)).toContainText("Couldn't pause the workflow.");

  await page.locator('[data-action="swap-run"]').click();
  await expect.poll(async () => (await attached(page))[0]?.runId).toBe(88);
  await expect(bar(page)).not.toContainText("Couldn't pause the workflow.");
});

test('while a control is in flight the whole cluster waits', async ({ page }) => {
  await page.locator('[data-action="hold-control"]').click();
  await control(page, 'Pause').click();

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

  await page.locator('[data-action="swap-run"]').click();
  await expect.poll(async () => (await attached(page))[0]?.runId).toBe(88);

  await page.locator('[data-action="release-control"]').click();

  await expect(bar(page)).not.toContainText("Couldn't pause the workflow.");
  await expect(control(page, 'Pause')).toBeEnabled();
});

test('a cancel confirmation cannot retarget itself to the run that replaced it', async ({
  page,
}) => {
  await control(page, 'Cancel').click();
  await expect(bar(page)).toContainText('Cancel this workflow?');

  await page.locator('[data-action="swap-run"]').click();
  await expect.poll(async () => (await attached(page))[0]?.runId).toBe(88);

  await expect(bar(page)).not.toContainText('Cancel this workflow?');
  expect((await controlRequests(page)).map((request) => request.path)).toEqual([]);

  await control(page, 'Cancel').click();
  await expect(bar(page)).toContainText('Cancel this workflow?');
  await bar(page).getByRole('button', { name: 'Cancel workflow' }).click();
  await expect
    .poll(async () => (await controlRequests(page)).map((request) => request.path))
    .toEqual(['/workflows/runs/88/cancel']);
});

test('the question is reachable and answerable from the keyboard alone', async ({ page }) => {
  await answerField(page).focus();
  await page.keyboard.type('Keyboard only');
  await page.keyboard.press('Enter');

  await expect
    .poll(async () => (await controlRequests(page)).map((request) => request.body))
    .toEqual([{ executionId: 5, answers: { verdict: 'Keyboard only' } }]);
});
