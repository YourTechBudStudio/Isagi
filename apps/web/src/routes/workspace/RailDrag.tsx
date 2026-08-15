import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';

import type { WorkspaceData } from '../../lib/workspace/model.js';
import { useWorkspaceQuery } from '../../lib/workspace/queries.js';
import { useRailDrag, type DragState } from '../../lib/workspace/rail-drag.js';
import { commitRailMove } from '../../lib/workspace/rail-order-commit.js';
import {
  clearRailOrderFailure,
  isRailOrderPending,
  useRailOrderStore,
} from '../../lib/workspace/rail-order-state.js';
import {
  moveBefore,
  railSiblingIds,
  scopeKey,
  type RailOrderScope,
} from '../../lib/workspace/rail-order.js';
import { RailDragContext, type RailDragPayload, type RailDragValue } from './rail-drag-context.js';

/**
 * The rail's drag layer: one engine, one travelling preview, and the small
 * amount of state the rows need to get out of the way.
 *
 * It sits between the geometry engine (`lib/workspace/rail-drag.ts`, which knows
 * nothing about workspaces) and the commit workflow (`rail-order-commit.ts`,
 * which knows nothing about pointers). Its whole job is to carry a typed
 * {@link RailOrderScope} across that gap without anyone parsing a scope key back
 * into a scope, and to turn a released pointer into one bounded move.
 *
 * Three DOM nodes per row divide the work, and they must stay divided:
 *
 * - the **registered** node carries `sourceProps` and is what the engine
 *   measures for insertion boundaries, so nothing may transform it;
 * - the **layout** node is Motion's, and its layout animation is suppressed for
 *   the duration of any drag so it never competes for the same movement;
 * - the **reflow** node carries the drag's own `translateY`.
 *
 * Reading a transformed box back into the boundary search is a feedback loop —
 * pick a slot, move, re-measure, pick a different one — which is why the
 * transform lives strictly below the measured element.
 */

/**
 * How the list rearranges itself around a row that is in flight.
 *
 * The carried row **keeps its space** and is only made invisible, and its
 * siblings step across it: rows that end up below it move down by its height,
 * rows that end up above it move up by the same amount. The visible gap is
 * therefore always at the insertion point, and — the part that matters — the
 * list's total height never changes.
 *
 * The obvious alternative, collapsing the source to zero height and pushing
 * everything at or after the slot down, is wrong in a way that is invisible
 * until you drag the *last* row to the top. Collapsing shortens the list by one
 * row's height, so shifting siblings down by that same height pushes the bottom
 * of the list past the bottom of its container — and every container here clips:
 * each worktree and surface row has `overflow-hidden` for its removal animation,
 * and the rail scrolls, which a transform does not extend. The siblings do not
 * move, they disappear.
 */
interface RailReflowPlan {
  readonly key: string;
  readonly scope: RailOrderScope;
  readonly movedId: number;
  /** Siblings in their pre-move order, without the carried row. */
  readonly rest: readonly number[];
  /** The carried row's index in the full sibling list. */
  readonly fromIndex: number;
  /** Insertion index within {@link rest}. */
  readonly slot: number;
  readonly height: number;
  /** The order this plan is asking for, so we can tell when it has landed. */
  readonly expected: readonly number[];
}

