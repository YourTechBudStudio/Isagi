export interface WaitOptions {
  attempts?: number;
  intervalMs?: number;
  timeoutMs?: number;
}

const defaultWaitOptions = {
  attempts: 40,
  intervalMs: 250,
  timeoutMs: 1_000,
};

export async function waitForRuntimeHealth(runtimeUrl: string, options?: WaitOptions) {
  const healthUrl = new URL('/rpc/health', runtimeUrl).toString();
  await waitForRpcHealth(healthUrl, options);
}

export async function waitForWebServer(webUrl: string, options?: WaitOptions) {
  await waitForHttpOk(webUrl, options);
}

async function waitForRpcHealth(url: string, options: WaitOptions = {}) {
  await waitForOk(url, options, async () => {
    const response = await fetchWithTimeout(
      url,
      options.timeoutMs ?? defaultWaitOptions.timeoutMs,
      {
        method: 'POST',
      },
    );

    if (!response.ok) {
      throw new Error(`${url} responded with ${response.status}`);
    }

    const payload = (await response.json()) as { json?: { ok?: unknown } };

    if (payload.json?.ok !== true) {
      throw new Error(`${url} did not return a healthy oRPC payload`);
    }
  });
}

async function waitForHttpOk(url: string, options: WaitOptions = {}) {
  await waitForOk(url, options, async () => {
    const response = await fetchWithTimeout(url, options.timeoutMs ?? defaultWaitOptions.timeoutMs);

    if (!response.ok) {
      throw new Error(`${url} responded with ${response.status}`);
    }
  });
}

async function waitForOk(url: string, options: WaitOptions, check: () => Promise<void>) {
  const attempts = options.attempts ?? defaultWaitOptions.attempts;
  const intervalMs = options.intervalMs ?? defaultWaitOptions.intervalMs;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await check();
      return;
    } catch (error) {
      lastError = error;
    }

    if (attempt < attempts) {
      await delay(intervalMs);
    }
  }

  throw new Error(
    `Timed out waiting for ${url}${lastError instanceof Error ? `: ${lastError.message}` : ''}`,
  );
}

async function fetchWithTimeout(url: string, timeoutMs: number, init?: RequestInit) {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function delay(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
