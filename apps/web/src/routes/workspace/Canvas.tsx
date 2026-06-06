import { Plus, Unlink } from 'lucide-react';

import { Button } from '../../components/Button.js';
import { EmptyState } from '../../components/EmptyState.js';
import { usePaletteStore } from '../../lib/palette/store.js';
import { modKey } from '../../lib/platform.js';
import { useWorkspace, useWorkspaceStore } from '../../lib/workspace/store.js';
import { surfaceIcon } from '../../lib/workspace/surface-presentation.js';
import type { Project, Surface, Worktree } from '../../lib/workspace/types.js';
import { AgentSurface } from './AgentSurface.js';
import { TerminalSurface } from './TerminalSurface.js';

/**
 * The canvas — the hero. Renders the active worktree's active surface, or a calm
 * empty state when there's nothing to show. Navigation lives in the rail, so
 * the canvas carries no tab chrome.
 */
export function Canvas() {
  const { activeWorktree, activeMissingProject, activeSurface, loading, error } = useWorkspace();
  if (activeMissingProject) {
    return <MissingProjectState project={activeMissingProject} />;
  }

  if (!activeWorktree && loading) {
    return <LoadingState />;
  }

  if (!activeWorktree && error) {
    return <RuntimeErrorState error={error} />;
  }

  if (!activeWorktree) {
    return <FreshEmptyState />;
  }

  if (!activeSurface) {
    return <NoSurfaceState worktree={activeWorktree} />;
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

function LoadingState() {
  return (
    <EmptyState
      title="Checking the runtime."
      body="Isagi is asking the runtime for registered projects and Git worktrees."
      aside="// no spinner; just the boring handshake"
    />
  );
}

function RuntimeErrorState({ error }: { error: string }) {
  return (
    <EmptyState
      halo="error"
      title="Runtime connection failed."
      body="Isagi could not load projects from the runtime. Check the runtime process and try again."
    >
      <p className="mt-0.5 max-w-full rounded-sm border border-error/24 bg-error/8 px-3 py-2 font-mono text-[12px] text-error">
        {error}
      </p>
    </EmptyState>
  );
}

function FreshEmptyState() {
  const openPalette = usePaletteStore((state) => state.openPalette);

  return (
    <EmptyState
      title="No worktrees on the canvas."
      body="Point Isagi at a repo root. It'll find the worktrees you forgot you made."
      actions={
        <Button icon={Plus} shortcut={`${modKey}N`} onClick={() => openPalette('add-project')}>
          Add project
        </Button>
      }
      aside="// git already knows; Isagi remembers where you were"
    />
  );
}

function NoSurfaceState({ worktree }: { worktree: Worktree }) {
  return (
    <EmptyState
      title="No surfaces here yet."
      body={`Isagi found ${worktree.title}. Agents, terminals, commands, and restored surfaces land in the next slices.`}
      aside="// navigation first; room furniture later"
    />
  );
}

function MissingProjectState({ project }: { project: Project }) {
  return (
    <EmptyState
      halo="error"
      wide
      eyebrow="Project unavailable"
      icon={
        <div className="grid size-14 place-items-center rounded-2xl border border-error/30 bg-error/8 text-error shadow-soft">
          <Unlink size={26} strokeWidth={1.6} />
        </div>
      }
      title="Can't use this project right now."
      body={
        <>
          Isagi expected{' '}
          <span className="rounded-md bg-black/25 px-1.5 py-0.5 font-mono text-[13px] text-fg">
            {project.rootPath ?? project.name}
          </span>{' '}
          but the runtime cannot use it right now.{' '}
          {project.missingReason ??
            'The path may be missing, moved, or no longer readable as a Git worktree.'}
        </>
      }
      actions={
        <>
          <Button disabled title="Project relocation lands in the next phase">
            Set new path… <span className="ml-1 font-mono text-[10px] text-fg-subtle">soon</span>
          </Button>
          <Button variant="secondary" disabled>
            Remove project <span className="ml-1 font-mono text-[10px] text-fg-subtle">soon</span>
          </Button>
        </>
      }
      aside="// relocate & remove land in the next phase"
    />
  );
}
