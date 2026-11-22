import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import {
  canvas,
  launchDesktop,
  occupyPort,
  runtimePid,
  windowBackground,
  windowUrl,
  type LaunchedDesktop,
} from './harness.js';

const runtimeOrigin = /^http:\/\/127\.0\.0\.1:\d+$/u;
const screenshots = process.env.ISAGI_E2E_SCREENSHOTS;

let desktop: LaunchedDesktop | undefined;
test.afterEach(async () => {
  await desktop?.close();
  desktop = undefined;
});

async function shot(name: string) {
  if (screenshots && desktop)
    await desktop.window.screenshot({ path: `${screenshots}/${name}.png` });
}

/** Waits until the window shows the runtime's own page, and returns its origin. */
async function handedOff(launched: LaunchedDesktop) {
  await expect.poll(() => windowUrl(launched.app)).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//u);
  const origin = await launched.window.evaluate(() => location.origin);
  expect(origin).toMatch(runtimeOrigin);
  return origin;
}

/** The loader's failure page in the window, once it is showing. */
async function failurePage(launched: LaunchedDesktop) {
  await expect.poll(() => windowUrl(launched.app)).toMatch(/^file:.*\/loader\/loader\.html\?/u);
  const column = launched.window.locator('#column[data-reason]');
  await expect(column).toBeVisible();
  return column;
}

test('starts on the loader and hands off to the runtime-served UI at the runtime origin', async () => {
  desktop = await launchDesktop();
  const origin = await handedOff(desktop);
  // Every `loadURL` is a history entry: the loader in its starting state came first, then the runtime's page.
  const history = await desktop.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]!
      .webContents.navigationHistory.getAllEntries()
      .map((entry) => entry.url),
  );
  expect(history).toHaveLength(2);
  expect(history[0]).toMatch(/^file:.*\/loader\/loader\.html\?theme=light&state=starting$/u);
  expect(history[1]).toBe(`${origin}/`);
  // The page talks to the runtime that served it: same origin, the runtime's health endpoint.
  const health = await desktop.window.evaluate(async () => {
    const response = await fetch('/api/v1/health');
    return { status: response.status, body: (await response.json()) as { data: { name: string } } };
  });
  expect(health.status).toBe(200);
  expect(health.body.data.name).toBe('isagi-runtime');
  // A fresh data directory opens on onboarding, rendered by the web app.
  await expect(desktop.window.getByText('Choose your coding agents.')).toBeVisible();
  // The window is contained: the UI cannot navigate it elsewhere.
  await desktop.window.evaluate(() => {
    location.href = 'https://example.invalid/';
  });
  await expect
    .poll(() => desktop!.output())
    .toContain('[desktop] denied window navigation to https://example.invalid');
  expect(await windowUrl(desktop.app)).toMatch(new RegExp(`^${origin}/`, 'u'));
});

test('a same-origin redirect cannot carry the window outside the UI origin', async () => {
  desktop = await launchDesktop();
  const origin = await handedOff(desktop);
  // A server redirect from an allowed URL to a foreign one: `will-navigate` sees only the allowed start.
  await desktop.app.evaluate(({ session }) => {
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ['http://127.0.0.1/*', 'http://127.0.0.1:*/*'] },
      (details, callback) =>
        callback(
          new URL(details.url).pathname === '/e2e-redirect'
            ? { redirectURL: 'https://example.invalid/escaped' }
            : {},
        ),
    );
  });
  await desktop.window.evaluate(() => {
    location.href = '/e2e-redirect';
  });
  await expect
    .poll(() => desktop!.output())
    .toContain('[desktop] denied window redirect to https://example.invalid');
  expect(await windowUrl(desktop.app)).toMatch(new RegExp(`^${origin}/`, 'u'));
});

