import { Bot, Code, SquareTerminal, X } from 'lucide-react';

import { Button } from '../../components/Button.js';
import { MonoAside } from '../../components/MonoAside.js';
import { emptySurfaceCopy } from '../../copy/index.js';
import { useEditorAvailable } from '../../lib/control-plane/queries.js';
import {
  handleDispatchedCommandError,
  useCommandDispatcher,
} from '../../lib/palette/dispatcher.js';
import {
  isDeletePending,
  showsDeleteSweep,
  surfaceDeleteKey,
  useDeleteEntry,
  useRunDelete,
} from '../../lib/workspace/pending-deletes.js';

/**
 * A surface with no panes. It stays until the person closes it, so a workflow
 * that closes its last agent keeps its surface, and a new workflow surface has
 * somewhere to be before its first agent starts.
 *
 * Every action is the workbench command a palette row would run, aimed at this
 * surface: the start commands fill it rather than creating another surface, and
 * the agent one opens the palette at its harness step.
 */
export function EmptySurface({
  worktreeId,
  surfaceId,
}: {
  readonly worktreeId: number;
  readonly surfaceId: number;
}) {
  const dispatchCommand = useCommandDispatcher();
  const editorAvailable = useEditorAvailable();
  const runDelete = useRunDelete();
  const deleteKey = surfaceDeleteKey(surfaceId);
  const deleteEntry = useDeleteEntry(deleteKey);
  const closing = isDeletePending(deleteEntry);
  const target = { intoSurfaceId: String(surfaceId) };

  const start = (commandId: 'start-agent-session' | 'start-terminal-session' | 'open-editor') => {
    void dispatchCommand(commandId, target).catch(handleDispatchedCommandError);
  };

  return (
    <div className="grid h-full place-items-center rounded-md border border-line/20 bg-elevated/50 px-6 backdrop-blur-sm">
      <div className="flex max-w-md flex-col items-center gap-4 text-center">
        <div className="space-y-1">
          <p className="text-[13px] text-fg-muted">{emptySurfaceCopy.body}</p>
          <MonoAside>{emptySurfaceCopy.aside}</MonoAside>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            icon={Bot}
            disabled={closing}
            onClick={() => start('start-agent-session')}
          >
            {emptySurfaceCopy.actions.startAgent}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            icon={SquareTerminal}
            disabled={closing}
            onClick={() => start('start-terminal-session')}
          >
            {emptySurfaceCopy.actions.startTerminal}
          </Button>
          {editorAvailable ? (
            <Button
              variant="secondary"
              size="sm"
              icon={Code}
              disabled={closing}
              onClick={() => start('open-editor')}
            >
              {emptySurfaceCopy.actions.openEditor}
            </Button>
          ) : null}
        </div>
        <span className="relative inline-flex overflow-hidden rounded-md">
          <Button
            variant="ghost"
            size="sm"
            icon={X}
            disabled={closing}
            onClick={() =>
              runDelete({
                key: deleteKey,
                origin: 'pane',
                commandId: 'delete-active-surface',
                values: { worktreeId: String(worktreeId), surfaceId: String(surfaceId) },
              })
            }
          >
            {emptySurfaceCopy.actions.close}
          </Button>
          {showsDeleteSweep(deleteEntry, 'pane') && (
            <span aria-hidden className="command-sweep command-sweep-danger command-sweep-pinned" />
          )}
        </span>
      </div>
    </div>
  );
}
