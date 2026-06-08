import { MotionConfig } from 'motion/react';
import { useEffect } from 'react';

import { Button } from '../../components/Button.js';
import { EmptyState } from '../../components/EmptyState.js';
import { TooltipDelayProvider } from '../../components/Tooltip.js';
import { EASE_EXPO, DURATION } from '../../lib/motion.js';
import { usePaletteStore } from '../../lib/palette/store.js';
import {
  usePersistActiveContextSelection,
  useWorkspaceSelectionSync,
} from '../../lib/workspace/hooks.js';
import { formatRuntimeError, useWorkspaceQuery } from '../../lib/workspace/queries.js';
import {
  useWorktreeSetupFailureStore,
  type WorktreeSetupFailure,
} from '../../lib/workspace/setup-failure.js';
import { useWorkspaceStore } from '../../lib/workspace/store.js';
import { CommandPalette } from './CommandPalette.js';
import { Rail } from './Rail.js';
import { WorkArea } from './WorkArea.js';

function FirstRunDragRegion() {
  return (
    <div
      aria-hidden="true"
      className="absolute inset-x-0 top-0 z-10 h-(--isagi-rail-top-inset,2.5rem) [-webkit-app-region:drag]"
    />
  );
}

/**
 * The workspace shell — Isagi's single primary surface.
 *
 * Layout (the "rail-spine" composition): once at least one project is
 * configured, the Rail is a continuous full-height navigation spine on the
 * left; the work area fills the rest. Before then, the work area owns the full
 * window so the first-run empty state is visually centered.
 */
function WorkspaceBootSurface() {
  return (
    <main className="canvas-atmosphere grid h-screen place-items-center p-6">
      <EmptyState
        title="Restoring the workspace."
        body="Isagi is asking the runtime for projects, worktrees, and the last room you had open."
        aside="// no empty-state snap; wait for the facts"
      />
    </main>
  );
}

function WorktreeSetupFailureModal() {
  const failure = useWorktreeSetupFailureStore((state) => state.failure);
  const clearFailure = useWorktreeSetupFailureStore((state) => state.clearFailure);
  if (!failure) {
    return null;
  }

  const setup = failure.setup;
  const details = setupFailureDetails(setup);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-scrim/55 px-4 backdrop-blur-sm">
      <section className="w-150 max-w-full rounded-lg border border-error/28 bg-elevated/92 p-5 shadow-lift backdrop-blur-2xl">
        <p className="text-[15px] font-semibold text-fg">Worktree created, setup failed.</p>
        <p className="mt-2 text-[13px] leading-snug text-fg-muted">
          Isagi created <span className="font-mono text-fg">{failure.branch}</span>, but hook{' '}
          <span className="font-mono text-fg">{setup.failedHookIndex}</span> failed while running{' '}
          <span className="font-mono text-fg">{setup.failedHookType}</span>.
        </p>
        <pre className="mt-3 max-h-56 overflow-auto whitespace-pre-wrap rounded-md border border-error/24 bg-error/8 px-3 py-2 font-mono text-[12px] leading-snug text-error">
          {details}
        </pre>
        <p className="mt-2 font-mono text-[10.5px] text-fg-subtle">
          setup run {setup.runId} · worktree {failure.worktreeId}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => void navigator.clipboard?.writeText(details)}>
            Copy error
          </Button>
          <Button onClick={clearFailure}>Open worktree anyway</Button>
        </div>
      </section>
    </div>
  );
}

function setupFailureDetails(setup: Extract<WorktreeSetupFailure['setup'], { status: 'failed' }>) {
  return [
    setup.message,
    setup.command ? `command: ${setup.command}` : null,
    setup.src ? `src: ${setup.src}` : null,
    setup.dest ? `dest: ${setup.dest}` : null,
    setup.exitCode !== undefined && setup.exitCode !== null ? `exit code: ${setup.exitCode}` : null,
    setup.signal ? `signal: ${setup.signal}` : null,
    setup.stderrExcerpt ? `\nstderr:\n${setup.stderrExcerpt}` : null,
    setup.stdoutExcerpt ? `\nstdout:\n${setup.stdoutExcerpt}` : null,
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n');
}

function WorkspaceRuntimeError({ error }: { error: string }) {
  return (
    <main className="canvas-atmosphere grid h-screen place-items-center p-6">
      <EmptyState
        halo="error"
        title="Runtime connection failed."
        body="Isagi could not load the workspace snapshot. Check the runtime process and try again."
      >
        <p className="mt-0.5 max-w-full rounded-sm border border-error/24 bg-error/8 px-3 py-2 font-mono text-[12px] text-error">
          {error}
        </p>
      </EmptyState>
    </main>
  );
}

export function WorkspacePage() {
  const zen = useWorkspaceStore((state) => state.zen);
  const setZen = useWorkspaceStore((state) => state.setZen);
  const workspace = useWorkspaceQuery();
  const workspaceErrorIsFatal = Boolean(workspace.error && !workspace.data);
  const hasConfiguredProjects =
    !workspaceErrorIsFatal && (workspace.data?.projects.length ?? 0) > 0;
  const paletteOpen = usePaletteStore((state) => state.open);

  useWorkspaceSelectionSync();
  usePersistActiveContextSelection();

  // Ask the optional host shell to quiet native chrome in zen. Browser-hosted
  // web builds simply do not provide this bridge.
  useEffect(() => {
    void window.isagi?.setHostChromeVisible?.(!zen);
  }, [zen]);

  // Zen: Esc exits (unless the palette owns Esc); a provisional Mod+. toggles it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && zen && !paletteOpen) {
        event.preventDefault();
        setZen(false);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key === '.') {
        event.preventDefault();
        setZen(!zen);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zen, paletteOpen, setZen]);

  return (
    <MotionConfig reducedMotion="user" transition={{ duration: DURATION.ui, ease: EASE_EXPO }}>
      <TooltipDelayProvider>
        <>
          <div
            className={`relative z-1 grid h-screen ${
              hasConfiguredProjects ? 'grid-cols-[236px_1fr]' : 'grid-cols-1'
            }`}
          >
            {!hasConfiguredProjects && <FirstRunDragRegion />}
            {workspace.isPending && !workspace.data ? (
              <WorkspaceBootSurface />
            ) : workspaceErrorIsFatal ? (
              <WorkspaceRuntimeError error={formatRuntimeError(workspace.error)} />
            ) : (
              <>
                {hasConfiguredProjects && <Rail />}
                <WorkArea />
              </>
            )}
          </div>
          <CommandPalette />
          <WorktreeSetupFailureModal />
        </>
      </TooltipDelayProvider>
    </MotionConfig>
  );
}
