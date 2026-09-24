import { useEffect, useMemo, useRef, useState } from 'react';

import type { WorkflowCheckpointSummaryDto } from '@isagi/contracts';

import type { WorkflowRunState } from '../../../lib/workspace/workflow/model.js';
import {
  useWorkflowCheckpoint,
  useWorkflowCheckpointList,
} from '../../../lib/workspace/workflow/queries.js';
import {
  checkpointBaseLabel,
  checkpointExportCommand,
  groupCheckpoints,
  resolveCheckpointSelection,
} from './checkpoint-view.js';
import { inspectorCopy } from './copy.js';
import { formatClock } from './timing.js';
import { WorkflowCheckpointFiles } from './WorkflowCheckpointFiles.js';

/**
 * The Checkpoints tab: what an export of each checkpoint in the run would contain.
 *
 * Every checkpoint the run saved on the left, grouped by the node that saved it; the chosen one's
 * final file tree in the middle; the chosen file and the export line on the right. Nothing here
 * compares layers or counts warnings. Those belong to the dock's column for one visit, and a timeline
 * of badges would turn a list of places to look into a list of alarms.
 *
 * The choice is the inspector's, not the panel's, so it survives the tab being closed. A choice that
 * still exists is kept whatever the dock does. Only when there is none does the panel seed one: the
 * dock's own checkpoint visit, or the most recent checkpoint.
 */
