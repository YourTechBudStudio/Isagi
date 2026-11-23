// App shortcuts in the desktop window, against the runtime-served UI and a real PTY.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { launchDesktop, windowUrl, type LaunchedDesktop } from './harness.js';

/** The palette's focusable panel inside its scrim, as the production tree renders it. */
const PALETTE = 'div.fixed.inset-0.z-50 > div[tabindex="-1"]';

let desktop: LaunchedDesktop | undefined;
let repository: string | undefined;
test.afterEach(async () => {
  await desktop?.close();
  desktop = undefined;
  if (repository) rmSync(repository, { recursive: true, force: true });
  repository = undefined;
});

async function runtimePage(launched: LaunchedDesktop) {
  await expect.poll(() => windowUrl(launched.app)).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//u);
  return launched.window;
}

/** A one-commit Git repository to register as a project. */
function gitRepository() {
  const path = mkdtempSync(join(tmpdir(), 'isagi-desktop-e2e-repo-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: path, stdio: 'ignore' });
  git('init', '-b', 'main');
  git(
    '-c',
    'user.name=e2e',
    '-c',
    'user.email=e2e@example.invalid',
    'commit',
    '--allow-empty',
    '-m',
    'init',
  );
  return path;
}

test('Mod+K with focus in a real terminal pane opens the palette', async () => {
  repository = gitRepository();
  // An explicit empty harness policy completes onboarding, so the workspace opens directly.
  desktop = await launchDesktop({ config: 'harnesses: {}\n' });
  const page = await runtimePage(desktop);

  // The project and a terminal surface are set up through the runtime's own API, from the page,
  // so the request carries the same credentials the UI's own requests do.
  const created = await page.evaluate(async (path) => {
    const call = async (url: string, body?: unknown) => {
      const response = await fetch(
        url,
        body === undefined
          ? {}
          : {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            },
      );
      const text = await response.text();
      if (!response.ok) throw new Error(`${url}: ${response.status} ${text}`);
      return (JSON.parse(text) as { data: unknown }).data;
    };
    await call('/api/v1/projects', { path });
    const workspace = (await call('/api/v1/workspace')) as {
      projects: { worktrees: { id: number }[] }[];
    };
    const worktreeId = workspace.projects[0]!.worktrees[0]!.id;
    return (await call(`/api/v1/worktrees/${worktreeId}/surfaces`, {
      initialPane: { kind: 'terminal_session' },
    })) as { worktreeId: number; surfaceId: number };
  }, repository);
  expect(created.surfaceId).toBeGreaterThan(0);

  // A Linux client, as the original report: xterm turns Control+K into ^K for the PTY and cancels
  // the event, which a macOS client's Cmd+K never hit. Emulated on a macOS host (both Isagi and xterm
  // read the platform from `navigator`), native elsewhere.
  if (process.platform === 'darwin') {
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'Linux x86_64' });
      Object.defineProperty(Navigator.prototype, 'userAgentData', {
        get: () => ({ platform: 'Linux' }),
      });
    });
  }
  // The new worktree opens on its only surface, the terminal.
  await page.reload();
  const terminal = page.getByRole('region', { name: 'Terminal' }).locator('.xterm');
  await expect(terminal).toBeVisible();
  await terminal.click();
  await expect(page.getByRole('textbox', { name: 'Terminal input' })).toBeFocused();
  // The shell is live and reading keys from this pane (the renderer is WebGL, so its output is not
  // in the DOM; a file the shell creates is the observable).
  const marker = join(repository, 'isagi-e2e-ready');
  await page.keyboard.type(`touch '${marker}'`);
  await page.keyboard.press('Enter');
  await expect.poll(() => existsSync(marker)).toBe(true);

  await page.keyboard.press('Control+k');
  await expect(page.locator(PALETTE)).toBeVisible();
});

test('the editor route is same-origin with the UI, so the page can read keys from an editor frame', async () => {
  desktop = await launchDesktop({ config: 'harnesses: {}\n' });
  const page = await runtimePage(desktop);
  // The pane resolves the projection's `/editor/<id>/` path against the page's origin; whatever the
  // runtime answers there (no editor runs in this test), a frame from that route must be readable
  // from the page, which is what lets the pane attach it as a shortcut source.
  const frame = await page.evaluate(async () => {
    const element = document.createElement('iframe');
    element.src = '/editor/1/';
    const loaded = new Promise((resolve) =>
      element.addEventListener('load', resolve, { once: true }),
    );
    document.body.append(element);
    await loaded;
    try {
      const frameWindow = element.contentWindow!;
      frameWindow.addEventListener('keydown', () => {}, true);
      return { origin: frameWindow.location.origin, error: null };
    } catch (error) {
      return { origin: null, error: String(error) };
    }
  });
  expect(frame).toEqual({ origin: await page.evaluate(() => location.origin), error: null });
});
