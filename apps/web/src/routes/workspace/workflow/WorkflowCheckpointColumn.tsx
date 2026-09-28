import { useWorkflowCheckpoint } from '../../../lib/workspace/workflow/queries.js';
import { checkpointCommitLabel, checkpointScopeNames } from './checkpoint-view.js';
import { inspectorCopy } from './copy.js';
import { checkpointFilesTabKey, type DockCheckpoint, type DockRow } from './dock.js';
import { Fields } from './DockFields.js';
import { formatClock } from './timing.js';

/**
 * What one checkpoint execution saved.
 *
 * It stands in for Operations, which a checkpoint never has: the commit the checkpoint was taken on
 * and the scopes it copied, with the file count opening the `files` tab.
 */
export function WorkflowCheckpointColumn({
  checkpoint,
  onOpenTab,
}: {
  readonly checkpoint: DockCheckpoint;
  readonly onOpenTab: (tab: string) => void;
}) {
  if (checkpoint.checkpointId === null) {
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
      key={checkpoint.checkpointId}
      checkpointId={checkpoint.checkpointId}
      onOpenTab={onOpenTab}
    />
  );
}

function SavedCheckpoint({
  checkpointId,
  onOpenTab,
}: {
  readonly checkpointId: number;
  readonly onOpenTab: (tab: string) => void;
}) {
  const detail = useWorkflowCheckpoint(checkpointId);
  const checkpoint = detail.data;
  const files = checkpoint?.scopes.reduce((total, scope) => total + scope.files.length, 0);
  const rows: DockRow[] = [{ label: 'checkpoint', value: `#${checkpointId}` }];
  if (checkpoint) {
    rows.push(
      { label: 'title', value: checkpoint.title },
      { label: 'commit', value: checkpointCommitLabel(checkpoint.commitSha) },
      { label: 'scopes', value: checkpointScopeNames(checkpoint.scopes) },
      {
        label: 'saved',
        value: inspectorCopy.checkpointCounts(checkpoint.scopes.length, files ?? 0),
        dataTab: checkpointFilesTabKey,
      },
      { label: 'at', value: formatClock(checkpoint.createdAt) },
    );
  }
  return (
    <div data-checkpoint-state="saved">
      <Fields rows={rows} onOpenTab={onOpenTab} />
      {detail.error !== null ? (
        <p className="mt-2 font-mono text-[11.5px] text-amber">
          {inspectorCopy.checkpointDetailFailed}
        </p>
      ) : checkpoint === undefined ? (
        <p className="mt-2 font-mono text-[11.5px] text-fg-subtle">
          {inspectorCopy.checkpointFilesLoading}
        </p>
      ) : null}
    </div>
  );
}
