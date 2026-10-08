import { motion } from 'motion/react';

import { Button } from '../../components/Button.js';
import { missingProjectCopy, projectActionsCopy } from '../../copy/index.js';
import { uiTransition } from '../../lib/motion.js';
import { usePaletteStore } from '../../lib/palette/store.js';
import { formatRuntimeError, useRecheckProjectMutation } from '../../lib/workspace/queries.js';
import type { MissingProject } from '../../lib/workspace/types.js';

/** Cross-fade used when a recheck verdict appears under the action row. */
const swap = {
  initial: { opacity: 0, y: 4 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -4 },
  transition: uiTransition,
};

/**
 * The recovery actions for a missing project. **Delete project…** is only a
 * trigger: like **Set new path…**, it opens the palette, where the
 * `delete-project` command owns the confirm and the delete.
 *
 * The first action depends on the project's kind, and this is the clearest place
 * in the product to see what that kind decides. A Git project can be pointed
 * somewhere else, so it keeps **Set new path…**. A folder project cannot be
 * relocated at all — the runtime refuses the request before it even checks
 * whether the project is missing — so the only honest move is to look again at
 * the same path with **Check again**.
 *
 * This component is mounted keyed on the project id (see `Canvas`), so none of
 * the interaction state below — a settled verdict or a failed check — can
 * follow the user from one missing project to another.
 */
export function MissingProjectActions({ project }: { project: MissingProject }) {
  const openPalette = usePaletteStore((state) => state.openPalette);
  const recheck = useRecheckProjectMutation();
  const isFolder = project.kind === 'folder';

  // Cleared *before* the attempt rather than when it resolves: a previous
  // verdict must never sit under a check that is currently running and might
  // disagree with it.
  const startRecheck = () => {
    recheck.reset();
    recheck.mutate(project.id);
  };

  return (
    <div className="flex flex-col items-center gap-3">
      <div className="flex gap-2.5">
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
          onClick={() => openPalette('delete-project', { projectId: String(project.id) })}
        >
          {projectActionsCopy.menu.delete}
        </Button>
      </div>

      {isFolder && (
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
