import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Pointer reordering for the rail, written by hand rather than taken from a
 * drag library.
 *
 * The reason is that the settled interaction asks for almost none of what a
 * drag library sells. Nothing reparents, nothing sorts itself, there is no
 * keyboard sensor, and every reorderable list is a flat run of siblings whose
 * geometry is already on screen. What is left is: cross a threshold, find the
 * nearest boundary in one known list, and report a single anchored move. That is
 * this file.
 *
 * The two things a library would genuinely have supplied — edge auto-scroll and
 * a future keyboard path — are respectively implemented below and consciously
 * deferred (keyboard reorder is a recorded product limitation for this version,
 * not hidden debt).
 *
 * Legality is expressed geometrically instead of as a rule table. Every
 * reorderable list marks its container with `data-drag-scope="<key>"`, and a
 * hover is legal only when the dragged item's own key is found on the ancestor
 * chain under the pointer. A surface therefore cannot land in another worktree
 * and a worktree cannot land in another project, because the pointer is never
 * inside those items' scope container. Nothing has to remember to reject it.
 *
 * The engine knows nothing about workspaces. A source carries an opaque
 * `payload` that is handed back untouched on drop, so the caller keeps its typed
 * domain scope without this file acquiring workspace vocabulary — and without
 * anyone parsing the flat `key` back into a scope.
 */

/** A registered drag source. `key` addresses its sibling list; `payload` is the caller's. */
export interface DragRef<Payload> {
  /** The sibling list this source belongs to, matching a `data-drag-scope` value. */
  readonly key: string;
  readonly id: number;
  /** Opaque to the engine, returned verbatim through {@link RailDragOptions.onDrop}. */
  readonly payload: Payload;
}

/** A resolved insertion point: "put the dragged item before `beforeId`, or last". */
export interface DropTarget {
  readonly beforeId: number | null;
}

export interface DragState<Payload> {
  readonly ref: DragRef<Payload>;
  readonly pointer: { readonly x: number; readonly y: number };
  /** Where inside the source the pointer grabbed it, so the preview tracks honestly. */
  readonly grab: { readonly dx: number; readonly dy: number };
  readonly size: { readonly width: number; readonly height: number };
  /** `null` while the pointer is over ground this item may not be dropped on. */
  readonly target: DropTarget | null;
}

export interface RailDragOptions<Payload> {
  /** Pointer travel, in px, before a press becomes a drag instead of a click. */
  readonly activationDistance?: number;
  /** The scroll container the rail lives in, for edge auto-scroll. */
  readonly scrollRef: React.RefObject<HTMLElement | null>;
  /** A list already awaiting a persisted move refuses to start another. */
  readonly isBlocked?: (key: string) => boolean;
  readonly onDrop: (ref: DragRef<Payload>, beforeId: number | null) => void;
}

const AUTOSCROLL_MARGIN = 52;
const AUTOSCROLL_MAX_SPEED = 14;

interface Session<Payload> {
  /** `null` for a pinned row, which owns the press but can never be carried. */
  ref: DragRef<Payload> | null;
  element: HTMLElement;
  startX: number;
  startY: number;
  active: boolean;
  grab: { dx: number; dy: number };
  size: { width: number; height: number };
  pointer: { x: number; y: number };
  target: DropTarget | null;
}

