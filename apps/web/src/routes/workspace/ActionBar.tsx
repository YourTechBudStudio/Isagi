import { Maximize2 } from 'lucide-react';
import { Fragment } from 'react';

import { Tooltip } from '../../components/Tooltip.js';
import { useActiveWorktree, useWorkspaceStore } from '../../lib/workspace/store.js';
import { WORKTREE_ACTIONS, type WorktreeAction } from '../../lib/workspace/worktree-actions.js';

/**
 * The action bar — a small floating cluster of the highest-frequency internal
 * verbs (the mouse path; the command palette is the universal/keyboard path).
 * It renders the shared `WORKTREE_ACTIONS` (the same source the palette's "This
 * worktree" group uses), so the palette stays the source of truth. Floats
 * top-right over the canvas so it costs no layout and leaves the status strip
 * free for status.
 */

/** Insert a visual divider before these action ids. */
const DIVIDER_BEFORE = new Set(['ai-review', 'open-commands']);

export function ActionBar() {
  const worktree = useActiveWorktree();
  const setZen = useWorkspaceStore((state) => state.setZen);

  if (!worktree) {
    return null;
  }

  const worktreeId = worktree.id;

  return (
    <div className="absolute top-3 right-3 z-10 flex items-center gap-0.5 rounded-xl border border-line/24 bg-elevated/65 p-1 shadow-soft backdrop-blur-md">
      {WORKTREE_ACTIONS.map((action) => (
        <Fragment key={action.id}>
          {DIVIDER_BEFORE.has(action.id) && <span className="mx-0.5 h-4 w-px bg-line/25" />}
          <ActionButton action={action} onRun={() => action.run(worktreeId)} />
        </Fragment>
      ))}
      <span className="mx-0.5 h-4 w-px bg-line/25" />
      <Tooltip label="Focus mode">
        <button
          type="button"
          onClick={() => setZen(true)}
          aria-label="Focus mode"
          className="grid size-8 place-items-center rounded-lg text-fg-muted transition-colors duration-micro ease-expo hover:bg-white/8 hover:text-fg"
        >
          <Maximize2 size={15} />
        </button>
      </Tooltip>
    </div>
  );
}

function ActionButton({ action, onRun }: { action: WorktreeAction; onRun: () => void }) {
  const Icon = action.icon;

  return (
    <Tooltip label={action.label}>
      <button
        type="button"
        onClick={onRun}
        aria-label={action.label}
        className={`grid size-8 place-items-center rounded-lg transition-colors duration-micro ease-expo hover:bg-white/8 ${
          action.accent ? 'text-violet hover:text-violet' : 'text-fg-muted hover:text-fg'
        }`}
      >
        <Icon size={16} />
      </button>
    </Tooltip>
  );
}
