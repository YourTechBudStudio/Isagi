import type { ProjectKind } from '@isagi/contracts';

import type { Worktree } from '../../../src/lib/workspace/types.js';
import { useVariants } from './variants.js';

/**
 * A prototype of the status strip's right-hand branch tag.
 *
 * **Declared prototype debt, repaid in phase 07.** The production `StatusStrip`
 * reads its commands through a query this page does not serve, so mounting it
 * whole would put a `commands unavailable` error next to the one thing being
 * judged. What is reproduced is the strip's chrome and the tag's exact
 * treatment — same height, same border, same mono size, same green — because the
 * question is only ever whether that green tag appears.
 *
 * For a folder environment there is no ref to name, so the tag does not render
 * and the strip's right side is simply empty. A genuinely detached Git worktree
 * still reads `detached`, which is the distinction the whole change turns on.
 */
export function StatusStripPreview({
  worktree,
  projectKind,
}: {
  readonly worktree: Worktree | null;
  readonly projectKind: ProjectKind | null;
}) {
  const showCurrent = useVariants((state) => state.showCurrent);
  const effectiveKind = showCurrent ? 'git' : projectKind;
  const label = worktree && effectiveKind ? branchLabel(worktree, effectiveKind) : null;

  return (
    <div className="flex h-7.5 flex-none items-center gap-3 border-t border-line/15 bg-elevated/50 px-3.5 text-left">
      <span className="flex-none font-mono text-[10px] tracking-widest text-fg-subtle uppercase">
        commands
      </span>
      <span className="font-mono text-[11px] text-fg-subtle opacity-55">
        Nothing running here yet.
      </span>
      {label && (
        <span data-branch-tag className="ml-auto flex-none font-mono text-[11.5px] text-green">
          {label}
        </span>
      )}
    </div>
  );
}

/** `null` when there is no Git ref to name — a folder has no branch and no head. */
function branchLabel(worktree: Worktree, projectKind: ProjectKind): string | null {
  if (projectKind === 'folder') return null;
  return worktree.branch ?? shortHead(worktree.head) ?? 'detached';
}

function shortHead(head: string | null | undefined) {
  return head ? head.slice(0, 7) : null;
}