export function RailDragProvider({ children }: { children: ReactNode }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const workspace = useWorkspaceQuery();
  const data = workspace.data;

  /**
   * The plan of a drop whose new order has not reached the cache yet.
   *
   * Without this the rail plays the move twice. `stop()` clears the drag
   * synchronously on pointer-up, but the optimistic projection lands a tick
   * later, so there is a frame where the transforms are gone and the order is
   * still the old one: the list snaps back, and then Motion — whose `layout` has
   * just been re-enabled — animates the reorder all over again. Holding the
   * drag's final visual until the cache agrees with it means the two swap in a
   * single commit, and nothing moves at all.
   */
  const [settling, setSettling] = useState<RailReflowPlan | null>(null);
  const planRef = useRef<RailReflowPlan | null>(null);

  const {
    state: drag,
    sourceProps: registerSource,
    pinnedProps,
  } = useRailDrag<RailDragPayload>({
    scrollRef,
    isBlocked: (key) => isRailOrderPending(key),
    // `commitRailMove` resolves for every outcome, including refusal, and puts
    // its own feedback where the user is looking — so there is nothing to await
    // and nothing to catch at the drop site. The `finally` is not error
    // handling; it is the backstop that releases the settling hold when the
    // move was skipped, blocked, or rolled back and the expected order will
    // therefore never arrive.
    onDrop: (ref, beforeId) => {
      const plan = buildPlan(
        data,
        ref.payload.scope,
        ref.id,
        beforeId,
        planRef.current?.height ?? 0,
      );
      if (plan) setSettling(plan);
      void commitRailMove({
        intent: { scope: ref.payload.scope, movedId: ref.id, beforeId },
      }).finally(() => {
        setSettling((current) => (current === plan ? null : current));
      });
    },
  });

  const dragPlan = useMemo(
    () =>
      drag?.target
        ? buildPlan(
            data,
            drag.ref.payload.scope,
            drag.ref.id,
            drag.target.beforeId,
            drag.size.height,
          )
        : null,
    [drag, data],
  );
  planRef.current = dragPlan;

  // Derived during render, not in an effect, so the commit that installs the new
  // order is the same commit that drops the transforms.
  const settled = settling !== null && matchesExpected(data, settling);
  const plan = dragPlan ?? (settled ? null : settling);

  /**
   * Motion's layout hold, which deliberately outlives the transforms by one
   * render. The commit that lands the new order is the commit that drops the
   * transforms, and if `layout` came back in that *same* commit Motion would see
   * a reordered list against no baseline and animate the whole move again — the
   * second animation this hold exists to prevent. The effect below releases it
   * on the following render, by which time nothing has moved.
   */
  const holdingLayout = drag !== null || settling !== null;

  useEffect(() => {
    if (settled) setSettling(null);
  }, [settled]);

  const sourceProps = useCallback(
    (scope: RailOrderScope, id: number, preview: () => ReactNode) =>
      registerSource({ key: scopeKey(scope), id, payload: { scope, preview } }),
    [registerSource],
  );

  const draggedClass = useCallback(
    (scope: RailOrderScope, id: number) =>
      // `invisible`, not `hidden` or a zero height: the row has to keep its box
      // so the list's height stays constant and so the engine can still measure
      // how tall the thing in flight is.
      plan && plan.movedId === id && plan.key === scopeKey(scope) ? 'invisible' : '',
    [plan],
  );

  const reflowStyle = useCallback(
    (scope: RailOrderScope, id: number): CSSProperties | undefined => {
      if (!plan || plan.key !== scopeKey(scope) || id === plan.movedId) return undefined;
      const shift = siblingShift(plan, id);
      if (shift === null) return undefined;
      // Every sibling in the moving list keeps the transition, including the
      // ones currently at rest — otherwise a row the slot moves back past would
      // snap home instead of closing the gap it opened.
      return {
        transform: shift === 0 ? undefined : `translateY(${shift}px)`,
        transition: 'transform var(--duration-ui) var(--ease-expo)',
      };
    },
    [plan],
  );

  useRailOrderFailureCleanup(data);

  const value: RailDragValue = {
    dragging: holdingLayout,
    scrollRef,
    sourceProps,
    pinnedProps,
    draggedClass,
    reflowStyle,
  };

  return (
    <RailDragContext.Provider value={value}>
      {children}
      {drag && <RailDragPreview drag={drag} />}
    </RailDragContext.Provider>
  );
}

function buildPlan(
  data: WorkspaceData | undefined,
  scope: RailOrderScope,
  movedId: number,
  beforeId: number | null,
  height: number,
): RailReflowPlan | null {
  if (!data) return null;
  const ids = railSiblingIds(data, scope);
  if (!ids) return null;
  const fromIndex = ids.indexOf(movedId);
  if (fromIndex < 0) return null;
  const rest = ids.filter((id) => id !== movedId);
  const slot = beforeId === null ? rest.length : rest.indexOf(beforeId);
  if (slot < 0) return null;
  return {
    key: scopeKey(scope),
    scope,
    movedId,
    rest,
    fromIndex,
    slot,
    height,
    expected: moveBefore(ids, movedId, beforeId),
  };
}

