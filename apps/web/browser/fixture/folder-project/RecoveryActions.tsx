import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState } from 'react';

import { Button } from '../../../src/components/Button.js';
import { missingProjectCopy } from '../../../src/copy/index.js';
import { uiTransition } from '../../../src/lib/motion.js';
import { formatRuntimeError } from '../../../src/lib/workspace/queries.js';
import type { MissingProject } from '../../../src/lib/workspace/types.js';
import { useRecheckPrototype } from './useRecheckPrototype.js';

type ConfirmState = 'idle' | 'confirming';

/** Cross-fade used when the action row swaps for the confirm panel and back. */
const swap = {
  initial: { opacity: 0, y: 4 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -4 },
  transition: uiTransition,
};

/**
 * A prototype of the missing-project recovery actions, carrying the recheck
 * design question.
 *
 * **This is declared prototype debt, repaid in phase 08.** The production
 * `MissingProjectActions` still offers `Set new path…` to every missing project,
 * including folder ones the runtime refuses to relocate. Everything here that is
 * *not* the recheck — the removal confirmation, its Cancel, its Escape, its
 * danger treatment, its focus placement — is copied from that component
 * unchanged, because a mock that quietly dropped them would be evidence that
 * they were lost rather than that they survive.
 *
 * The recheck's three outcomes are distinct by construction, not inferred: the
 * mutation either produced a verdict or it did not, and a verdict is either
 * `restored` or `still_unavailable`. A failed check reports that it failed, and
 * never that the folder is absent — the read that would have established that
 * is exactly the thing that did not happen.
 *
 * The verdict lands inline, under the action row: settled by review over an
 * inset panel and over folding the answer into the button's own label. The panel
 * asked for a dismissal the surface did not otherwise need, and the button could
 * carry "still not there" but had nowhere to put the runtime error a failed
 * check produces — so it needed a line underneath anyway, which is two layouts
 * for one control.
 *
 * A *restore* says nothing at all. That is also settled: the refreshed snapshot
 * makes the project present, the canvas swaps to its environment, and the swap
 * is the entire feedback. It keeps every outcome of this action at the surface
 * that started it (ADR 0004) rather than sending one of the three somewhere
 * else, and it means there is no success path that can outlive the thing it is
 * reporting on.
 */
export function RecoveryActions({ project }: { project: MissingProject }) {
  const [state, setState] = useState<ConfirmState>('idle');
  const [removing, setRemoving] = useState(false);
  const recheck = useRecheckPrototype();
  const folder = project.kind === 'folder';

  // Esc backs out of the armed confirmation, and only out of that. Copied from
  // the production component; the recheck adds no Escape handling of its own,
  // because it arms nothing that a press could back out of.
  useEffect(() => {
    if (state !== 'confirming') return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!removing) setState('idle');
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [state, removing]);

  const startRecheck = () => {
    // Cleared *before* the attempt, not after it resolves: a previous verdict
    // must never sit under a check that is currently running and might disagree
    // with it.
    recheck.reset();
    recheck.mutate(project.id);
  };

  return (
    <div className="flex flex-col items-center gap-3">
      <AnimatePresence initial={false} mode="wait">
        {state === 'idle' ? (
          <motion.div key="idle" className="flex gap-2.5" {...swap}>
            {folder ? (
              <Button data-recheck disabled={recheck.isPending} onClick={startRecheck}>
                {recheck.isPending
                  ? missingProjectCopy.recheck.pending
                  : missingProjectCopy.recheck.action}
              </Button>
            ) : (
              // A Git project keeps relocation. Side by side with the folder
              // case this is the clearest statement of what the kind decides:
              // one project can be pointed somewhere else, the other can only
              // be looked for again where it was.
              <Button data-relocate>Set new path…</Button>
            )}
            <Button
              variant="secondary"
              className="hover:border-error/35 hover:text-fg"
              data-remove-project
              onClick={() => setState('confirming')}
            >
              Remove project
            </Button>
          </motion.div>
        ) : (
          <motion.div key="confirm" className="w-96 max-w-full" {...swap}>
            <ConfirmPanel
              pending={removing}
              onCancel={() => setState('idle')}
              onConfirm={() => setRemoving(true)}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {state === 'idle' && folder && (
        <Verdict
          pending={recheck.isPending}
          stillMissing={recheck.data?.status === 'still_unavailable'}
          error={recheck.isError ? formatRuntimeError(recheck.error) : null}
        />
      )}
    </div>
  );
}

/**
 * The verdict line.
 *
 * There is no `restored` case here on purpose. A restored folder produces a
 * refreshed snapshot in which the project is present, the canvas swaps to its
 * environment, and this whole surface unmounts — so a "restored" branch would be
 * unreachable code quietly promising a state the app can never paint. Anything
 * that acknowledged a restore would have to outlive the surface that asked for
 * it; the swap is the acknowledgement instead.
 */
function Verdict({
  pending,
  stillMissing,
  error,
}: {
  readonly pending: boolean;
  readonly stillMissing: boolean;
  readonly error: string | null;
}) {
  if (pending || (!error && !stillMissing)) return null;

  return (
    <motion.p
      {...swap}
      role="status"
      data-verdict={error ? 'failed' : 'still-missing'}
      className={`max-w-[46ch] text-[12.5px] leading-snug ${error ? 'text-error' : 'text-fg-muted'}`}
    >
      {error ? (
        <>
          {missingProjectCopy.recheck.failed} <span className="text-fg-subtle">{error}</span>
        </>
      ) : (
        missingProjectCopy.recheck.stillMissing
      )}
    </motion.p>
  );
}

/** The removal confirmation, unchanged from production apart from its stubbed commit. */
function ConfirmPanel({
  pending,
  onCancel,
  onConfirm,
}: {
  readonly pending: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  return (
    <div
      data-confirm-panel
      className="w-full rounded-md border border-error/20 bg-error/8 p-4 text-left shadow-soft"
    >
      <div className="text-[13px] font-semibold text-fg">{missingProjectCopy.confirm.title}</div>
      <p className="mt-1 text-[12.5px] leading-snug text-fg-muted">
        {missingProjectCopy.confirm.body}
      </p>
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
