import {
  Maximize2,
  Minimize2,
  Play,
  Plus,
  RotateCcw,
  Square,
  SquareChevronRight,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

import { AttentionDot } from '../../components/AttentionDot.js';
import { surfaceTransition } from '../../lib/motion.js';
import { useActiveWorktree } from '../../lib/workspace/hooks.js';
import { useWorkspaceStore } from '../../lib/workspace/store.js';
import type { Command } from '../../lib/workspace/types.js';

const MIN_WIDTH = 380;

const mockCommands: readonly Command[] = [
  {
    id: 'mock-web',
    label: 'pnpm dev:web',
    status: 'running',
    attention: 'working',
    ports: [5173],
    log: [
      '$ pnpm --filter @isagi/web dev',
      'vite v8.0.14 ready in 184 ms',
      '➜  Local:   http://127.0.0.1:5173/',
      'watching for file changes...',
    ],
  },
  {
    id: 'mock-runtime',
    label: 'runtime server',
    status: 'running',
    attention: 'idle',
    ports: [17373],
    log: [
      '$ pnpm --filter @isagi/runtime dev:fixed',
      'ISAGI_RUNTIME_READY {"url":"http://127.0.0.1:17373"}',
      'workspace.get completed in 12ms',
      'workspace.setActiveContext persisted in 8ms',
    ],
  },
  {
    id: 'mock-tests',
    label: 'pnpm check',
    status: 'exited',
    attention: 'error',
    ports: [],
    log: [
      '$ pnpm check',
      'lint passed',
      'typecheck passed',
      'build passed',
      'format:check failed: scratch/review/index.html',
    ],
  },
];

/**
 * The workbench drawer — a dedicated monitor for the worktree's commands. Slides
 * in from the right at full height; master-detail (command list + live log).
 * Commands are processes you *watch* (logs, ports, run/stop); interactive shells
 * live on the canvas as terminal surfaces, not here. No close button — Esc or a
 * click outside dismisses it.
 */
export function WorkbenchDrawer() {
  const open = useWorkspaceStore((state) => state.drawer.open);
  const closeDrawer = useWorkspaceStore((state) => state.closeDrawer);

  const asideRef = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(640);
  const [expanded, setExpanded] = useState(false);
  const widthRef = useRef(width);
  widthRef.current = width;

  // Dismiss on Escape or a click anywhere outside the drawer (no close button).
  useEffect(() => {
    if (!open) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeDrawer();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (asideRef.current && !asideRef.current.contains(event.target as Node)) {
        closeDrawer();
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open, closeDrawer]);

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    setExpanded(false);
    const startX = event.clientX;
    const startWidth = widthRef.current;
    // The only real bound is the work area; drag as broad as that.
    const maxWidth = asideRef.current?.parentElement?.clientWidth ?? startWidth;
    const onMove = (moveEvent: PointerEvent) => {
      const next = startWidth + (startX - moveEvent.clientX);
      setWidth(Math.max(MIN_WIDTH, Math.min(maxWidth, next)));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.aside
          key="drawer"
          ref={asideRef}
          initial={{ x: '100%', opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: '100%', opacity: 0 }}
          transition={surfaceTransition}
          style={{ width: expanded ? '100%' : width }}
          className="absolute top-0 right-0 bottom-0 z-20 flex flex-col border-l border-line/24 bg-canvas/85 shadow-lift backdrop-blur-lg"
        >
          <div
            onPointerDown={startResize}
            className="group/grip absolute top-0 bottom-0 left-0 w-1.75 cursor-col-resize"
          >
            <span className="absolute top-[30%] bottom-[30%] left-0.5 w-0.5 rounded-full bg-transparent transition-colors group-hover/grip:bg-blue/45" />
          </div>

          <div className="flex h-11 flex-none items-center gap-2 border-b border-line/14 px-3.5">
            <SquareChevronRight size={14} className="text-fg-subtle" />
            <span className="font-mono text-[12px] text-fg-muted">Commands</span>
            <button
              type="button"
              onClick={() => setExpanded((value) => !value)}
              title={expanded ? 'Restore width' : 'Expand to full width'}
              className="ml-auto grid size-7 place-items-center rounded-md text-fg-subtle transition-colors hover:bg-white/6 hover:text-fg"
            >
              {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
          </div>

          <div className="flex min-h-0 flex-1">
            <CommandsView />
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}

function CommandsView() {
  const worktree = useActiveWorktree();
  const selectedId = useWorkspaceStore((state) => state.drawer.selectedCommandId);
  const selectCommand = useWorkspaceStore((state) => state.selectCommand);
  const [commands, setCommands] = useState<readonly Command[]>(mockCommands);

  useEffect(() => {
    setCommands(worktree ? mockCommands : []);
  }, [worktree]);

  const selected = commands.find((command) => command.id === selectedId) ?? commands[0] ?? null;

  const toggleCommand = (commandId: string) => {
    setCommands((current) =>
      current.map((command) => {
        if (command.id !== commandId) {
          return command;
        }

        const running = command.status === 'running';
        return {
          ...command,
          status: running ? 'stopped' : 'running',
          attention: running ? 'idle' : 'working',
          log: [...command.log, running ? 'mock: stopped command' : 'mock: started command'],
        };
      }),
    );
  };

  return (
    <>
      <div className="flex w-52 flex-none flex-col overflow-auto border-r border-line/12 p-2">
        {commands.length === 0 ? (
          <p className="px-2 pt-1 font-mono text-[11px] text-fg-subtle opacity-55">
            {'// no commands yet'}
          </p>
        ) : (
          commands.map((command) => (
            <div
              key={command.id}
              className={`flex w-full items-center gap-2 rounded-lg px-2 py-2 transition-colors ${
                command.id === selected?.id ? 'bg-white/8' : 'hover:bg-white/4'
              }`}
            >
              <button
                type="button"
                title={command.status === 'running' ? 'Stop' : 'Run'}
                aria-label={`${command.status === 'running' ? 'Stop' : 'Run'} ${command.label}`}
                onClick={() => toggleCommand(command.id)}
                className="grid size-5 flex-none place-items-center rounded-md border border-line/30 text-fg-subtle hover:border-green/50 hover:text-green"
              >
                {command.status === 'running' ? <Square size={9} /> : <Play size={9} />}
              </button>
              <button
                type="button"
                onClick={() => selectCommand(command.id)}
                aria-current={command.id === selected?.id ? 'true' : undefined}
                className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
              >
                <AttentionDot state={command.attention} />
                <span className="truncate font-mono text-[12px] text-fg">{command.label}</span>
              </button>
            </div>
          ))
        )}
        {/* Authoring lands in Phase 5 (project config); affordance shown now. */}
        <button
          type="button"
          disabled
          title="Command authoring lands in the command-runner slice"
          className="mt-0.5 flex w-full cursor-not-allowed items-center gap-2 rounded-lg px-2 py-2 font-mono text-[11.5px] text-fg-subtle opacity-55"
        >
          <Plus size={13} />
          new command
        </button>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        {selected ? <CommandDetail command={selected} /> : null}
      </div>
    </>
  );
}

function CommandDetail({ command }: { command: Command }) {
  const worktree = useActiveWorktree();
  const restartCommand = (commandId: string) => {
    console.info('[mock command] restart', { worktreeId: worktree?.id, commandId });
  };

  return (
    <>
      <div className="flex h-11 flex-none items-center gap-2.5 border-b border-line/12 px-3.5">
        <AttentionDot state={command.attention} />
        <span className="font-mono text-[12px] text-fg">{command.label}</span>
        <span className="font-mono text-[10.5px] text-fg-subtle">{command.status}</span>
        <span className="ml-auto flex items-center gap-1.5">
          {command.ports.map((port) => (
            <span
              key={port}
              className="rounded-md border border-cyan/28 bg-cyan/10 px-1.5 py-px font-mono text-[10.5px] text-cyan"
            >
              :{port}
            </span>
          ))}
          <button
            type="button"
            title="Restart"
            onClick={() => {
              if (worktree) {
                restartCommand(command.id);
              }
            }}
            className="grid size-6 place-items-center rounded-md text-fg-subtle transition-colors hover:bg-white/6 hover:text-fg"
          >
            <RotateCcw size={12} />
          </button>
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-4 py-3 font-mono text-[11.5px] leading-relaxed text-fg-muted">
        {command.log.map((line, index) => (
          <p key={`${command.id}-log-${index}`} className="whitespace-pre-wrap">
            {line}
          </p>
        ))}
      </div>
    </>
  );
}
