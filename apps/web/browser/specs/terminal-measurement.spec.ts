import { expect, test } from '@playwright/test';

test.describe.configure({ retries: 0, mode: 'serial' });

for (const mebibytes of [1, 5, 10]) {
  test(`records causal milestones for deterministic ${mebibytes} MiB cold replay`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    const renderer = testInfo.project.name === 'dom-fallback' ? 'dom' : 'webgl';
    const bytes = mebibytes * 1024 * 1024;
    await page.goto(`/?renderer=${renderer}&recipe=codex&bytes=${bytes}&manual=1`);
    const longTaskAvailable = await page.evaluate(() => {
      if (!PerformanceObserver.supportedEntryTypes.includes('longtask')) return false;
      Object.defineProperty(window, 'fixtureLongestTask', { value: 0, writable: true });
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const state = window as typeof window & { fixtureLongestTask: number };
          state.fixtureLongestTask = Math.max(state.fixtureLongestTask, entry.duration);
        }
      }).observe({ type: 'longtask', buffered: true });
      return true;
    });
    await page.locator('[data-action="open-socket"]').click();
    await page.locator('[data-action="replay-start"]').click();
    await page.locator('[data-action="replay-chunks"]').click();
    await page.locator('[data-action="replay-end"]').click();
    await expect(page.locator('[data-session="1"]')).toHaveAttribute('data-phase', 'revealed', {
      timeout: 90_000,
    });
    const counters = JSON.parse((await page.locator('[data-counters]').textContent()) ?? '{}') as {
      lastReplayChunkAt: number;
      replayEndAt: number;
      milestones: Array<{ type: string; at: number }>;
      replayChunksSubmitted: number;
    };
    const parse = find(counters, 'parse_barrier_completed');
    const firstRender = find(counters, 'render_observed');
    const qualified = find(counters, 'activation_render_qualified');
    const reveal = find(counters, 'reveal_published');
    expect(counters.replayChunksSubmitted).toBeGreaterThan(0);
    // Cold duration is owed from `replay_end` — the moment the session says its history is
    // complete — not from the last chunk, which leaves the delivery and handling of
    // `replay_end` itself outside the measurement.
    expect(counters.replayEndAt).toBeGreaterThanOrEqual(counters.lastReplayChunkAt);
    expect(parse).toBeGreaterThanOrEqual(counters.replayEndAt);
    expect(qualified).toBeGreaterThanOrEqual(parse);
    expect(reveal).toBeGreaterThanOrEqual(qualified);
    const longestTask = longTaskAvailable
      ? await page.evaluate(
          () => (window as typeof window & { fixtureLongestTask: number }).fixtureLongestTask,
        )
      : null;
    const memory = await page.evaluate(async () => {
      const performanceWithMemory = performance as Performance & {
        measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }>;
      };
      return performanceWithMemory.measureUserAgentSpecificMemory
        ? (await performanceWithMemory.measureUserAgentSpecificMemory()).bytes
        : null;
    });
    testInfo.annotations.push({
      type: 'measurement',
      description: JSON.stringify({
        mebibytes,
        lastReplayChunkAt: counters.lastReplayChunkAt,
        replayEndAt: counters.replayEndAt,
        parseBarrierAt: parse,
        firstRenderAt: firstRender,
        activationRenderAt: qualified,
        revealAt: reveal,
        // Every cold milestone as a duration owed from `replay_end`, which is the acceptance
        // point. The absolute stamps above stay for ordering evidence.
        sinceReplayEndMs: {
          parseBarrier: parse - counters.replayEndAt,
          firstRender: firstRender - counters.replayEndAt,
          activationRender: qualified - counters.replayEndAt,
          reveal: reveal - counters.replayEndAt,
        },
        longestTask,
        browserMemoryBytes: memory,
      }),
    });
  });
}

function find(counters: { milestones: Array<{ type: string; at: number }> }, type: string) {
  const event = counters.milestones.find((candidate) => candidate.type === type);
  expect(event, `missing ${type} milestone`).toBeDefined();
  return event!.at;
}

declare global {
  interface Window {
    fixtureLongestTask: number;
  }
}
