import { expect, test, type Page } from '@playwright/test';

// The fixture's OSC 52 controls (`FixtureApp.tsx`) copy exactly these texts.
const REPLAYED_TEXT = 'replayed osc52 copy';
const LIVE_TEXT = 'live osc52 copy · héllo 世界';
const FAILURE_TITLE = 'Could not copy to your clipboard.';

const rendererFor = (projectName: string) => (projectName === 'dom-fallback' ? 'dom' : 'webgl');

/**
 * A program's OSC 52 copy travels the real path: fixture socket, attachment, controller, real
 * xterm parse, shared host integration, `navigator.clipboard`. The clipboard is replaced with a
 * recorder so no permission is needed and a refusal can be staged.
 */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const state = window as unknown as {
      clipboardRecorderWrites: string[];
      clipboardRecorderRejects: boolean;
    };
    state.clipboardRecorderWrites = [];
    state.clipboardRecorderRejects = false;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (text: string) => {
          state.clipboardRecorderWrites.push(text);
          return state.clipboardRecorderRejects
            ? Promise.reject(new DOMException('Write permission denied.', 'NotAllowedError'))
            : Promise.resolve();
        },
      },
    });
  });
});

test('a live OSC 52 copy reaches the local clipboard', async ({ page }, testInfo) => {
  await openFixture(page, testInfo.project.name);
  await revealed(page);
  await page.locator('[data-action="osc52-live"]').click();
  await expect.poll(async () => tailText(page)).toContain('osc52-live-marker');
  await expect.poll(() => clipboardWrites(page)).toEqual([LIVE_TEXT]);
  await expect(page.getByText(FAILURE_TITLE)).toHaveCount(0);
});

test('an OSC 52 read request is never answered', async ({ page }, testInfo) => {
  await openFixture(page, testInfo.project.name);
  await revealed(page);
  const inputBefore = (await readCounters(page)).input.length;
  await page.locator('[data-action="osc52-read"]').click();
  await expect.poll(async () => tailText(page)).toContain('osc52-read-marker');
  const counters = await readCounters(page);
  expect(counters.input.slice(inputBefore).filter((data) => data.includes('52;'))).toEqual([]);
  expect(await clipboardWrites(page)).toEqual([]);
});

test('an OSC 52 copy in replayed history does not write, and live copies still do', async ({
  page,
}, testInfo) => {
  await openFixture(page, testInfo.project.name, 'manual=1');
  await page.locator('[data-action="open-socket"]').click();
  await page.locator('[data-action="replay-start"]').click();
  await page.locator('[data-action="osc52-replayed"]').click();
  await page.locator('[data-action="replay-end"]').click();
  await revealed(page);
  expect(await tailText(page)).toContain('osc52-replayed');
  expect(await clipboardWrites(page)).toEqual([]);

  await page.locator('[data-action="osc52-live"]').click();
  await expect.poll(() => clipboardWrites(page)).toEqual([LIVE_TEXT]);
  expect(await clipboardWrites(page)).not.toContain(REPLAYED_TEXT);
});

test('a refused clipboard write shows one toast', async ({ page }, testInfo) => {
  await openFixture(page, testInfo.project.name);
  await revealed(page);
  await page.evaluate(() => {
    (window as unknown as { clipboardRecorderRejects: boolean }).clipboardRecorderRejects = true;
  });
  await page.locator('[data-action="osc52-live"]').click();
  await expect(page.getByText(FAILURE_TITLE)).toHaveCount(1);
  // The toast now sits over the fixture controls, so the repeat is dispatched, not clicked.
  await page.locator('[data-action="osc52-live"]').dispatchEvent('click');
  await expect.poll(async () => (await clipboardWrites(page)).length).toBe(2);
  await expect(page.getByText(FAILURE_TITLE), 'a repeat replaces the toast').toHaveCount(1);
});

async function openFixture(page: Page, projectName: string, query = '') {
  const suffix = query ? `&${query}` : '';
  await page.goto(`/?renderer=${rendererFor(projectName)}&recipe=shell${suffix}`);
}

async function revealed(page: Page) {
  await expect(page.locator('[data-session="1"]')).toHaveAttribute('data-phase', 'revealed');
  await expect(page.locator('[data-terminal-cover]')).toHaveCount(0);
}

async function clipboardWrites(page: Page) {
  return page.evaluate(
    () => (window as unknown as { clipboardRecorderWrites: string[] }).clipboardRecorderWrites,
  );
}

async function readCounters(page: Page) {
  return JSON.parse((await page.locator('[data-counters]').textContent()) ?? '{}') as {
    readonly input: readonly string[];
  };
}

async function tailText(page: Page) {
  await page.locator('[data-action="inspect"]').click();
  const all = JSON.parse((await page.locator('[data-inspection]').textContent()) ?? '[]') as Array<{
    readonly tailText: string;
  }>;
  return all[0]?.tailText ?? '';
}
