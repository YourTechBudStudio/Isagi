import { X } from 'lucide-react';

import {
  clearRailOrderFailure,
  useRailOrderFailure,
} from '../../lib/workspace/rail-order-state.js';
import { scopeKey, type RailOrderScope } from '../../lib/workspace/rail-order.js';

/**
 * A refused reorder, said at the row the user dragged (ADR 0004).
 *
 * Amber rather than red: the move was declined and the order is already back the
 * way it was, so nothing was destroyed and nothing needs undoing. It does not
 * animate and it does not expire — a refusal that disappears before it is read
 * is worse than one that waits — so it leaves on dismissal, on the next reorder
 * in this list, or when the list itself stops existing.
 *
 * It renders *above* its row and outside the row's registered drag source. Below
 * an expanded project the message would sit several hundred pixels from the
 * header it belongs to, and inside the source it would change the height the
 * drag engine measures, the geometry of the collapse, and the travelling
 * preview. Above and outside is the only placement that is both adjacent and
 * inert.
 *
 * Outside its *own* row still leaves it inside the enclosing ones — a surface
 * refusal sits within the worktree source, a worktree refusal within the
 * project source — so the whole notice, not just its dismiss control, opts out
 * of drag activation. Pulling on the text of a message about one list must not
 * pick up the list above it.
 */
export function RailOrderNotice({ scope, id }: { scope: RailOrderScope; id: number }) {
  const key = scopeKey(scope);
  const failure = useRailOrderFailure(key);
  // A scope holds at most one refusal, and it belongs to the row that was
  // dragged — every other row in the list renders nothing.
  if (!failure || failure.movedId !== id) return null;

  return (
    <RailOrderFailureLine
      scopeKey={key}
      message={failure.message}
      onDismiss={() => clearRailOrderFailure(key)}
    />
  );
}

/** The line itself, with no knowledge of where the refusal came from. */
export function RailOrderFailureLine({
  scopeKey: key,
  message,
  onDismiss,
}: {
  scopeKey: string;
  message: string;
  onDismiss: () => void;
}) {
  return (
    <div
      data-rail-order-failure={key}
      data-no-drag
      role="status"
      className="mb-1 flex items-start gap-2 rounded-sm border border-amber/35 bg-amber/8 px-2 py-1"
    >
      <span className="min-w-0 flex-1 text-[11.5px] leading-snug text-amber">{message}</span>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onDismiss}
        className="mt-px grid size-4 flex-none place-items-center rounded-sm text-amber/70 transition-colors duration-micro ease-expo hover:text-amber focus-visible:text-amber focus-visible:outline-none"
      >
        <X size={12} />
      </button>
    </div>
  );
}
