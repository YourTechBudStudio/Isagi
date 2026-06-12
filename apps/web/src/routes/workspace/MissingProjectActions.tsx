import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState } from 'react';

import { Button } from '../../components/Button.js';
import { missingProjectCopy } from '../../copy/index.js';
import { uiTransition } from '../../lib/motion.js';
import { usePaletteStore } from '../../lib/palette/store.js';
import { formatRuntimeError, useDeleteProjectMutation } from '../../lib/workspace/queries.js';
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
 */
export function MissingProjectActions({ project }: { project: MissingProject }) {
  const openPalette = usePaletteStore((state) => state.openPalette);
  const paletteOpen = usePaletteStore((state) => state.open);
  const deleteProject = useDeleteProjectMutation();
  const [state, setState] = useState<ConfirmState>('idle');

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

  return (
    <AnimatePresence initial={false} mode="wait">
      {state === 'idle' ? (
        <motion.div key="idle" className="flex gap-2.5" {...swap}>
          <Button
            onClick={() => openPalette('relocate-project', { projectId: String(project.id) })}
          >
            Set new path…
          </Button>
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
