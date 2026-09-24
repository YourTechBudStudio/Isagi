import type { WorkflowOperationDto } from '@isagi/contracts';

import { inspectorCopy } from './copy.js';
import type { DockRow } from './dock.js';
import { Fields } from './DockFields.js';

/**
 * Who ran an operation, where, and with what.
 *
 * One field list, shown in two places: inline in the evidence detail pane, where it answers "where
 * did this come from", and as a disclosure on every operation card, where it answers "what actually
 * ran here". Two renderings of the same block would drift on exactly the rows that matter, because
 * they are the rows nobody looks at until something has gone wrong.
 *
 * **Every unknown is written out.** A blank cell reads as a value nobody bothered to render; these
 * say which of several different things happened — a model inherited from a session that was
 * spawned elsewhere, a native session that could not be correlated, a harness with no transcript
 * convention at all, a transcript whose file has since rotated away, and a route that did not look.
 * Telling those apart is the difference between a person knowing where to go next and guessing.
 */
export function WorkflowOperationProvenance({
  operation,
}: {
  readonly operation: WorkflowOperationDto;
}) {
  return <Fields rows={provenanceRows(operation)} />;
}

function provenanceRows(operation: WorkflowOperationDto): readonly DockRow[] {
  const provenance = operation.provenance;
  const rows: DockRow[] = [
    unknownable('harness', provenance.harness),
    // A send inherits the session's spawn settings, which are not known at the call site. That is a
    // different kind of unknown from "nothing recorded it", and saying so stops a reader chasing a
    // model that was never a fact about this call.
    provenance.model === null
      ? dim('model', modelUnknownFor(operation))
      : { label: 'model', value: provenance.model },
    unknownable('effort', provenance.effort),
    provenance.harnessSessionId === null
      ? dim('native session', inspectorCopy.provenanceSessionUncorrelated)
      : { label: 'native session', value: provenance.harnessSessionId },
    { label: 'attribution', value: provenance.attribution.replaceAll('_', ' ') },
    unknownable('cwd', provenance.cwd),
    provenance.runtime === null
      ? dim('runtime', inspectorCopy.provenanceUnknown)
      : {
          label: 'runtime',
          value: inspectorCopy.provenanceRuntime(
            provenance.runtime.runtimeId,
            provenance.runtime.incarnationId,
          ),
        },
    transcriptRow(provenance.transcript),
    usageRow(operation),
    { label: 'code pin', value: provenance.artifactHash },
  ];
  return rows;
}

/**
 * Three states, told apart.
 *
 * Absent means the route did not evaluate it — `getOperation` is the only read permitted to touch
 * the filesystem, so a card fed by the listing legitimately has no answer. `null` means no locator
 * could be built for this harness at all. A locator with `available: false` means the file was
 * looked for and is not there, which is the state a rotated transcript produces — and the path is
 * still shown, because it is where a person would go looking.
 */
function transcriptRow(transcript: WorkflowOperationDto['provenance']['transcript']): DockRow {
  if (transcript === undefined) {
    return dim('transcript', inspectorCopy.provenanceTranscriptNotChecked);
  }
  if (transcript === null) return dim('transcript', inspectorCopy.provenanceTranscriptNoLocator);
  return {
    label: 'transcript',
    value: `${
      transcript.available
        ? inspectorCopy.provenanceTranscriptAvailable
        : inspectorCopy.provenanceTranscriptUnavailable
    } · ${transcript.locator}`,
    tone: transcript.available ? 'ok' : 'warn',
  };
}

/**
 * What the provider reported, verbatim, with no total.
 *
 * The three input counts are grouped on one line because their relationship is the point: for a
 * cached prompt the cache reads dwarf the uncached input, and a single "input" figure would be a
 * number this run never reported. No total is computed for the same reason — the contract is
 * explicit that the runtime does not choose on a presentation's behalf, and a figure a person has
 * to catch is worse than one they can ask for.
 */
function usageRow(operation: WorkflowOperationDto): DockRow {
  const usage = operation.provenance.usage;
  if (usage === null) return dim('usage', inspectorCopy.provenanceUsageNone);
  const number = (value: number | null): string =>
    value === null ? inspectorCopy.provenanceUnknown : value.toLocaleString();
  const cost =
    usage.costUsd === null ? inspectorCopy.provenanceUnknown : `$${usage.costUsd.toFixed(4)}`;
  return {
    label: 'usage',
    value: [
      `in ${number(usage.inputTokens)} · cache read ${number(usage.cacheReadInputTokens)} · cache write ${number(usage.cacheCreationInputTokens)}`,
      `out ${number(usage.outputTokens)}`,
      `cost ${cost}`,
    ].join(' · '),
  };
}

function modelUnknownFor(operation: WorkflowOperationDto): string {
  return operation.capability === 'send_agent_prompt'
    ? inspectorCopy.provenanceModelInherited
    : inspectorCopy.provenanceUnknown;
}

function unknownable(label: string, value: string | null): DockRow {
  return value === null ? dim(label, inspectorCopy.provenanceUnknown) : { label, value };
}

function dim(label: string, value: string): DockRow {
  return { label, value, tone: 'dim' };
}
