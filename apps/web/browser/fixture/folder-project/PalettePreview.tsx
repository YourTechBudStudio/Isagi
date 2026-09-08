import { FolderSymlink, GitBranch } from 'lucide-react';
import { motion } from 'motion/react';

import { uiTransition } from '../../../src/lib/motion.js';
import type { Project } from '../../../src/lib/workspace/types.js';
import { useVariants } from './variants.js';

/**
 * A prototype of the two palette commands the project kind changes.
 *
 * **Declared prototype debt, repaid in phase 07.** The production commands still
 * offer every project, so mounting the real palette would show today's
 * behaviour, not the target. This renders the same two commands against the same
 * scenario data with the proposed filters applied, in the palette's own row
 * language, so the omission can be read rather than described.
 *
 * The filters are the whole content:
 *
 * - **Open worktree** offers Git projects only, and goes unavailable when none
 *   remain. A folder project has one environment and the runtime refuses to make
 *   a second, so listing it would be an invitation to a refusal.
 * - **Set project path** offers missing *Git* projects only. A folder project
 *   cannot be relocated at all — the runtime refuses before it even checks
 *   whether the project is missing.
 *
 * The web filters for honesty, not for enforcement: a forced or stale client
 * call is still refused by the runtime.
 */
export function PalettePreview({
  projects,
  onClose,
}: {
  readonly projects: readonly Project[];
  readonly onClose: () => void;
}) {
  const showCurrent = useVariants((state) => state.showCurrent);

  const openWorktreeTargets = projects.filter(
    (project) => project.status === 'present' && (showCurrent || project.kind === 'git'),
  );
  const relocateTargets = projects.filter(
    (project) => project.status === 'missing' && (showCurrent || project.kind === 'git'),
  );

  return (
    <div
      className="absolute inset-0 z-30 grid place-items-start justify-center bg-black/45 pt-[12vh] backdrop-blur-sm"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, y: 6, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={uiTransition}
        onClick={(event) => event.stopPropagation()}
        className="w-136 max-w-[90vw] overflow-hidden rounded-xl border border-line/25 bg-elevated/95 shadow-soft"
      >
        <CommandSection
          icon={GitBranch}
          label="Open worktree"
          emptyHint="Unavailable — no Git project to open a worktree in."
          projects={openWorktreeTargets}
          testId="open-worktree"
        />
        <CommandSection
          icon={FolderSymlink}
          label="Set project path"
          emptyHint="Unavailable — no missing Git project to point somewhere else."
          projects={relocateTargets}
          testId="relocate-project"
        />
        <p className="border-t border-line/15 px-4 py-2.5 font-mono text-[10.5px] text-fg-subtle opacity-45">
          {'// esc closes · the runtime refuses either way'}
        </p>
      </motion.div>
    </div>
  );
}

function CommandSection({
  icon: Icon,
  label,
  emptyHint,
  projects,
  testId,
}: {
  readonly icon: typeof GitBranch;
  readonly label: string;
  readonly emptyHint: string;
  readonly projects: readonly Project[];
  readonly testId: string;
}) {
  return (
    <div className="border-b border-line/15 last:border-b-0">
      <div className="flex items-center gap-2.5 px-4 pt-3.5 pb-1.5">
        <Icon size={14} className="text-fg-subtle" />
        <span className="text-[12.5px] font-medium text-fg">{label}</span>
        {projects.length === 0 && (
          <span
            data-command-unavailable={testId}
            className="ml-auto font-mono text-[10px] tracking-widest text-fg-subtle uppercase"
          >
            unavailable
          </span>
        )}
      </div>
      {projects.length === 0 ? (
        <p className="px-4 pt-0.5 pb-3.5 text-[12px] text-fg-muted">{emptyHint}</p>
      ) : (
        <div className="pb-2">
          {projects.map((project) => (
            <div
              key={project.id}
              data-command-option={`${testId}:${project.id}`}
              className="flex items-baseline gap-2.5 px-4 py-1.5 text-left"
            >
              <span className="text-[12.5px] text-fg-muted">{project.name}</span>
              <span className="truncate font-mono text-[10.5px] text-fg-subtle">
                {project.rootPath}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
