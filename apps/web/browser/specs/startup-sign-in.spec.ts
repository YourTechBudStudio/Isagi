import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * The production startup gate against a runtime that wants a sign-in.
 *
 * The page is the production `App`, wired as `main.tsx` wires it. The runtime is
 * played from here, outside the page, with request and socket routing: its
 * signed-in state lives in this process, so it survives the reload a successful
 * sign-in performs. The fake answers only what an empty, onboarded workspace
 * reads; any other runtime request fails the test.
 *
 * Locators are production ones: roles, accessible names and copy the user reads.
 */

const PASSWORD = 'correct horse';

const CONTROL_PLANE = {
  onboardingComplete: true,
  configStatus: 'valid',
  configDiagnostic: null,
  policyRevision: 'startup-fixture-policy',
  inventory: { status: 'ready', generation: 1, environment: 'trusted' },
  harnesses: [],
  reconciliation: {
    desiredFingerprint: null,
    runningFingerprint: null,
    lastCompletedFingerprint: null,
    lastAppliedFingerprint: null,
    lastResult: null,
  },
  editorProvisioning: { status: 'ready', version: '1.0.0' },
};

const CLIENT_SETTINGS = {
  terminal: {
    scrollbackLines: 5_000,
    cache: { idleTtlMinutes: 180, maxHiddenSessions: 4, maxEstimatedBufferMiB: 64 },
  },
  appearance: { theme: 'dark' },
};

/** The runtime's answers for an empty, onboarded workspace, by method and path under `/api/v1`. */
const READS: Record<string, unknown> = {
  'GET /control-plane': CONTROL_PLANE,
  'GET /client-settings': CLIENT_SETTINGS,
  'GET /workspace': { projects: [] },
  'GET /workspace/active-context': { activeContext: { projectId: null, worktreeId: null } },
  'GET /workspace/durable-sessions': { sessions: [] },
  'GET /auth/session': { credential: 'cookie' },
};

interface FakeRuntime {
  /** Whether this browser holds a valid sign-in. */
  signedIn: boolean;
  /** How long a login takes to answer, standing in for the throttle. */
  loginDelayMs: number;
  /** Every API request, as `METHOD /path`, newest last. */
  readonly requests: string[];
  /** Requests the fake has no answer for; any entry fails the test. */
  readonly unanswered: string[];
  /** Paths refused with `auth_required` even while signed in: a sign-in lapsing mid-boot. */
  readonly refuse: Set<string>;
  /** Ends every open events socket from the runtime's side. */
  readonly closeSockets: () => void;
}

const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

const refusal = (code: string) => ({
  error: {
    code,
    status: 401,
    message: 'runtime-authored, never shown',
    requestId: 'startup-fixture',
    ...(code === 'auth_login_failed' ? { data: {} } : {}),
  },
});

async function playRuntime(page: Page): Promise<FakeRuntime> {
  const sockets: { close: () => Promise<void> }[] = [];
  const runtime: FakeRuntime = {
    signedIn: false,
    loginDelayMs: 0,
    requests: [],
    unanswered: [],
    refuse: new Set(),
    closeSockets: () => {
      for (const socket of sockets.splice(0)) void socket.close();
    },
  };

  await page.route(/\/api\/v1\//, async (route) => {
    const request = route.request();
    const key = `${request.method()} ${new URL(request.url()).pathname.replace(/^.*\/api\/v1/, '')}`;
    runtime.requests.push(key);

    if (key === 'POST /auth/login') {
      await new Promise((resolve) => setTimeout(resolve, runtime.loginDelayMs));
      const body = request.postDataJSON() as { username?: string; password?: string };
      if (body.password !== PASSWORD) return json(route, 401, refusal('auth_login_failed'));
      runtime.signedIn = true;
      return json(route, 200, { data: null, meta: { requestId: 'startup-fixture' } });
    }
    if (!runtime.signedIn || runtime.refuse.has(key)) {
      return json(route, 401, refusal('auth_required'));
    }
    if (key in READS) {
      return json(route, 200, { data: READS[key], meta: { requestId: 'startup-fixture' } });
    }
    runtime.unanswered.push(key);
    return json(route, 404, {
      error: {
        code: 'api_route_not_found',
        status: 404,
        message: 'not faked',
        requestId: 'startup-fixture',
      },
    });
  });

  // The events socket: open while signed in (sending nothing), refused otherwise. A browser
  // cannot see why an upgrade was refused, which is why the web probes `auth.session` after a close.
  await page.routeWebSocket(/\/api\/v1\//, (socket) => {
    if (!runtime.signedIn) {
      void socket.close({ code: 1008 });
      return;
    }
    sockets.push(socket);
  });

  return runtime;
}