export function useRailDrag<Payload>({
  activationDistance = 5,
  scrollRef,
  isBlocked,
  onDrop,
}: RailDragOptions<Payload>) {
  const [state, setState] = useState<DragState<Payload> | null>(null);
  const sources = useRef(new Map<string, { ref: DragRef<Payload>; element: HTMLElement }>());
  const session = useRef<Session<Payload> | null>(null);
  const frame = useRef(0);

  // Read through refs inside the window listeners so the listeners can be
  // installed once per drag rather than re-bound whenever a parent re-renders
  // mid-drag — a re-bind between pointermove events drops the gesture.
  const latest = useRef({ isBlocked, onDrop });
  latest.current = { isBlocked, onDrop };

  const resolveTarget = useCallback((key: string, dragged: number, x: number, y: number) => {
    const under = document.elementFromPoint(x, y);
    const container = under?.closest<HTMLElement>(`[data-drag-scope="${CSS.escape(key)}"]`);
    if (!container) return null;

    // The dragged item is excluded from the boundary set, so N siblings always
    // yield N legal slots and `beforeId` can never name the item being moved.
    const siblings = [...sources.current.values()]
      .filter((entry) => entry.ref.key === key && entry.ref.id !== dragged)
      .filter((entry) => entry.element.isConnected)
      .map((entry) => ({ id: entry.ref.id, rect: entry.element.getBoundingClientRect() }))
      .sort((a, b) => a.rect.top - b.rect.top);

    const bounds = container.getBoundingClientRect();
    const last = siblings.at(-1);
    const slots: { beforeId: number | null; y: number }[] = [
      ...siblings.map((sibling) => ({ beforeId: sibling.id, y: sibling.rect.top })),
      { beforeId: null, y: last ? last.rect.bottom : bounds.top },
    ];

    // Nearest boundary, not nearest item midpoint: the user is aiming at the
    // seam between two rows, so the insertion point goes where they aimed. It is
    // also what keeps a pinned root un-passable — the root is inside the scope
    // but is not a source, so no slot exists above the first draggable sibling.
    const best = slots.reduce((a, b) => (Math.abs(b.y - y) < Math.abs(a.y - y) ? b : a));
    return { beforeId: best.beforeId };
  }, []);

  const stop = useCallback(() => {
    cancelAnimationFrame(frame.current);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    session.current = null;
    setState(null);
  }, []);

  const onPointerDown = useCallback(
    (event: React.PointerEvent, ref: DragRef<Payload> | null) => {
      if (event.button !== 0) return;
      // Controls nested inside a draggable row keep their own press semantics.
      // Every source on the bubble path sees the same target, so they all
      // decline and no ancestor claims the press either.
      if ((event.target as HTMLElement).closest('[data-no-drag]')) return;
      if (session.current) return;

      // Sources nest — a surface sits inside a worktree, which sits inside a
      // project — and the innermost one runs first. It owns the press whether
      // or not it can act on it: a list that is busy persisting a move must
      // *refuse* the gesture, not hand it up to its parent, or pressing a
      // surface mid-write would pick up the whole worktree.
      event.stopPropagation();
      if (ref && latest.current.isBlocked?.(ref.key)) return;

      session.current = {
        ref,
        element: event.currentTarget as HTMLElement,
        startX: event.clientX,
        startY: event.clientY,
        active: false,
        grab: { dx: 0, dy: 0 },
        size: { width: 0, height: 0 },
        pointer: { x: event.clientX, y: event.clientY },
        target: null,
      };
    },
    // `isBlocked` is read through `latest`, so this handler is stable.
    [],
  );

  useEffect(() => {
    const publish = () => {
      const current = session.current;
      // A pinned session goes active to show the refusal cursor but is never
      // carried, so it has nothing to publish.
      if (!current?.active || !current.ref) return;
      setState({
        ref: current.ref,
        pointer: current.pointer,
        grab: current.grab,
        size: current.size,
        target: current.target,
      });
    };

    const autoscroll = () => {
      frame.current = requestAnimationFrame(autoscroll);
      const current = session.current;
      const scroller = scrollRef.current;
      if (!current?.active || !current.ref || !scroller) return;

      const bounds = scroller.getBoundingClientRect();
      const fromTop = current.pointer.y - bounds.top;
      const fromBottom = bounds.bottom - current.pointer.y;
      const speed =
        fromTop < AUTOSCROLL_MARGIN
          ? -(1 - Math.max(fromTop, 0) / AUTOSCROLL_MARGIN)
          : fromBottom < AUTOSCROLL_MARGIN
            ? 1 - Math.max(fromBottom, 0) / AUTOSCROLL_MARGIN
            : 0;
      if (speed === 0) return;

      const before = scroller.scrollTop;
      scroller.scrollTop = before + speed * AUTOSCROLL_MAX_SPEED;
      if (scroller.scrollTop === before) return;
      // The list moved under a stationary pointer, so the resolved slot is now
      // stale even though no pointer event fired.
      current.target = resolveTarget(
        current.ref.key,
        current.ref.id,
        current.pointer.x,
        current.pointer.y,
      );
      publish();
    };

    const onMove = (event: PointerEvent) => {
      const current = session.current;
      if (!current) return;

      const travelled = Math.hypot(event.clientX - current.startX, event.clientY - current.startY);

      // A pinned row absorbed the press. Once the pointer travels far enough to
      // have meant a drag, say no in the same language an illegal drop target
      // uses — the refusal cursor, nothing else. No lift, no message.
      if (!current.ref) {
        if (travelled >= activationDistance) {
          current.active = true;
          document.body.style.cursor = 'not-allowed';
        }
        return;
      }

      if (!current.active) {
        if (travelled < activationDistance) return;

        const rect = measure(current.element);
        current.active = true;
        current.grab = { dx: current.startX - rect.left, dy: current.startY - rect.top };
        document.body.style.userSelect = 'none';
        frame.current = requestAnimationFrame(autoscroll);
      }

      // Re-measured every move rather than captured at pickup: the carried
      // item's height is the size of the gap reflow has to open, and a rail
      // whose rows can change height mid-drag would otherwise open a stale one.
      const live = measure(current.element);
      current.size = { width: live.width, height: live.height };
      current.pointer = { x: event.clientX, y: event.clientY };
      current.target = resolveTarget(current.ref.key, current.ref.id, event.clientX, event.clientY);
      // The invalid signal is the standard refusal cursor and the absence of a
      // gap. No red, because hovering the wrong list is not an error.
      document.body.style.cursor = current.target ? 'grabbing' : 'not-allowed';
      publish();
    };

    const onUp = () => {
      const current = session.current;
      if (!current) return;
      const { active, ref, target } = current;
      stop();
      if (!active) return;

      // The press became a gesture, so the click it would otherwise synthesise
      // must not also select the row. True for a refused pinned row too: having
      // tried to drag the root, the user did not also ask to select it.
      window.addEventListener('click', swallow, { capture: true, once: true });
      if (ref && target && !latest.current.isBlocked?.(ref.key)) {
        latest.current.onDrop(ref, target.beforeId);
      }
    };

    /**
     * The browser took the gesture away — a lost pointer, a system gesture, a
     * touch turned into a scroll. That is not a release, so it commits nothing:
     * only the visual and global state is restored.
     *
     * It also installs no click suppressor. A cancelled pointer sequence
     * produces no click of its own, so a one-shot swallower armed here would sit
     * waiting and eat whatever the user pressed next instead.
     */
    const onCancel = () => {
      if (session.current) stop();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !session.current) return;
      const wasActive = session.current.active;
      stop();
      if (wasActive) window.addEventListener('click', swallow, { capture: true, once: true });
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKeyDown);
      // Going away mid-drag is another way to lose the gesture, and the cursor
      // and text-selection locks are on `document.body` rather than on anything
      // this hook is about to unmount.
      stop();
    };
  }, [activationDistance, resolveTarget, scrollRef, stop]);

  const sourceProps = useCallback(
    (ref: DragRef<Payload>) => {
      const registryKey = `${ref.key}#${ref.id}`;
      return {
        'data-drag-source': registryKey,
        ref: (element: HTMLElement | null) => {
          if (element) sources.current.set(registryKey, { ref, element });
          else sources.current.delete(registryKey);
        },
        onPointerDown: (event: React.PointerEvent) => onPointerDown(event, ref),
      };
    },
    [onPointerDown],
  );

  /**
   * For a row that is deliberately immovable, like a project's root worktree.
   * It registers no source, so it contributes no insertion boundary and nothing
   * can be dropped above it — but it still *claims* the press, so the gesture
   * does not fall through and lift the group it happens to sit inside.
   */
  const pinnedProps = useCallback(
    () => ({
      'data-drag-pinned': '',
      onPointerDown: (event: React.PointerEvent) => onPointerDown(event, null),
    }),
    [onPointerDown],
  );

  return { state, sourceProps, pinnedProps };
}

/**
 * Measure the space a source occupies.
 *
 * This is the registered element's own box, and it has to stay that way: the
 * number is the size of the gap the list opens for the carried row, so it must
 * be the space that row actually takes up — including any padding used for
 * separation. A carried row is only made invisible, never collapsed, so this
 * keeps reporting the truth for the whole gesture.
 *
 * Rows must therefore express their spacing as padding rather than margin. A
 * margin is not in any rect, so it would silently make every gap too small by
 * the size of the separation.
 */
function measure(element: HTMLElement) {
  return element.getBoundingClientRect();
}

function swallow(event: MouseEvent) {
  event.preventDefault();
  event.stopPropagation();
}
