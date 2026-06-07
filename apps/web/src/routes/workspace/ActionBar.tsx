import { Bot, Code, Maximize2, ScanSearch, SquareChevronRight, SquareTerminal } from 'lucide-react';
import { Fragment, useEffect, useState } from 'react';

import { Tooltip } from '../../components/Tooltip.js';
import type { IconType } from '../../lib/icon.js';
import { useActiveWorktree } from '../../lib/workspace/hooks.js';
import { useWorkspaceStore } from '../../lib/workspace/store.js';

interface MockWorktreeAction {
  readonly id: string;
  readonly label: string;
  readonly icon: IconType;
  readonly accent?: boolean;
  readonly mocked?: boolean;
  readonly run: (worktreeId: number) => void;
}

const mockWorktreeActions: readonly MockWorktreeAction[] = [
  {
    id: 'new-agent',
    label: 'New agent',
    icon: Bot,
    mocked: true,
    run: logMockAction('New agent'),
  },
  {
    id: 'new-terminal',
    label: 'New terminal',
    icon: SquareTerminal,
    mocked: true,
    run: logMockAction('New terminal'),
  },
  {
    id: 'open-code',
    label: 'Open code-server',
    icon: Code,
    mocked: true,
    run: logMockAction('Open code-server'),
  },
  {
    id: 'ai-review',
    label: 'AI review',
    icon: ScanSearch,
    accent: true,
    mocked: true,
    run: logMockAction('AI review'),
  },
  {
    id: 'open-commands',
    label: 'Open commands',
    icon: SquareChevronRight,
    run: () => useWorkspaceStore.getState().openDrawer(),
  },
];

const dividerBefore = new Set(['ai-review', 'open-commands']);

/**
 * The action bar — a mocked, self-contained cluster of high-frequency worktree
 * verbs. The backend does not run these actions yet; keeping the mock data here
 * avoids leaking placeholder actions into the runtime-backed workspace model.
 */
export function ActionBar() {
  const worktree = useActiveWorktree();
  const setZen = useWorkspaceStore((state) => state.setZen);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!notice) {
      return;
    }

    const timer = window.setTimeout(() => setNotice(null), 1800);
    return () => window.clearTimeout(timer);
  }, [notice]);

  if (!worktree) {
    return null;
  }

  return (
    <>
      <div className="absolute top-3 right-3 z-10 flex items-center gap-0.5 rounded-xl border border-line/24 bg-elevated/65 p-1 shadow-soft backdrop-blur-md">
        {mockWorktreeActions.map((action) => (
          <Fragment key={action.id}>
            {dividerBefore.has(action.id) && <span className="mx-0.5 h-4 w-px bg-line/25" />}
            <ActionButton
              action={action}
              onRun={() => {
                action.run(worktree.id);
                if (action.mocked) {
                  setNotice(`${action.label} is mocked for now.`);
                }
              }}
            />
          </Fragment>
        ))}
        <span className="mx-0.5 h-4 w-px bg-line/25" />
        <Tooltip label="Focus mode">
          <button
            type="button"
            onClick={() => setZen(true)}
            aria-label="Focus mode"
            className="grid size-8 place-items-center rounded-lg text-fg-muted transition-colors duration-micro ease-expo hover:bg-white/8 hover:text-fg"
          >
            <Maximize2 size={15} />
          </button>
        </Tooltip>
      </div>
      {notice && (
        <div className="absolute top-14 right-3 z-10 rounded-lg border border-line/24 bg-canvas/88 px-3 py-1.5 font-mono text-[11px] text-fg-subtle shadow-soft backdrop-blur-md">
          {notice}
        </div>
      )}
    </>
  );
}

function ActionButton({ action, onRun }: { action: MockWorktreeAction; onRun: () => void }) {
  const Icon = action.icon;

  return (
    <Tooltip label={action.mocked ? `${action.label} — mocked` : action.label}>
      <button
        type="button"
        onClick={onRun}
        aria-label={action.label}
        className={`grid size-8 place-items-center rounded-lg transition-colors duration-micro ease-expo hover:bg-white/8 ${
          action.accent ? 'text-violet hover:text-violet' : 'text-fg-muted hover:text-fg'
        }`}
      >
        <Icon size={16} />
      </button>
    </Tooltip>
  );
}

function logMockAction(label: string) {
  return (worktreeId: number) => {
    console.info(`[mock action] ${label}`, { worktreeId });
  };
}
