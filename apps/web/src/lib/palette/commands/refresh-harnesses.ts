import { Effect } from 'effect';
import { RefreshCw } from 'lucide-react';

import type { ControlPlaneSnapshot, DocsHarnessResult } from '@isagi/contracts';

import { agentSessionCopy, docsResultCopy, harnessRefreshCopy } from '../../../copy/index.js';
import { controlPlaneQuery } from '../../control-plane/queries.js';
import { harnessLabel } from '../../harness-labels.js';
import { refreshAndRead } from '../../state/policy.js';
import { refreshInventory } from '../../workspace/runtime-data.js';
import type { CommandOutcome, PaletteCommand } from '../types.js';
import { runtimeFailureContent } from '../workflow-failure.js';

/**
 * Re-runs the runtime's host inventory (which agent binaries exist and work),
 * then re-reads the control plane so the session picker and any unavailable
 * panes reproject from the new snapshot. The runtime checks once at startup; if
 * that check failed or timed out, this is the explicit way to look again
 * without restarting it (ADR 0002: discovery stays behind an explicit trigger).
 */
export const refreshHarnessesCommand: PaletteCommand = {
  id: 'refresh-harnesses',
  label: harnessRefreshCopy.label,
  icon: RefreshCw,
  group: 'global',
  running: harnessRefreshCopy.running,
  run: async (_values, ctx) => {
    let generation: number;
    try {
      // A runtime write: a closed palette must not abort a refresh already in flight.
      ({ generation } = await ctx.app(Effect.uninterruptible(refreshInventory())));
    } catch (error) {
      return {
        kind: 'error',
        content: runtimeFailureContent(error, harnessRefreshCopy.refreshFailed.title),
      };
    }

    // The read begins after the refresh settled, so it reflects it.
    let snapshot: ControlPlaneSnapshot;
    try {
      snapshot = await ctx.app(refreshAndRead(controlPlaneQuery));
    } catch (error) {
      // The recheck happened; only reading it back failed. Say both halves.
      return {
        kind: 'error',
        content: {
          ...runtimeFailureContent(error, harnessRefreshCopy.readFailed.title),
          tone: 'warning',
        },
      };
    }

    return harnessRefreshOutcome(snapshot, generation);
  },
};

/**
 * What the fresh snapshot says is ready, and why the rest is not, in the pane's
 * own words. The refresh also re-runs isagi-docs reconciliation, whose failures
 * arrive as data rather than as a failed request; any for this refresh turn the
 * result into a partial success with the runtime's detail framed as diagnostic.
 */
export function harnessRefreshOutcome(
  snapshot: ControlPlaneSnapshot,
  generation: number,
): CommandOutcome {
  const ready: string[] = [];
  const unready: string[] = [];
  for (const entry of snapshot.harnesses) {
    const label = harnessLabel(entry.harness);
    if (entry.launch.status === 'launchable') {
      ready.push(label);
    } else {
      const status = agentSessionCopy.launchBlock.status[entry.launch.reason];
      unready.push(`${label} (${status})`);
    }
  }

  const docsFailures = docsFailuresFor(snapshot, generation);
  const lines = [
    ready.length ? harnessRefreshCopy.ready.body(ready.join(', ')) : null,
    unready.length ? harnessRefreshCopy.unready(unready.join(', ')) : null,
    docsFailures.length
      ? harnessRefreshCopy.docsFailed.body(
          docsFailures.map((failure) => harnessLabel(failure.harness)).join(', '),
        )
      : null,
  ].filter((line): line is string => line !== null);
  const body = lines.length ? lines.join(' ') : undefined;
  const diagnostic = docsFailures.length
    ? {
        label: harnessRefreshCopy.docsFailed.diagnosticLabel,
        detail: docsFailures.map(formatDocsFailure).join('\n'),
      }
    : undefined;

  if (ready.length === 0) {
    return {
      kind: 'result',
      content: {
        tone: 'warning',
        title: harnessRefreshCopy.noneReady.title,
        body,
        ...(diagnostic ? { diagnostic } : {}),
      },
    };
  }
  if (diagnostic) {
    return {
      kind: 'result',
      content: { tone: 'warning', title: harnessRefreshCopy.docsFailed.title, body, diagnostic },
    };
  }
  return {
    kind: 'result',
    content: { tone: 'success', title: harnessRefreshCopy.ready.title, body },
  };
}

/**
 * Failed docs installs as of this refresh or later. A result from an older
 * inventory generation predates it (the runtime skips reconciliation when, say,
 * config is invalid), so it is not reported. A newer one (another refresh landed
 * between this POST and the read) is the current state, the same snapshot the
 * harness list comes from, so its failures stay visible.
 */
function docsFailuresFor(
  snapshot: ControlPlaneSnapshot,
  generation: number,
): readonly DocsHarnessResult[] {
  const result = snapshot.reconciliation.lastResult;
  if (!result || result.inventoryGeneration < generation || result.outcome === 'succeeded') {
    return [];
  }
  return result.results.filter((entry) => entry.action === 'failed');
}

function formatDocsFailure(failure: DocsHarnessResult): string {
  const reason = failure.reason
    ? docsResultCopy.reason[failure.reason]
    : docsResultCopy.action.failed;
  const line = `${harnessLabel(failure.harness)}: ${reason}`;
  return failure.diagnostic ? `${line}\n  ${failure.diagnostic}` : line;
}
