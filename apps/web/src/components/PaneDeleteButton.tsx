import { Trash2 } from 'lucide-react';

import { Tooltip } from './Tooltip.js';

/**
 * The quiet pane-delete affordance: a floating trash button that stays out of
 * the way until the pane is hovered or holds focus, then fades in on the
 * expo-out curve. Render inside a `group relative` pane shell. Keyboard users
 * reach it via focus (`focus-visible`), so it never hides from the keyboard.
 *
 * Anchored bottom-right on purpose: the worktree action bar floats over the
 * canvas's top-right corner, so a top-right trash would sit under it on the
 * rightmost pane. Bottom-right clears both the action bar and the status strip.
 *
 * It is a thin trigger only — the owner wires `onDelete` to focus the pane and
 * dispatch the delete-active-pane command; this button holds no delete logic.
 */
export function PaneDeleteButton({
  onDelete,
  className = '',
}: {
  onDelete: () => void;
  className?: string;
}) {
  return (
    <Tooltip label="Delete pane" side="left">
      <button
        type="button"
        aria-label="Delete pane"
        onClick={onDelete}
        className={`absolute right-2 bottom-2 z-10 grid size-6 place-items-center rounded-sm border border-line/20 bg-elevated/70 text-fg-subtle opacity-0 backdrop-blur-sm transition duration-micro ease-expo group-focus-within:opacity-100 group-hover:opacity-100 hover:border-error/40 hover:bg-error/12 hover:text-error focus-visible:opacity-100 ${className}`}
      >
        <Trash2 size={13} />
      </button>
    </Tooltip>
  );
}
