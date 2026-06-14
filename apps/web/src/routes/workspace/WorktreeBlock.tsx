import { Pencil, Trash2 } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';

import { AttentionDot } from '../../components/AttentionDot.js';
import { ContextMenu } from '../../components/ContextMenu.js';
import { surfaceActionsCopy } from '../../copy/index.js';
import { EASE_EXPO, surfaceTransition, uiTransition } from '../../lib/motion.js';
import {
  handleDispatchedCommandError,
  useCommandDispatcher,
} from '../../lib/palette/dispatcher.js';
import { worktreeSubtitle } from '../../lib/workspace/selectors.js';
import { surfaceIcon } from '../../lib/workspace/surface-presentation.js';
import type { Worktree, Surface } from '../../lib/workspace/types.js';

/**
 * One worktree in the rail. When active it expands to show its surfaces as
 * indented rows. Hierarchy = accent spine + neutral lift: a single blue spine
 * (the indent guide) marks the active worktree's path; the active surface gets a
 * neutral light lift. The active worktree itself carries no pill — expansion and
 * a brighter title are signal enough.
 */
export function WorktreeBlock({
  worktree,
  active,
  activeSurfaceId,
  onSelectWorktree,
  onSelectSurface,
}: {
  worktree: Worktree;
  active: boolean;
  activeSurfaceId: number | null;
  onSelectWorktree: (worktreeId: number) => void;
  onSelectSurface: (worktreeId: number, surfaceId: number) => void;
}) {
  return (
    <div className={worktree.parked ? 'opacity-55 hover:opacity-80' : ''}>
      <button
        type="button"
        onClick={() => onSelectWorktree(worktree.id)}
        aria-current={active ? 'true' : undefined}
        className="flex w-full items-center gap-2.5 rounded-sm px-2.5 py-2 text-left transition duration-micro ease-expo hover:bg-line/14"
      >
        <AttentionDot state={worktree.attention} />
        <span className="min-w-0 flex-1">
          <span
            className={`block truncate text-[13px] ${active ? 'font-semibold text-fg' : 'font-medium text-fg-muted'}`}
          >
            {worktree.title}
          </span>
          <span className="mt-0.5 block truncate font-mono text-[10.5px] text-fg-subtle">
            {worktreeSubtitle(worktree)}
          </span>
        </span>
      </button>

      <AnimatePresence initial={false}>
        {active && (
          <motion.div
            key="surfaces"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={surfaceTransition}
            className="overflow-hidden"
          >
            {worktree.surfaces.length > 0 ? (
              <div className="my-1 ml-5 flex flex-col gap-0.5 border-l-2 border-blue/50 pl-2.75">
                {worktree.surfaces.map((surface) => (
                  <SurfaceRow
                    key={surface.id}
                    worktreeId={worktree.id}
                    surface={surface}
                    active={surface.id === activeSurfaceId}
                    pillId={`surface-pill-${worktree.id}`}
                    onSelect={() => onSelectSurface(worktree.id, surface.id)}
                  />
                ))}
              </div>
            ) : (
              <p className="my-1 ml-5 border-l-2 border-blue/50 py-1 pl-3.75 font-mono text-[10.5px] text-fg-subtle opacity-60">
                {'// no surfaces yet'}
              </p>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function SurfaceRow({
  worktreeId,
  surface,
  active,
  pillId,
  onSelect,
}: {
  worktreeId: number;
  surface: Surface;
  active: boolean;
  pillId: string;
  onSelect: () => void;
}) {
  const Icon = surfaceIcon(surface.kind);
  const dispatchCommand = useCommandDispatcher();

  const dispatchSurfaceCommand = (commandId: 'rename-active-surface' | 'delete-active-surface') => {
    onSelect();
    void dispatchCommand(commandId, {
      worktreeId: String(worktreeId),
      surfaceId: String(surface.id),
      title: surface.title,
    }).catch(handleDispatchedCommandError);
  };

  return (
    <ContextMenu
      items={[
        {
          label: surfaceActionsCopy.menu.rename,
          icon: Pencil,
          onSelect: () => dispatchSurfaceCommand('rename-active-surface'),
        },
        {
          label: surfaceActionsCopy.menu.delete,
          icon: Trash2,
          danger: true,
          onSelect: () => dispatchSurfaceCommand('delete-active-surface'),
        },
      ]}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-current={active ? 'true' : undefined}
        className={`relative flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] transition-colors duration-micro ease-expo ${
          active ? 'text-fg' : 'text-fg-muted hover:bg-white/5 hover:text-fg'
        }`}
      >
        {/* the neutral lift slides between rows via shared layout */}
        {active && (
          <motion.span
            layoutId={pillId}
            transition={{ ...uiTransition, ease: EASE_EXPO }}
            className="absolute inset-0 rounded-lg bg-white/8"
          />
        )}
        <Icon size={14} className={`relative z-10 ${active ? 'text-fg' : 'text-fg-subtle'}`} />
        <span className="relative z-10 truncate">{surface.title}</span>
      </button>
    </ContextMenu>
  );
}
