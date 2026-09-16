import { Effect } from 'effect';

import type { CapturedLabel } from '../labels.js';
import { fenceOf, type EngineDeps, type SegmentContext, type SegmentFault } from './shared.js';

/**
 * Records a failed display-name capture.
 *
 * Written *after* the commit that created the record it names, because until then there is nothing
 * the diagnostic is about. Its code is `label_failed`, which is deliberately not a segment failure
 * code: the segment succeeded, and a cosmetic name must never be able to break a run.
 */
export function recordLabelDiagnostic(
  deps: EngineDeps,
  ctx: SegmentContext,
  frameId: number,
  executionId: number | null,
  captured: CapturedLabel,
): Effect.Effect<void, SegmentFault> {
  const diagnostic = captured.diagnostic;
  if (!diagnostic) return Effect.void;
  const fence = fenceOf(deps, ctx);
  return deps.runs
    .appendDiagnostic({
      runId: fence.runId,
      kind: 'log',
      frameId,
      executionId,
      attemptId: fence.attemptId,
      detail: {
        value: {
          source: 'runtime_diagnostic',
          code: 'label_failed',
          level: 'warning',
          message: `The display name for ${diagnostic.what} was not captured because ${diagnostic.reason}.`,
        },
      },
    })
    .pipe(Effect.asVoid);
}
