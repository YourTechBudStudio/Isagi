import type { WorkflowConversationMessage } from '@yourtechbudstudio/isagi-workflow-sdk';

/**
 * Authoring helpers the fixture workflows themselves use, inside their callbacks.
 *
 * Distinct from `drive.ts`, which is the *test's* side of the same fixtures: nothing here may reach
 * for the harness, because all of it runs as ordinary author code inside a workflow.
 */

/**
 * The last thing the agent said, as an author reads it.
 *
 * The fallback is deliberate and constant. A capture's title, role and labels are its recorded
 * identity and must never vary with the content, so an empty conversation has to produce *some*
 * text rather than a differently-shaped call — and a constant keeps the call fingerprint stable
 * across a repair that finds the conversation in a different state.
 */
export function latestAssistantText(
  history: readonly WorkflowConversationMessage[],
  fallback = '(the agent said nothing)',
): string {
  for (const message of [...history].reverse()) {
    if (message.role !== 'assistant') continue;
    const text = message.parts
      .map((part) => part.text)
      .join('\n')
      .trim();
    if (text.length > 0) return text;
  }
  return fallback;
}

/**
 * Fixture variants that must misbehave exactly once per run, keyed by run.
 *
 * Keyed by `runId` rather than held in a module-level boolean because the runtime's test script
 * runs with `--experimental-test-isolation=none`: every test file shares one process, so a single
 * flag would be process-global and two tests exercising the same fixture could answer each other's
 * question.
 *
 * Keying by run does **not** make that isolation automatic, and an earlier version of this comment
 * wrongly claimed it did. Every harness builds its own SQLite database in a fresh directory, so run
 * ids restart at `1` in each test while this map is a module singleton — two tests reaching the
 * same marker are both "run 1". `reset()` is therefore required between tests, and the fixture's
 * own `publish…` helper calls it so no test has to remember. Keying by run still earns its place:
 * it keeps a *single* run's two entries to one marker distinct from one another.
 *
 * The one hard constraint: nothing this decides may reach a capture's `title`, `role`, `labels`,
 * `source` or `content`. Those four are the recorded call identity, and a repaired callback whose
 * identity differs is refused as `operation_request_changed` — which would make the reuse test pass
 * for entirely the wrong reason.
 */
export class OncePerRun {
  private readonly seen = new Map<string, Set<number>>();

  /** True the first time a given (marker, run) pair is reached, false afterwards. */
  firstTime(marker: string, runId: number): boolean {
    let runs = this.seen.get(marker);
    if (!runs) {
      runs = new Set();
      this.seen.set(marker, runs);
    }
    if (runs.has(runId)) return false;
    runs.add(runId);
    return true;
  }

  /** Throws the first time a given (marker, run) pair is reached, and never again. */
  failOnce(marker: string, runId: number): void {
    if (!this.firstTime(marker, runId)) return;
    throw new Error(`fixture: deliberate failure at ${marker} after the capture returned`);
  }

  reset(): void {
    this.seen.clear();
  }
}
