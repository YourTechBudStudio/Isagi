import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState } from 'react';

import { Button } from '../../components/Button.js';
import { missingProjectCopy } from '../../copy/index.js';
import { uiTransition } from '../../lib/motion.js';
import { usePaletteStore } from '../../lib/palette/store.js';
import {
  formatRuntimeError,
  useDeleteProjectMutation,
  useRecheckProjectMutation,
} from '../../lib/workspace/queries.js';
import type { MissingProject } from '../../lib/workspace/types.js';

type ConfirmState = 'idle' | 'confirming';

/** Cross-fade used when the action row swaps for the confirm panel and back. */
const swap = {
  initial: { opacity: 0, y: 4 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -4 },
  transition: uiTransition,
};

/**
 * The recovery actions for a missing project. Instead of floating a popover off
 * a button, the confirmation happens in place: clicking "Remove project" swaps
 * the whole action row for an inset confirm panel within the canvas state that
 * already has the room. Cancel (or Esc) swaps back; the destructive button only
 * commits on a second, deliberate click.
 *
 * The first action depends on the project's kind, and this is the clearest place
 * in the product to see what that kind decides. A Git project can be pointed
 * somewhere else, so it keeps **Set new path…**. A folder project cannot be
 * relocated at all — the runtime refuses the request before it even checks
 * whether the project is missing — so the only honest move is to look again at
 * the same path with **Check again**.
 *
 * This component is mounted keyed on the project id (see `Canvas`), so none of
 * the interaction state below — an armed removal, a settled verdict, a failed
 * check — can follow the user from one missing project to another.
 */
export function MissingProjectActions({ project }: { project: MissingProject }) {
  const openPalette = usePaletteStore((state) => state.openPalette);
  const paletteOpen = usePaletteStore((state) => state.open);
  const deleteProject = useDeleteProjectMutation();
  const recheck = useRecheckProjectMutation();
  const [state, setState] = useState<ConfirmState>('idle');
  const isFolder = project.kind === 'folder';

  // Esc belongs to the topmost surface. The palette may be opened while this
  // confirmation is armed, so let it handle Esc first; otherwise consume Esc
  // before shell-level handlers can treat the same press as a workspace action.
  // It backs out before removal starts, but never mid-removal.
  useEffect(() => {
    if (state !== 'confirming') {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || paletteOpen) {
        return;
      }

      event.preventDefault();
      event.stopImmediatePropagation();

      if (!deleteProject.isPending) {
        deleteProject.reset();
        setState('idle');
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [state, paletteOpen, deleteProject]);

  const armConfirmation = () => {
    deleteProject.reset();
    setState('confirming');
  };

  const cancelConfirmation = () => {
    deleteProject.reset();
    setState('idle');
  };

  // Cleared *before* the attempt rather than when it resolves: a previous
  // verdict must never sit under a check that is currently running and might
  // disagree with it.
  const startRecheck = () => {
    recheck.reset();
    recheck.mutate(project.id);
  };

  return (
    <div className="flex flex-col items-center gap-3">
      <AnimatePresence initial={false} mode="wait">
        {state === 'idle' ? (
          <motion.div key="idle" className="flex gap-2.5" {...swap}>
            {isFolder ? (
              <Button disabled={recheck.isPending} onClick={startRecheck}>
                {recheck.isPending
                  ? missingProjectCopy.recheck.pending
                  : missingProjectCopy.recheck.action}
              </Button>
            ) : (
              <Button
                onClick={() => openPalette('relocate-project', { projectId: String(project.id) })}
              >
                Set new path…
              </Button>
            )}
            <Button
              variant="secondary"
              className="hover:border-error/35 hover:text-fg"
              onClick={armConfirmation}
            >
              Remove project
            </Button>
          </motion.div>
        ) : (
          <motion.div key="confirm" className="w-96 max-w-full" {...swap}>
            <ConfirmPanel
              pending={deleteProject.isPending}
              error={deleteProject.isError ? formatRuntimeError(deleteProject.error) : null}
              onCancel={cancelConfirmation}
              onConfirm={() => deleteProject.mutate(project.id)}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {state === 'idle' && isFolder && (
        <RecheckVerdict
          pending={recheck.isPending}
          stillMissing={recheck.data?.status === 'still_unavailable'}
          error={recheck.isError ? formatRuntimeError(recheck.error) : null}
        />
      )}
    </div>
  );
}

/**
 * What the last check established, under the action row that started it
 * (ADR 0004).
 *
 * There is no `restored` case here on purpose. A restored folder produces a
 * refreshed snapshot in which the project is present, the canvas swaps to its
 * environment, and this whole surface unmounts — so a "restored" branch would be
 * unreachable code promising a state the app can never paint. The swap is the
 * acknowledgement.
 *
 * A failure is never folded into the still-missing line. The read that would
 * have established an absence is exactly the thing that did not happen, so the
 * two are different roles as well as different sentences: confirmed
 * unavailability is ordinary `status` feedback, while a check that could not be
 * completed is an `alert`. The headline and the runtime diagnostic share one
 * region so assistive tech announces the failure once, not twice.
 */
function RecheckVerdict({
  pending,
  stillMissing,
  error,
}: {
  readonly pending: boolean;
  readonly stillMissing: boolean;
  readonly error: string | null;
}) {
  if (pending || (!error && !stillMissing)) {
    return null;
  }

  if (error) {
    return (
      <motion.p
        {...swap}
        role="alert"
        className="max-w-[46ch] text-[12.5px] leading-snug text-error"
      >
        {missingProjectCopy.recheck.failed} <span className="text-fg-subtle">{error}</span>
      </motion.p>
    );
  }

  return (
    <motion.p
      {...swap}
      role="status"
      className="max-w-[46ch] text-[12.5px] leading-snug text-fg-muted"
    >
      {missingProjectCopy.recheck.stillMissing}
    </motion.p>
  );
}

/**
 * The inset confirm panel. Error-tinted to tie into the missing-project halo
 * rather than read as a raw form; Cancel takes focus so Enter can't fire the
 * destructive action.
 */
function ConfirmPanel({
  pending = false,
  error = null,
  onCancel,
  onConfirm,
}: {
  pending?: boolean;
  error?: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="w-full rounded-md border border-error/20 bg-error/8 p-4 text-left shadow-soft">
      <div className="text-[13px] font-semibold text-fg">{missingProjectCopy.confirm.title}</div>
      <p className="mt-1 text-[12.5px] leading-snug text-fg-muted">
        {missingProjectCopy.confirm.body}
      </p>
      {error && (
        <p role="alert" className="mt-2 text-[12px] leading-snug text-error">
          {error}
        </p>
      )}
      <div className="mt-3 flex justify-end gap-2">
        <Button autoFocus variant="ghost" size="sm" disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="danger" size="sm" disabled={pending} onClick={onConfirm}>
          {pending ? 'Removing…' : 'Remove from Isagi'}
        </Button>
      </div>
    </div>
  );
}
