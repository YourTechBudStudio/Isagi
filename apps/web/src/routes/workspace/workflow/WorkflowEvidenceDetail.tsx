import type { WorkflowEvidenceDto } from '@isagi/contracts';

import { useWorkflowOperationQuery } from '../../../lib/workspace/workflow/queries.js';
import { inspectorCopy } from './copy.js';
import type { DockRow } from './dock.js';
import { shortHash } from './dock.js';
import { Fields } from './DockFields.js';
import { formatBytes } from './format.js';
import { formatClock } from './timing.js';
import { WorkflowEvidenceContent } from './WorkflowEvidenceContent.js';
import { WorkflowOperationProvenance } from './WorkflowOperationProvenance.js';

/**
 * Everything one record is, in the order the questions get asked.
 *
 * What it is, where it came from, and then the bytes themselves. The provenance of the source
 * operation is fetched only when this pane is open and the source actually resolved to one, because
 * `getOperation` is the one read permitted to touch the filesystem for a transcript locator and the
 * dock can be resized away entirely.
 *
 * There is no Copy-reference action. The reference is on screen as text, and an action whose only
 * effect is to put visible text on the clipboard is a button that has to be explained.
 */
export function WorkflowEvidenceDetail({
  runId,
  record,
}: {
  readonly runId: number;
  readonly record: WorkflowEvidenceDto;
}) {
  const sourceOperationKey = record.source.kind === 'none' ? null : record.source.operationKey;
  const operation = useWorkflowOperationQuery(runId, sourceOperationKey, {
    enabled: sourceOperationKey !== null,
  });

  return (
    <div className="min-h-0 flex-1 overflow-auto px-4.5 py-3.5">
      <h4 className="m-0 text-[14px] font-semibold text-fg">{record.title}</h4>
      <p className="mt-0.5 mb-2.5 font-mono text-[11px] text-fg-subtle">
        {record.evidenceKey} ·{' '}
        {inspectorCopy.evidenceCapturedAt(
          formatClock(record.capturedAt),
          shortHash(record.artifactHash),
        )}{' '}
        · #{record.executionId}, attempt {record.attemptId}
      </p>

      <div className="grid gap-4.5 md:grid-cols-2">
        <Fields rows={recordRows(record)} />
        <div>
          <Fields rows={sourceRows(record)} />
          {sourceOperationKey !== null && (
            <div className="mt-2.5 rounded-lg border border-l-[3px] border-l-amber border-line/30 bg-canvas/50 px-2.5 py-2">
              <header className="mb-1.5 flex flex-wrap items-baseline gap-2 font-mono text-[12px]">
                <span className="text-fg">{sourceOperationKey}</span>
                <span className="text-fg-subtle">· {inspectorCopy.provenanceOnDemand}</span>
              </header>
              {operation.error ? (
                <p className="font-mono text-[11.5px] text-amber">
                  {inspectorCopy.provenanceFailed}
                </p>
              ) : operation.data ? (
                <WorkflowOperationProvenance operation={operation.data.operation} />
              ) : (
                <p className="font-mono text-[11.5px] text-fg-subtle">
                  {inspectorCopy.provenanceLoading}
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="mt-3 border-t border-line/20 pt-2.5">
        <p className="mb-1.5 flex items-center gap-2 text-[10.5px] font-semibold tracking-[0.09em] text-fg-subtle uppercase">
          <span aria-hidden className="block h-0.5 w-3.5 rounded-full bg-cyan/70" />
          {inspectorCopy.evidenceContentHeading}
        </p>
        <WorkflowEvidenceContent key={record.evidenceKey} runId={runId} record={record} />
      </div>
    </div>
  );
}

function recordRows(record: WorkflowEvidenceDto): readonly DockRow[] {
  const labels = Object.entries(record.labels);
  const rows: DockRow[] = [
    { label: 'role', value: record.role },
    labels.length === 0
      ? { label: 'labels', value: inspectorCopy.evidenceNoLabels, tone: 'dim' }
      : {
          label: 'labels',
          value: labels.map(([key, value]) => `${key}: ${String(value)}`).join(' · '),
        },
    {
      label: 'content',
      value: `${record.content.kind} · ${record.content.mediaType} · ${formatBytes(
        record.content.byteSize,
      )}`,
    },
  ];
  if (record.content.sourcePath !== null) {
    // The path is where the bytes were read from, not a window onto what is there now. Saying so
    // is what stops someone opening the file and expecting to find what this record holds.
    rows.push({
      label: 'from',
      value: `${record.content.sourcePath} · ${inspectorCopy.evidenceFromPath(
        formatClock(record.capturedAt),
      )}`,
    });
  }
  rows.push({ label: 'ref', value: record.content.contentRef, tone: 'dim' });
  return rows;
}

/**
 * Where the record came from, and how confidently.
 *
 * `unresolved` is a recorded answer, not a missing one, so it says what was looked for and what was
 * not found rather than leaving the operation line blank.
 */
function sourceRows(record: WorkflowEvidenceDto): readonly DockRow[] {
  if (record.source.kind === 'none') {
    return [
      { label: 'source', value: inspectorCopy.evidenceSourceNone, tone: 'dim' },
      { label: 'note', value: inspectorCopy.evidenceSourceNoneNote, tone: 'dim' },
    ];
  }
  const { kind, attribution, agentSessionId, operationKey } = record.source;
  const rows: DockRow[] = [
    {
      label: 'source',
      value: `${kind.replaceAll('_', ' ')} · ${
        attribution === 'inferred_latest_operation'
          ? inspectorCopy.evidenceSourceInferred
          : attribution
      }`,
      tone: attribution === 'exact' ? 'ok' : 'warn',
    },
  ];
  if (agentSessionId !== null) {
    rows.push({ label: 'session', value: `agent_session ${agentSessionId}` });
  }
  rows.push(
    operationKey === null
      ? {
          label: 'operation',
          value: inspectorCopy.evidenceSourceUnresolvedOperation,
          tone: 'warn',
        }
      : { label: 'operation', value: operationKey },
  );
  return rows;
}
