import { usePaletteStore } from '../../lib/palette/store.js';
import { modKey } from '../../lib/platform.js';
import { useWorkspace, useWorkspaceStore } from '../../lib/workspace/store.js';
import { surfaceIcon } from '../../lib/workspace/surface-presentation.js';
import type { Surface } from '../../lib/workspace/types.js';
import { AgentSurface } from './AgentSurface.js';
import { TerminalSurface } from './TerminalSurface.js';

/**
 * The canvas — the hero. Renders the active worktree's active surface, or a calm
 * empty state when there's nothing to show. Navigation lives in the rail, so
 * the canvas carries no tab chrome.
 */
export function Canvas() {
  const { activeWorktree, activeSurface } = useWorkspace();

  if (!activeWorktree) {
    return <FreshEmptyState />;
  }

  if (!activeSurface) {
    return <NoAgentState worktreeId={activeWorktree.id} />;
  }

  if (activeSurface.kind === 'agent') {
    return <AgentSurface key={activeSurface.id} surface={activeSurface} />;
  }

  if (activeSurface.kind === 'terminal') {
    return <TerminalSurface key={activeSurface.id} surface={activeSurface} />;
  }

  return <SurfacePlaceholder surface={activeSurface} />;
}

function SurfacePlaceholder({ surface }: { surface: Surface }) {
  const Icon = surfaceIcon(surface.kind);
  const setZen = useWorkspaceStore((state) => state.setZen);

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-md border border-line/20 bg-elevated/50 backdrop-blur-sm">
      <div className="flex items-center gap-2.5 border-b border-line/15 px-3.5 py-2.5">
        <Icon size={14} className="text-fg-subtle" />
        <span className="font-mono text-[12px] text-fg-muted">
          {surface.source ?? surface.title}
        </span>
        <span className="ml-auto flex gap-2 font-mono text-[11px] text-fg-subtle">
          <span className="cursor-default rounded-md border border-line/28 px-2 py-1">
            ⤤ pop out
          </span>
          <button
            type="button"
            onClick={() => setZen(true)}
            className="rounded-md border border-line/28 px-2 py-1 transition-colors hover:border-blue/45 hover:text-fg"
          >
            ⤢ zen
          </button>
        </span>
      </div>
      <div className="grid flex-1 place-items-center">
        <span className="font-mono text-[12px] text-fg-subtle opacity-55">
          {surfacePlaceholderCopy(surface)}
        </span>
      </div>
    </div>
  );
}

function surfacePlaceholderCopy(surface: Surface): string {
  switch (surface.kind) {
    case 'browser':
      return '// a live browser surface — auto-detected from a running command';
    case 'editor':
      return '// VS Code in the browser — restores the artifacts you had open';
    default:
      return `// ${surface.title}`;
  }
}

function FreshEmptyState() {
  const openPalette = usePaletteStore((state) => state.openPalette);

  return (
    <CanvasEmpty>
      <h1 className="font-display text-[27px] font-semibold tracking-[-0.03em] text-fg">
        Nothing&apos;s running yet.
      </h1>
      <p className="text-[14.5px] leading-relaxed text-fg-muted">
        Isagi keeps a worktree&apos;s whole room warm — agents, dev servers, the diff you were
        staring at. Start a worktree and it picks up exactly where you left off.
      </p>
      <button
        type="button"
        onClick={() => openPalette('new-worktree')}
        className="mt-1 inline-flex items-center gap-2.5 rounded-xl border border-blue/32 bg-blue/15 px-4 py-2.5 text-[13px] font-medium text-fg transition-colors duration-micro ease-expo hover:bg-blue/22"
      >
        <span>+ New worktree</span>
        <span className="rounded-md border border-line/40 px-1.5 py-px font-mono text-[11px] text-fg-subtle">
          {modKey}N
        </span>
      </button>
      <p className="mt-0.5 font-mono text-[12px] text-fg-subtle opacity-55">
        {'// '}
        {modKey}
        N. that&apos;s the entire tutorial.
      </p>
    </CanvasEmpty>
  );
}

function NoAgentState({ worktreeId }: { worktreeId: string }) {
  const addAgentSession = useWorkspaceStore((state) => state.addAgentSession);

  return (
    <CanvasEmpty>
      <h1 className="font-display text-[27px] font-semibold tracking-[-0.03em] text-fg">
        No agent here yet.
      </h1>
      <p className="text-[14.5px] leading-relaxed text-fg-muted">
        Just you and an empty worktree, staring at each other.
      </p>
      <button
        type="button"
        onClick={() => addAgentSession(worktreeId)}
        className="mt-1 inline-flex items-center gap-2.5 rounded-xl border border-blue/32 bg-blue/15 px-4 py-2.5 text-[13px] font-medium text-fg transition-colors duration-micro ease-expo hover:bg-blue/22"
      >
        + Start an agent
      </button>
      <p className="mt-0.5 font-mono text-[12px] text-fg-subtle opacity-55">
        {'// somebody has to make the first move'}
      </p>
    </CanvasEmpty>
  );
}

function CanvasEmpty({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative grid h-full place-items-center overflow-hidden">
      <div className="pointer-events-none absolute size-160 rounded-full bg-radial from-blue/10 to-transparent to-60%" />
      <div className="relative flex max-w-[44ch] flex-col items-center gap-3.5 text-center">
        {children}
      </div>
    </div>
  );
}