const signInView = (page: Page) => page.getByText('isagi login', { exact: true });
const expiryTitle = (page: Page) => page.getByRole('heading', { name: 'Your sign-in expired.' });
const workbench = (page: Page) => page.getByText('No worktrees on the canvas.');
const runtimeUnreachable = (page: Page) => page.getByText('Runtime unreachable.');
const openingSplash = (page: Page) => page.getByText('Opening your workspace…');
/** A line in the sign-in output region. A replaced line fades out while the next one enters. */
const outputLine = (page: Page, text: string) =>
  page.locator('[aria-live="polite"]').getByText(text, { exact: true });

async function signIn(page: Page, username: string, password: string) {
  await page.getByRole('textbox', { name: 'Username' }).fill(username);
  await page.getByLabel('Password').fill(password);
  await page.getByLabel('Password').press('Enter');
}

/** Revalidation, as a user returning to the tab (or coming back online) causes it. */
async function revalidate(page: Page) {
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
}

const count = (runtime: FakeRuntime, key: string) =>
  runtime.requests.filter((request) => request === key).length;

let runtime: FakeRuntime;

test.beforeEach(async ({ page }) => {
  runtime = await playRuntime(page);
});

test.afterEach(() => {
  expect(runtime.unanswered, 'every runtime request the page made was faked').toEqual([]);
});

test('first visit: sign-in view, a wrong pair, the throttle line, then a reload into the workbench', async ({
  page,
}) => {
  await page.goto('./');
  await expect(signInView(page)).toBeVisible();
  await expect(runtimeUnreachable(page)).toHaveCount(0);
  // The refused boot read is not retried into "Runtime unreachable".
  await page.waitForTimeout(1_500);
  expect(count(runtime, 'GET /control-plane')).toBeLessThanOrEqual(2);
  await expect(page.getByText("// it's a lock, not a vault")).toBeVisible();

  // A wrong pair: the code and its line, amber, in the same form; the username stays typed.
  await signIn(page, 'noorain', 'wrong');
  await expect(outputLine(page, "auth_login_failed · that pair didn't match.")).toBeVisible();
  await expect(signInView(page)).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Username' })).toHaveValue('noorain');
  await expect(page.getByLabel('Password')).toBeEnabled();

  // A held login (the throttle after misses): checking, then the slow line, inputs disabled.
  runtime.loginDelayMs = 2_500;
  await signIn(page, 'noorain', 'still wrong');
  await expect(outputLine(page, '# checking…')).toBeVisible();
  await expect(page.getByLabel('Password')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'sign in' })).toBeDisabled();
  await expect(outputLine(page, '# taking a beat after the last miss…')).toBeVisible();
  await expect(outputLine(page, "auth_login_failed · that pair didn't match.")).toBeVisible();

  // The right pair reloads the page, and boot lands in the workbench.
  runtime.loginDelayMs = 0;
  const reloaded = page.waitForEvent('framenavigated');
  await signIn(page, 'noorain', PASSWORD);
  await reloaded;
  await expect(workbench(page)).toBeVisible();
  await expect(signInView(page)).toHaveCount(0);
});

test('expiry with the workbench open: expiry screen, then the sign-in view, then the workbench', async ({
  page,
}) => {
  // A controllable clock, so the reads below can be made stale and revalidation would refetch them.
  await page.clock.install();
  runtime.signedIn = true;
  await page.goto('./');
  await expect(workbench(page)).toBeVisible();
  await expect(openingSplash(page)).toHaveCount(0);

  // The sign-in lapses; the runtime drops the events socket, and the reconnect probe meets a 401.
  runtime.signedIn = false;
  runtime.closeSockets();
  await expect(expiryTitle(page)).toBeVisible();
  await expect(workbench(page)).toHaveCount(0);
  await expect(signInView(page)).toHaveCount(0);

  // Signed out, the gate reads nothing: with every read stale, revalidation still sends none.
  await page.clock.fastForward(60_000);
  const before = runtime.requests.length;
  await revalidate(page);
  await page.waitForTimeout(1_000);
  expect(runtime.requests.slice(before).filter((r) => !r.startsWith('GET /auth/session'))).toEqual(
    [],
  );

  // Sign in opens the sign-in view without a reload.
  let navigated = false;
  page.on('framenavigated', () => (navigated = true));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(signInView(page)).toBeVisible();
  expect(navigated).toBe(false);

  await signIn(page, 'noorain', PASSWORD);
  await expect(workbench(page)).toBeVisible();
  expect(navigated).toBe(true);
});

test('a refusal while the opening splash plays: the expiry screen, and nothing of the splash', async ({
  page,
}) => {
  // The gate's own reads pass; the workspace's first read, made while the splash plays, is refused.
  runtime.signedIn = true;
  runtime.refuse.add('GET /workspace');
  await page.goto('./');
  await expect(expiryTitle(page)).toBeVisible();
  await expect(openingSplash(page)).toHaveCount(0);
  await expect(page.locator('div.fixed.inset-0.z-50')).toHaveCount(0);
  await expect(workbench(page)).toHaveCount(0);
});
