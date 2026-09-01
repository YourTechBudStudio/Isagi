import { Bot, Code, Maximize2, ScanSearch, SquareChevronRight, SquareTerminal } from 'lucide-react';
import { Fragment, useEffect, useState } from 'react';

import { Tooltip } from '../../components/Tooltip.js';
import { worktreeActionsCopy } from '../../copy/index.js';
import { useEditorAvailable } from '../../lib/control-plane/queries.js';
import type { IconType } from '../../lib/icon.js';
import {
  handleDispatchedCommandError,
  useCommandDispatcher,
} from '../../lib/palette/dispatcher.js';
import { useActiveWorktree } from '../../lib/workspace/hooks.js';
import { useWorkspaceStore } from '../../lib/workspace/store.js';

/** What the bar knows about the runtime when it decides which rows to offer. */
interface ActionCapabilities {
  readonly editorAvailable: boolean;
}

interface WorktreeActionBase {
  readonly id: string;
  readonly label: string;
  readonly icon: IconType;
  readonly accent?: boolean;
  /**
   * Rows without a predicate are always offered. A row that only makes sense
   * under some runtime state answers for itself here, so availability is a
   * typed field rather than an id the render path has to recognise.
   */
  readonly visible?: (capabilities: ActionCapabilities) => boolean;
}

/**
 * The two kinds of row, kept apart in the type so neither can be half-built: a
 * `callback` row runs a plain function, a `command` row dispatches a palette
 * command (which a module-scoped function cannot do, because dispatching needs
 * hooks). Execution reads the discriminant instead of comparing ids, so a new
 * row cannot silently do nothing by omitting its behaviour.
 */
type WorktreeAction = WorktreeActionBase &
  (
    | {
        readonly kind: 'callback';
        readonly mocked?: boolean;
        readonly run: (worktreeId: number) => void;
      }
    | { readonly kind: 'command'; readonly commandId: string }
  );

const worktreeActions: readonly WorktreeAction[] = [
  {
    kind: 'callback',
    id: 'new-agent',
    label: 'New agent',
    icon: Bot,
    mocked: true,
    run: logMockAction('New agent'),
  },
  {
    kind: 'callback',
    id: 'new-terminal',
    label: 'New terminal',
    icon: SquareTerminal,
    mocked: true,
    run: logMockAction('New terminal'),
  },
  {
    // Real, not mocked: it dispatches the palette command from the component,
    // with an explicit worktree, exactly as the palette row does.
    kind: 'command',
    id: 'open-editor',
    commandId: 'open-editor',
    label: worktreeActionsCopy.openEditor,
    icon: Code,
    visible: (capabilities) => capabilities.editorAvailable,
  },
  {
    kind: 'callback',
    id: 'ai-review',
    label: 'AI review',
    icon: ScanSearch,
    accent: true,
    mocked: true,
    run: logMockAction('AI review'),
  },
  {
    kind: 'callback',
    id: 'open-commands',
    label: 'Open commands',
    icon: SquareChevronRight,
    run: () => useWorkspaceStore.getState().openDrawer(),
  },
];

const dividerBefore = new Set(['ai-review', 'open-commands']);

/**
 * The action bar — a cluster of high-frequency worktree verbs.
 *
 * Most rows are still labelled mocks. `Open editor` is not: it dispatches the
 * real palette command with an explicit worktree, and it is **hidden** when the
 * runtime says the editor is unavailable.
 *
 * Hiding is the only client-side gate on this path: an explicit dispatch carries
 * values, so `dispatchCommandEntry` resolves the command through
 * `workbenchActionCommands` and never consults `available`. It is not a
 * capability boundary — the runtime's own `requireAvailable` refusal is the
 * authoritative backstop, and this row's absence is about not offering a button
 * that cannot work, not about preventing the call.
 */
export function ActionBar() {
  const worktree = useActiveWorktree();
  const setZen = useWorkspaceStore((state) => state.setZen);
  const dispatchCommand = useCommandDispatcher();
  const editorAvailable = useEditorAvailable();
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

  const visibleActions = worktreeActions.filter(
    (action) => action.visible?.({ editorAvailable }) ?? true,
  );

  const run = (action: WorktreeAction) => {
    if (action.kind === 'command') {
      // The compact button has no inline failure surface of its own, so a
      // refusal goes to the shared dispatch handler.
      void dispatchCommand(action.commandId, { worktreeId: String(worktree.id) }).catch(
        handleDispatchedCommandError,
      );
      return;
    }
    action.run(worktree.id);
    if (action.mocked) {
      setNotice(`${action.label} is mocked for now.`);
    }
  };

  return (
    <>
      <div className="absolute top-3 right-3 z-10 flex items-center gap-0.5 rounded-xl border border-line/24 bg-elevated/65 p-1 shadow-soft backdrop-blur-md">
        {visibleActions.map((action) => (
          <Fragment key={action.id}>
            {dividerBefore.has(action.id) && <span className="mx-0.5 h-4 w-px bg-line/25" />}
            <ActionButton action={action} onRun={() => run(action)} />
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

function ActionButton({ action, onRun }: { action: WorktreeAction; onRun: () => void }) {
  const Icon = action.icon;

  const mocked = action.kind === 'callback' && action.mocked === true;

  return (
    <Tooltip label={mocked ? `${action.label} — mocked` : action.label}>
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