export function WorkflowCheckpointsPanel({
  runId,
  state,
  chosenId,
  dockCheckpointId,
  onSeed,
  onSelect,
}: {
  readonly runId: number;
  readonly state: WorkflowRunState | null;
  readonly chosenId: string | null;
  /** The checkpoint of the visit the dock shows, if it shows one. Used only to seed. */
  readonly dockCheckpointId: string | null;
  /** Records a choice without moving the dock. */
  readonly onSeed: (checkpointId: string) => void;
  /** A person's choice, which also moves the dock to the visit that saved it. */
  readonly onSelect: (checkpoint: WorkflowCheckpointSummaryDto) => void;
}) {
  const list = useWorkflowCheckpointList(state);
  const items = list.data ?? null;
  const groups = useMemo(() => groupCheckpoints(state, items ?? []), [state, items]);

  const resolved =
    items === null ? null : resolveCheckpointSelection(chosenId, items, dockCheckpointId);
  useEffect(() => {
    if (resolved !== null && resolved !== chosenId) onSeed(resolved);
  }, [resolved, chosenId, onSeed]);

  const selected = items?.find((item) => item.checkpointId === resolved) ?? null;

  return (
    <div className="flex min-h-0 flex-1 bg-canvas/55">
      <div className="min-h-0 flex-none basis-68 overflow-auto border-r border-line/22 py-1.5">
        {list.error ? (
          <div className="px-4 py-3">
            <p className="text-[12.5px] text-fg-muted">{inspectorCopy.checkpointsFailed}</p>
            <button
              type="button"
              onClick={() => void list.refetch()}
              className="mt-1.5 rounded-md bg-white/6 px-2.5 py-1 font-mono text-[11px] text-fg-muted transition duration-micro ease-expo hover:bg-white/10"
            >
              {inspectorCopy.checkpointsRetry}
            </button>
          </div>
        ) : items === null ? (
          <p className="px-4 py-3 font-mono text-[11.5px] text-fg-subtle">
            {inspectorCopy.checkpointsLoading}
          </p>
        ) : items.length === 0 ? (
          <p className="px-4 py-3 font-mono text-[11.5px] text-fg-subtle">
            {inspectorCopy.checkpointsEmpty}
          </p>
        ) : (
          <div role="listbox" aria-label={inspectorCopy.checkpointsTab}>
            {groups.map((group) => (
              <div key={group.key} role="group" aria-label={group.label}>
                <p className="px-3.5 pt-2 pb-0.5 font-mono text-[11px] text-fg-subtle">
                  <span className="text-fg">{group.label}</span> ·{' '}
                  {inspectorCopy.checkpointVisits(group.items.length)}
                </p>
                {group.items.map((item) => (
                  <CheckpointItem
                    key={item.checkpointId}
                    item={item}
                    selected={item.checkpointId === resolved}
                    onSelect={() => onSelect(item)}
                  />
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
      {selected === null ? (
        <div className="min-h-0 flex-1" />
      ) : (
        <SelectedCheckpoint
          key={selected.checkpointId}
          runId={runId}
          state={state}
          item={selected}
        />
      )}
    </div>
  );
}

function CheckpointItem({
  item,
  selected,
  onSelect,
}: {
  readonly item: WorkflowCheckpointSummaryDto;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      data-checkpoint-item={item.checkpointId}
      onClick={onSelect}
      className={`flex w-full gap-2.5 border-l-2 px-3.5 py-1.5 text-left transition duration-micro ease-expo ${
        selected ? 'border-l-cyan bg-cyan/6' : 'border-l-transparent hover:bg-elevated/60'
      }`}
    >
      <span
        aria-hidden
        className={`mt-1.5 size-2 flex-none rounded-full border-[1.5px] border-cyan ${
          selected ? 'bg-cyan' : ''
        }`}
      />
      <span className="min-w-0">
        <span className="block truncate text-[13px] text-fg">{item.title}</span>
        <span className="mt-0.5 block font-mono text-[10.5px] text-fg-subtle">
          {formatClock(item.createdAt)} · {checkpointBaseLabel(item.base)}
        </span>
      </span>
    </button>
  );
}

/**
 * The chosen checkpoint's tree and file.
 *
 * Its counts come from the visit's own summary in run state when that visit is there, which it is for
 * every checkpoint this client has seen committed; the detail is read only otherwise.
 */
function SelectedCheckpoint({
  runId,
  state,
  item,
}: {
  readonly runId: number;
  readonly state: WorkflowRunState | null;
  readonly item: WorkflowCheckpointSummaryDto;
}) {
  const inline = state?.executions.get(item.executionId)?.checkpoint ?? null;
  const detail = useWorkflowCheckpoint(runId, inline === null ? item.checkpointId : null);
  const counts = inline?.counts ?? detail.data?.checkpoint.counts ?? null;

  if (counts === null) {
    return (
      <p className="min-h-0 flex-1 px-4.5 py-3 font-mono text-[11.5px] text-fg-subtle">
        {detail.error ? inspectorCopy.checkpointDetailFailed : inspectorCopy.checkpointFilesLoading}
      </p>
    );
  }
  return (
    <WorkflowCheckpointFiles
      runId={runId}
      checkpointId={item.checkpointId}
      base={item.base}
      counts={counts}
      layout="panes"
      aside={<ExportLine command={checkpointExportCommand(item.checkpointId, runId)} />}
    />
  );
}

/**
 * The command #47 will run, shown and copyable before it does.
 *
 * The note under it is not optional: without it the line reads as something that works today.
 */
function ExportLine({ command }: { readonly command: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  const copy = () => {
    void navigator.clipboard?.writeText(command).then(
      () => {
        setCopied(true);
        if (timer.current !== null) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1500);
      },
      // The text is on screen and selectable; a refused clipboard costs a manual copy, nothing more.
      () => undefined,
    );
  };

  return (
    <div className="mt-4">
      <div className="flex items-center gap-2.5 rounded-lg border border-cyan/30 bg-cyan/5 py-2 pr-2.5 pl-3 font-mono text-[11.5px]">
        <span aria-hidden className="text-fg-subtle">
          $
        </span>
        <code data-checkpoint-export className="min-w-0 flex-1 break-all text-fg select-all">
          {command}
        </code>
        <button
          type="button"
          data-checkpoint-export-copy
          onClick={copy}
          className="flex-none rounded-md border border-line/35 bg-elevated/70 px-2.5 py-0.5 text-[11px] text-fg-muted transition duration-micro ease-expo hover:border-line/70 hover:text-fg"
        >
          {copied ? inspectorCopy.checkpointCopied : inspectorCopy.checkpointCopy}
        </button>
      </div>
      <p className="mt-1.5 font-mono text-[11px] text-fg-subtle">
        {inspectorCopy.checkpointExportNote}
      </p>
    </div>
  );
}