/**
 * How far a sibling steps, or `null` if it is not in this list at all.
 *
 * A sibling's index in `rest` says which side of the carried row it started on:
 * below `fromIndex` it was above the row, at or beyond it, below. Crossing the
 * row in either direction costs exactly one row height, and everything else
 * holds still.
 */
function siblingShift(plan: RailReflowPlan, id: number): number | null {
  const position = plan.rest.indexOf(id);
  if (position < 0) return null;
  if (position < plan.fromIndex && position >= plan.slot) return plan.height;
  if (position >= plan.fromIndex && position < plan.slot) return -plan.height;
  return 0;
}

function matchesExpected(data: WorkspaceData | undefined, plan: RailReflowPlan): boolean {
  if (!data) return false;
  const ids = railSiblingIds(data, plan.scope);
  return (
    ids !== null &&
    ids.length === plan.expected.length &&
    ids.every((id, index) => id === plan.expected[index])
  );
}

/**
 * The travelling preview: a single flat row that follows the pointer.
 *
 * Deliberately not the row itself. The row keeps its own semantics in the list,
 * and this is a quieter, non-interactive copy — no buttons, no menus, no shared
 * layout identity — so nothing actionable is ever duplicated on screen. Ground
 * the item may not be dropped on dims it rather than reddening it: hovering the
 * wrong list is a refusal, not an error.
 */
function RailDragPreview({ drag }: { drag: DragState<RailDragPayload> }) {
  return (
    <div
      data-rail-drag-overlay
      data-overlay-ref={`${drag.ref.key}#${drag.ref.id}`}
      data-overlay-valid={drag.target ? 'true' : 'false'}
      aria-hidden
      className="pointer-events-none fixed z-60 overflow-hidden rounded-sm border border-line/25 bg-elevated/85 shadow-soft backdrop-blur-md"
      style={{
        left: drag.pointer.x - drag.grab.dx,
        // A tall group grabbed near its foot would otherwise hang far above the
        // pointer; clamping the vertical grab keeps the preview under the hand.
        top: drag.pointer.y - Math.min(drag.grab.dy, 40),
        width: drag.size.width || undefined,
        opacity: drag.target ? 1 : 0.55,
      }}
    >
      {drag.ref.payload.preview()}
    </div>
  );
}

/**
 * Drop a refusal whose list — or whose row — has since gone away.
 *
 * Phase 04 keeps inline failures until they are dismissed or superseded, on the
 * grounds that a message which expires before it is read is worse than one that
 * waits. That leaves exactly one case it cannot see: the owning scope ceasing to
 * exist. Nothing would ever render such an entry, and it would keep answering
 * `useRailOrderFailure` for a key nobody asks about again.
 *
 * The live scopes are enumerated from the snapshot and compared by key, so no
 * scope key is ever parsed back into a scope.
 */
function useRailOrderFailureCleanup(data: WorkspaceData | undefined) {
  useEffect(() => {
    if (!data) return;

    const live = new Map<string, ReadonlySet<number>>();
    const record = (scope: RailOrderScope) => {
      const ids = railSiblingIds(data, scope);
      if (ids) live.set(scopeKey(scope), new Set(ids));
    };
    record({ kind: 'projects' });
    for (const project of data.projects) {
      record({ kind: 'worktrees', projectId: project.id });
      for (const worktree of project.worktrees) {
        record({ kind: 'surfaces', worktreeId: worktree.id });
      }
    }

    for (const [key, entry] of Object.entries(useRailOrderStore.getState().entriesByScope)) {
      if (entry.status !== 'failed') continue;
      if (!live.get(key)?.has(entry.movedId)) clearRailOrderFailure(key);
    }
  }, [data]);
}
