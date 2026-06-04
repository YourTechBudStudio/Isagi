import { Bot, Code, ScanSearch, SquareChevronRight, SquareTerminal } from 'lucide-react';

import type { IconType } from '../icon.js';
import { useWorkspaceStore } from './store.js';

/**
 * Internal "this worktree" verbs — first-class Isagi features (not config-driven
 * like the global command registry). One source of truth, consumed by both the
 * floating action bar and the command palette's "This worktree — Actions" group.
 *
 * `run` reads the store singleton directly, so these descriptors stay plain data.
 */
export interface WorktreeAction {
  readonly id: string;
  readonly label: string;
  readonly icon: IconType;
  readonly accent?: boolean;
  readonly run: (worktreeId: string) => void;
}

export const WORKTREE_ACTIONS: readonly WorktreeAction[] = [
  {
    id: 'new-agent',
    label: 'New agent',
    icon: Bot,
    run: (worktreeId) => useWorkspaceStore.getState().addAgentSession(worktreeId),
  },
  {
    id: 'new-terminal',
    label: 'New terminal',
    icon: SquareTerminal,
    run: (worktreeId) => useWorkspaceStore.getState().addTerminalSurface(worktreeId),
  },
  {
    id: 'open-code',
    label: 'Open code-server',
    icon: Code,
    run: (worktreeId) => useWorkspaceStore.getState().openCodeServer(worktreeId),
  },
  {
    id: 'ai-review',
    label: 'AI review',
    icon: ScanSearch,
    accent: true,
    run: (worktreeId) => useWorkspaceStore.getState().aiReview(worktreeId),
  },
  {
    id: 'open-commands',
    label: 'Open commands',
    icon: SquareChevronRight,
    run: () => useWorkspaceStore.getState().openDrawer(),
  },
];
