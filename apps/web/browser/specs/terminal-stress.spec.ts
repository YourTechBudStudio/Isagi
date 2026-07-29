import { expect, test, type Page } from '@playwright/test';

test.describe.configure({ retries: 0, mode: 'serial' });

test('100 surface relocations retain one resource and alternate real destination nodes', async ({
  page,
}, testInfo) => {
  await open(page, testInfo.project.name);
  await revealed(page);
  await mark(page);
  for (let index = 0; index < 100; index += 1) {
    await page.locator('[data-action="surface-relocate"]').click();
    const destination = index % 2 === 0 ? 'target' : 'source';
    await expect(page.locator(`[data-destination="${destination}"] .xterm`)).toHaveCount(1);
  }
  await assertSingleResource(page);
});

test('100 zen relocations retain one resource through overlapping registration', async ({
  page,
}, testInfo) => {
  await open(page, testInfo.project.name);
  await revealed(page);
  await mark(page);
  for (let index = 0; index < 100; index += 1) {
    await page.locator('[data-action="zen-relocate"]').click();
    const destination = index % 2 === 0 ? 'target' : 'source';
    await expect(page.locator(`[data-destination="${destination}"] .xterm`)).toHaveCount(1);
  }
  await assertSingleResource(page);
});

test('one through eight hidden entries park bounded resources beneath the parking root', async ({
  page,
}, testInfo) => {
  for (let sessions = 1; sessions <= 8; sessions += 1) {
    await open(page, testInfo.project.name, `sessions=${sessions}&bytes=1024&maxHidden=8`);
    await expect(page.locator('[data-phase="revealed"]')).toHaveCount(sessions);
    await page.locator('[data-action="toggle"]').click();
    await expect(page.locator('[data-destination] .xterm')).toHaveCount(0);
    await expect(page.locator('[data-terminal-parking-root] .xterm')).toHaveCount(sessions);
    const counters = await readCounters(page);
    expect(counters.terminalsCreated).toBe(sessions);
    expect(counters.terminalsDisposed).toBe(0);
    expect(counters.socketsCreated).toBe(sessions);
  }
});

test('count eviction removes deterministic oldest victims and retains four parked resources', async ({
  page,
}, testInfo) => {
  await open(page, testInfo.project.name, 'sessions=8&maxHidden=4&bytes=1024');
  await expect(page.locator('[data-phase="revealed"]')).toHaveCount(8);
  await page.locator('[data-action="toggle"]').click();
  await expect.poll(async () => (await readCounters(page)).terminalsDisposed).toBe(4);
  await expect(page.locator('[data-terminal-parking-root] .xterm')).toHaveCount(4);
  expect((await readCounters(page)).terminalDisposals).toEqual([0, 1, 2, 3]);
});

test('memory eviction uses estimated cells, is deterministic, and never evicts visible resources', async ({
  page,
}, testInfo) => {
  await open(page, testInfo.project.name, 'sessions=4&maxHidden=4&maxMemory=5&bytes=32768');
  await expect(page.locator('[data-phase="revealed"]')).toHaveCount(4);
  const visible = await inspect(page);
  expect(visible.reduce((total, state) => total + state.estimatedBytes, 0)).toBeGreaterThan(
    5 * 1024 * 1024,
  );
  expect((await readCounters(page)).terminalsDisposed).toBe(0);
  await page.locator('[data-action="toggle"]').click();
  await expect
    .poll(async () => (await readCounters(page)).terminalsDisposed)
    .toBeGreaterThanOrEqual(3);
  const counters = await readCounters(page);
  expect(counters.terminalDisposals.slice(0, 3)).toEqual([0, 1, 2]);
  await expect(page.locator('[data-terminal-parking-root] .xterm')).toHaveCount(1);
});

test('zero retention evicts heavy state and a fresh attachment reconstructs while covered', async ({
  page,
}, testInfo) => {
  await open(page, testInfo.project.name, 'maxHidden=0&bytes=32768');
  await revealed(page);
  const before = await inspect(page);
  await page.locator('[data-action="toggle"]').click();
  await expect.poll(async () => (await readCounters(page)).terminalsDisposed).toBe(1);
  await page.locator('[data-action="toggle"]').click();
  await page.locator('[data-action="reattach"]').click();
  await expect(page.locator('[data-terminal-cover]')).toHaveCount(1);
  await expect(page.locator('[data-session="1"]')).toHaveAttribute('data-phase', 'revealed');
  const after = await inspect(page);
  expect(after[0]!.baseY).toBeGreaterThanOrEqual(before[0]!.baseY);
  const counters = await readCounters(page);
  expect(counters.terminalsCreated).toBe(2);
  expect(counters.claimAttempts).toBe(2);
});

test('provider teardown balances every observable resource and removes the parking root', async ({
  page,
}, testInfo) => {
  await open(page, testInfo.project.name, 'sessions=3&bytes=1024');
  await expect(page.locator('[data-phase="revealed"]')).toHaveCount(3);
  await page.locator('[data-action="destroy-provider"]').click();
  await expect(page.locator('[data-provider-destroyed]')).toHaveCount(1);
  await expect.poll(async () => (await readCounters(page)).terminalsDisposed).toBe(3);
  const counters = await readCounters(page);
  expect(counters.socketsClosed).toBe(counters.socketsCreated);
  expect(counters.framesActive).toBe(0);
  expect(counters.tasksActive).toBe(0);
  expect(counters.resizeObserversActive).toBe(0);
  expect(counters.webglDisposed).toBe(counters.webglCreated);
  await expect(page.locator('[data-terminal-parking-root]')).toHaveCount(0);
});

async function open(page: Page, projectName: string, query = '') {
  const renderer = projectName === 'dom-fallback' ? 'dom' : 'webgl';
  await page.goto(`/?renderer=${renderer}${query ? `&${query}` : ''}`);
}

async function revealed(page: Page) {
  await expect(page.locator('[data-session="1"]')).toHaveAttribute('data-phase', 'revealed');
}

async function mark(page: Page) {
  await page.locator('.xterm').evaluate((element) => (element.dataset.fixtureIdentity = 'stable'));
}

async function assertSingleResource(page: Page) {
  await expect(page.locator('.xterm')).toHaveAttribute('data-fixture-identity', 'stable');
  const counters = await readCounters(page);
  expect(counters.claimAttempts).toBe(1);
  expect(counters.terminalsCreated).toBe(1);
  expect(counters.socketsCreated).toBe(1);
}

async function inspect(page: Page) {
  await page.locator('[data-action="inspect"]').click();
  return JSON.parse((await page.locator('[data-inspection]').textContent()) ?? '[]') as Array<{
    baseY: number;
    estimatedBytes: number;
  }>;
}

async function readCounters(page: Page) {
  return JSON.parse((await page.locator('[data-counters]').textContent()) ?? '{}') as {
    claimAttempts: number;
    terminalsCreated: number;
    terminalsDisposed: number;
    terminalDisposals: number[];
    socketsCreated: number;
    socketsClosed: number;
    webglCreated: number;
    webglDisposed: number;
    tasksActive: number;
    framesActive: number;
    resizeObserversActive: number;
  };
}
