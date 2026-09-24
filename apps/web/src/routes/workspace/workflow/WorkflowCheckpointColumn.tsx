import type { WorkflowExecutionCheckpointDto } from '@isagi/contracts';

import { useWorkflowCheckpoint } from '../../../lib/workspace/workflow/queries.js';
import {
  checkpointBaseLabel,
  checkpointWarningsView,
  shortCheckpointId,
  type CheckpointStandingNote,
  type CheckpointWarningDisplay,
} from './checkpoint-view.js';
import { inspectorCopy } from './copy.js';
import { checkpointFilesTabKey, type DockCheckpoint, type DockRow } from './dock.js';
import { Fields } from './DockFields.js';
import type { InspectorSelection } from './selection.js';

/**
 * What one checkpoint visit saved, and then what it did not.
 *
 * It stands in for Operations and Evidence, which a checkpoint never has. The top half comes from
 * the execution's own summary and shows at once; the detail is read only for this capture's warning
 * groups and its parent. Until those arrive, or if they cannot be read, the column says so and never
 * claims that everything was captured: that line is a claim about the warnings, and it needs them.
 */
export function WorkflowCheckpointColumn({
  runId,
  checkpoint,
  onOpenTab,
  onSelect,
}: {
  readonly runId: number;
  readonly checkpoint: DockCheckpoint;
  readonly onOpenTab: (tab: string) => void;
  readonly onSelect: (selection: InspectorSelection) => void;
}) {
  if (checkpoint.summary === null) {
    return (
      <p data-checkpoint-state={checkpoint.state} className="py-1.5 text-[12.5px] text-fg-muted">
        {checkpoint.state === 'capturing'
          ? inspectorCopy.checkpointCapturingNote
          : inspectorCopy.checkpointNothingSavedNote}
      </p>
    );
  }
  return (
    <SavedCheckpoint
      key={checkpoint.summary.checkpointId}
      runId={runId}
      summary={checkpoint.summary}
      parentOf={checkpoint.parent}
      onOpenTab={onOpenTab}
      onSelect={onSelect}
    />
  );
}

function SavedCheckpoint({
  runId,
  summary,
  parentOf,
  onOpenTab,
  onSelect,
}: {
  readonly runId: number;
  readonly summary: WorkflowExecutionCheckpointDto;
  readonly parentOf: DockCheckpoint['parent'];
  readonly onOpenTab: (tab: string) => void;
  readonly onSelect: (selection: InspectorSelection) => void;
}) {
  const detail = useWorkflowCheckpoint(runId, summary.checkpointId);
  const record = detail.data?.checkpoint;
  const warnings = checkpointWarningsView(
    summary.base,
    detail.error ? null : record?.warningGroups,
  );

  const rows: DockRow[] = [
    { label: 'id', value: shortCheckpointId(summary.checkpointId) },
    { label: 'base', value: checkpointBaseLabel(summary.base) },
    {
      label: 'captured',
      value: inspectorCopy.checkpointCounts(
        summary.counts.scopes,
        summary.counts.files,
        summary.counts.absences,
      ),
      dataTab: checkpointFilesTabKey,
    },
    parentRow(record?.parentCheckpointId, detail.error !== null, parentOf),
  ];

  return (
    <div data-checkpoint-state="saved">
      <Fields rows={rows} onOpenTab={onOpenTab} onSelect={onSelect} />
      <div aria-hidden className="mt-2.5 mb-3 h-px bg-line/22" />
      {warnings.kind === 'loading' ? (
        <p className="mb-3 font-mono text-[11.5px] text-fg-subtle">
          {inspectorCopy.checkpointWarningsLoading}
        </p>
      ) : warnings.kind === 'failed' ? (
        <p className="mb-3 font-mono text-[11.5px] text-amber">
          {inspectorCopy.checkpointWarningsFailed}
        </p>
      ) : (
        <>
          {warnings.groups.map((group) => (
            <WarningGroup key={group.reason} group={group} />
          ))}
          {warnings.allClear && (
            <p data-checkpoint-all-clear className="mb-3 text-[12.5px] text-fg-muted">
              {inspectorCopy.checkpointAllClear}
            </p>
          )}
        </>
      )}
      {warnings.standing.map((note) => (
        <StandingNote key={note} note={note} />
      ))}
    </div>
  );
}

/**
 * The parent, as the visit that saved it wherever that visit is in the run state, and as its bare id
 * otherwise. Unknown until the detail is read, and said to be unknown if it cannot be.
 */
function parentRow(
  parentCheckpointId: string | null | undefined,
  failed: boolean,
  parentOf: DockCheckpoint['parent'],
): DockRow {
  if (parentCheckpointId === undefined) {
    return {
      label: 'parent',
      value: failed ? inspectorCopy.provenanceUnknown : '…',
      tone: 'dim',
    };
  }
  if (parentCheckpointId === null) {
    return { label: 'parent', value: inspectorCopy.checkpointNoParent, tone: 'dim' };
  }
  const short = shortCheckpointId(parentCheckpointId);
  const visit = parentOf(parentCheckpointId);
  return visit === null
    ? { label: 'parent', value: short }
    : {
        label: 'parent',
        value: `${visit.label} · ${short}`,
        selection: { kind: 'execution', executionId: visit.executionId },
      };
}

function WarningGroup({ group }: { readonly group: CheckpointWarningDisplay }) {
  const copy = inspectorCopy.checkpointWarnings[group.reason];
  return (
    <section data-checkpoint-warning={group.reason} className="mb-3.5">
      <h4 className="m-0 mb-0.5 flex items-baseline gap-2 text-[13px] font-semibold text-fg">
        {copy.heading}
        <span className="font-mono text-[11px] font-normal text-amber">
          {group.count.toLocaleString('en-US')}
        </span>
      </h4>
      <p className="m-0 mb-1.5 text-[12.5px] leading-snug text-fg-muted">{copy.body}</p>
      {group.samples.length > 0 && (
        <ul className="m-0 list-none p-0 font-mono text-[11.5px] text-fg-muted">
          {group.samples.map((path) => (
            <li key={path} className="truncate py-px" title={path}>
              {path}
            </li>
          ))}
          {group.more > 0 && (
            <li className="py-px text-fg-subtle">
              {inspectorCopy.checkpointWarningMore(group.more)}
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

/** A fact about every checkpoint of a kind, so it is dim and never amber. */
function StandingNote({ note }: { readonly note: CheckpointStandingNote }) {
  const copy =
    note === 'ignored_paths'
      ? inspectorCopy.checkpointWarnings.ignored_paths_not_surveyed
      : inspectorCopy.checkpointStanding[note];
  return (
    <section data-checkpoint-standing={note} className="mb-3">
      <h4 className="m-0 mb-0.5 text-[13px] font-normal text-fg-muted">{copy.heading}</h4>
      <p className="m-0 text-[12.5px] leading-snug text-fg-subtle">{copy.body}</p>
    </section>
  );
}