for (const theme of ['dark', 'light'] as const) {
  test(`theme ${theme}: window background, loader and the served document agree with config.yaml`, async () => {
    desktop = await launchDesktop({ config: `appearance:\n  theme: ${theme}\n` });
    expect((await windowBackground(desktop.app)).toUpperCase()).toBe(canvas[theme]);
    const origin = await handedOff(desktop);
    // The served HTML carries the theme before any script runs; the page keeps it.
    const served = await desktop.window.evaluate(async () => (await fetch('/')).text());
    expect(served).toMatch(new RegExp(`<html[^>]* data-theme="${theme}"`, 'u'));
    expect(await desktop.window.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
    expect(origin).toMatch(runtimeOrigin);
    await shot(`ui-${theme}`);
  });

  test(`theme ${theme}: the loader paints the configured theme`, async () => {
    // A runtime that cannot start leaves the loader up, so its document can be read.
    const held = await occupyPort();
    try {
      desktop = await launchDesktop({
        config: `appearance:\n  theme: ${theme}\nserver:\n  port: ${held.port}\n`,
      });
      await failurePage(desktop);
      expect(await desktop.window.evaluate(() => document.documentElement.dataset.theme)).toBe(
        theme,
      );
      expect((await windowBackground(desktop.app)).toUpperCase()).toBe(canvas[theme]);
      const canvasColor = await desktop.window.evaluate(
        () => getComputedStyle(document.body).backgroundColor,
      );
      expect(canvasColor).toBe(theme === 'dark' ? 'rgb(36, 39, 58)' : 'rgb(230, 233, 239)');
      await shot(`loader-failed-${theme}`);
    } finally {
      await held.release();
    }
  });
}

test('an unparseable config.yaml paints the default theme, and the runtime it stops shows the failure page', async () => {
  // The desktop cannot read a theme from it, so it paints the default; the runtime refuses to start on a YAML syntax
  // error (its own startup failure, in the logs), so the window shows the failure page in the default theme.
  desktop = await launchDesktop({ config: 'appearance:\n  theme: dark\n  : [unclosed\n' });
  expect((await windowBackground(desktop.app)).toUpperCase()).toBe(canvas.light);
  const column = await failurePage(desktop);
  await expect(column).toHaveAttribute('data-reason', 'exited_before_ready');
  expect(await desktop.window.evaluate(() => document.documentElement.dataset.theme)).toBe('light');
});

test('an invalid harnesses section keeps the configured theme and the runtime page shows config_invalid', async () => {
  desktop = await launchDesktop({
    config: 'appearance:\n  theme: dark\nharnesses:\n  claude:\n    enabled: maybe\n',
  });
  expect((await windowBackground(desktop.app)).toUpperCase()).toBe(canvas.dark);
  await handedOff(desktop);
  await expect(desktop.window.getByText('Your harness config is invalid.')).toBeVisible();
  expect(await desktop.window.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
});

test('a runtime that cannot start shows the failure page, keeps the app running, and Quit exits', async () => {
  const held = await occupyPort();
  try {
    desktop = await launchDesktop({ config: `server:\n  port: ${held.port}\n` });
    const column = await failurePage(desktop);
    await expect(column).toHaveAttribute('data-reason', 'exited_before_ready');
    await expect(
      desktop.window.getByRole('heading', { name: 'The runtime stopped while starting.' }),
    ).toBeVisible();
    await expect(desktop.window.locator('.chip')).toContainText(/exit code \d+/u);
    // Still running: the main process answers.
    expect(await desktop.app.evaluate(({ app }) => app.isReady())).toBe(true);
    const exited = new Promise<number | null>((resolveExit) =>
      desktop!.app.process().once('exit', (code) => resolveExit(code)),
    );
    await desktop.window.getByRole('button', { name: 'Quit Isagi' }).click();
    expect(await exited).toBe(0);
  } finally {
    await held.release();
  }
});

test('a runtime that crashes mid-session shows the failure page and the app keeps running', async () => {
  desktop = await launchDesktop();
  await handedOff(desktop);
  process.kill(runtimePid(desktop.dataDirectory), 'SIGKILL');
  const column = await failurePage(desktop);
  await expect(column).toHaveAttribute('data-reason', 'exited_after_ready');
  await expect(desktop.window.getByRole('heading', { name: 'The runtime stopped.' })).toBeVisible();
  await expect(desktop.window.locator('.chip')).toContainText('signal SIGKILL');
  expect(await desktop.app.evaluate(({ app }) => app.isReady())).toBe(true);
  await shot('loader-crashed');
});

test('a crash still shows the failure page when the UI holds an unload guard', async () => {
  desktop = await launchDesktop();
  await handedOff(desktop);
  // A same-origin frame with unsaved changes, as the Code Server editor has: its guard would veto leaving the page.
  await desktop.window.evaluate(() => {
    const frame = document.createElement('iframe');
    frame.id = 'guarded';
    frame.srcdoc = '<button id="edit">edit</button>';
    document.body.append(frame);
  });
  // A listener keeps Playwright from answering the dialog itself, so only the desktop's own handling resolves it.
  const dialogs: string[] = [];
  desktop.window.on('dialog', (dialog) => void dialogs.push(dialog.type()));
  const guarded = desktop.window.frameLocator('#guarded');
  await guarded.locator('#edit').click();
  await desktop.window.evaluate(() => {
    const frame = document.getElementById('guarded') as HTMLIFrameElement;
    frame.contentWindow!.addEventListener('beforeunload', (event) => {
      event.preventDefault();
      event.returnValue = '';
    });
  });
  process.kill(runtimePid(desktop.dataDirectory), 'SIGKILL');
  const column = await failurePage(desktop);
  await expect(column).toHaveAttribute('data-reason', 'exited_after_ready');
  // The guard really fired, and the desktop overrode it.
  expect(dialogs).toContain('beforeunload');
  expect(desktop.output()).toContain('[desktop] overrode the page unload guard');
});

test('Open logs opens the logs directory, which holds the runtime failure and its own reason', async () => {
  const held = await occupyPort();
  try {
    desktop = await launchDesktop({ config: `server:\n  port: ${held.port}\n` });
    await failurePage(desktop);
    const logsDirectory = await desktop.app.evaluate(({ app, shell }) => {
      const opened: string[] = [];
      (globalThis as { isagiOpenedPaths?: string[] }).isagiOpenedPaths = opened;
      shell.openPath = async (path: string) => {
        opened.push(path);
        return '';
      };
      return app.getPath('logs');
    });
    // An unpackaged run keeps its logs beside its data directory.
    expect(logsDirectory).toBe(join(realpathSync(desktop.dataDirectory), 'logs'));
    await desktop.window.getByRole('button', { name: 'Open logs' }).click();
    await expect
      .poll(() =>
        desktop!.app.evaluate(
          () => (globalThis as { isagiOpenedPaths?: string[] }).isagiOpenedPaths ?? [],
        ),
      )
      .toEqual([logsDirectory]);
    // The record there carries the runtime's own last output: why it would not start, not only that it exited.
    const record = JSON.parse(
      readFileSync(join(logsDirectory, 'managed-runtime-failure.json'), 'utf8'),
    ) as { reason: string; lastOutput: string };
    expect(record.reason).toBe('exited_before_ready');
    expect(record.lastOutput).toContain(String(held.port));
    expect(record.lastOutput).toMatch(/EADDRINUSE|address already in use/iu);
  } finally {
    await held.release();
  }
});
