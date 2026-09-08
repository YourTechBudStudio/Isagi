import { QueryClientProvider } from '@tanstack/react-query';
import { Unlink } from 'lucide-react';
import { AnimatePresence } from 'motion/react';
import { useEffect, useState } from 'react';

import type { ProjectKind } from '@isagi/contracts';

import { EmptyState } from '../../../src/components/EmptyState.js';
import { MonoAside } from '../../../src/components/MonoAside.js';
import { canvasCopy, missingProjectCopy } from '../../../src/copy/index.js';
import { queryClient } from '../../../src/lib/query/client.js';
import { ToastProvider } from '../../../src/lib/toast/index.js';
import { useWorkspace, useWorkspaceSelectionSync } from '../../../src/lib/workspace/hooks.js';
import { useWorkspaceStore } from '../../../src/lib/workspace/store.js';
import type { MissingProject, PresentProject } from '../../../src/lib/workspace/types.js';
import { PalettePreview } from './PalettePreview.js';
import { RailPreview } from './RailPreview.js';
import { RecoveryActions } from './RecoveryActions.js';
import { ScenarioBar } from './ScenarioBar.js';
import { DEFAULT_SCENARIO, scenarioById, type ScenarioId } from './seed.js';
import { StatusStripPreview } from './StatusStripPreview.js';

/**
 * The folder-project fixture: full workspace chrome — rail, canvas, status strip
 * — over a fake runtime, with the seven scenarios switchable in place.
 *
 * Every design question this page was built to ask is now closed, so nothing
 * here is a treatment any more; the settled behaviour is hardcoded. What the
 * controls still offer is the four recheck outcomes, latency, and a comparison
 * against today's app.
 *
 * Everything about *data flow* here is production: the workspace query, the
 * decode, the selection store, and `useWorkspaceSelectionSync`. That last one is
 * not decoration. The claim that a selection made while a recheck is in flight
 * survives its completion is a claim about `reconcileSelection`, and a fixture
 * that reimplemented selection would be testing its own reimplementation.
 *
 * What is prototyped — and owed back — is presentation only: the rail rows, the
 * strip's branch tag, the two palette commands, and the recovery panel. Each of
 * those files says which phase repays it.
 */
export function FolderProjectApp() {
  return (
    <QueryClientProvider client={queryClient}>
      {/* The production toaster, wrapping the page exactly as the app wraps its
          own. Nothing on this page raises a toast deliberately — a restore is
          silent by design — but `useWorkspaceSelectionSync` does, and swallowing
          those would make the fixture quieter than the app it is standing in for. */}
      <ToastProvider>
        <FolderProjectBody />
      </ToastProvider>
    </QueryClientProvider>
  );
}

function FolderProjectBody() {
  // Carries a token as well as an id, so clicking the *current* scenario resets
  // it. Without that, a scenario whose recheck restored the folder would have no
  // way back to the missing state short of a page reload — and the missing state
  // is the one worth looking at repeatedly.
  const [scenario, setScenario] = useState({ id: DEFAULT_SCENARIO as ScenarioId, run: 0 });
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [ready, setReady] = useState(false);

  useWorkspaceSelectionSync();
  const {
    projects,
    activeWorktree,
    activeMissingProject,
    activeWorktreeId,
    selectedProjectId,
    selectWorktree,
    selectMissingProject,
  } = useWorkspace();

  // Each scenario opens where its claim lives — a folder environment, or the
  // canvas recovery state. One owner for the whole reset: this effect returns
  // the fake runtime's snapshot and the selection to their starting state, and
  // the run token it carries remounts the recovery surface (see the canvas
  // below), which is where the rest of the resettable state lives.
  //
  // The snapshot is awaited *before* the selection is applied. Setting selection
  // first would hand production selection reconciliation a workspace from the
  // outgoing scenario, and a project that does not exist there is reconciled
  // away to a default — so switching to a scenario that shares no project with
  // the last one would silently land somewhere else. Only reachable by clicking
  // between scenarios, which is exactly what this page is for.
  useEffect(() => {
    let cancelled = false;
    const apply = async () => {
      await window.folderProjectFixture?.setScenario(scenario.id);
      if (cancelled) return;
      const { opens } = scenarioById(scenario.id);
      const store = useWorkspaceStore.getState();
      if (opens.kind === 'worktree') {
        store.selectWorktree(opens.projectId, opens.worktreeId);
      } else {
        store.selectMissingProject(opens.projectId);
      }
      setReady(true);
    };
    void apply();
    // A rapid second click must not let the first switch finish after it.
    return () => {
      cancelled = true;
    };
  }, [scenario]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      // Only when the palette owns the press. The recovery panel's own Escape
      // handler captures before this one, so an armed removal still backs out
      // rather than closing something behind it.
      if (event.key === 'Escape' && paletteOpen) setPaletteOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [paletteOpen]);

  const presentProjects = projects.filter(
    (project): project is PresentProject => project.status === 'present',
  );
  const missingProjects = projects.filter(
    (project): project is MissingProject => project.status === 'missing',
  );
  const activeProjectKind: ProjectKind | null =
    projects.find((project) => project.id === selectedProjectId)?.kind ?? null;

  return (
    <div
      data-fixture-shell
      className="grid h-screen grid-rows-[auto_1fr] overflow-hidden bg-canvas text-fg"
    >
      <ScenarioBar
        scenarioId={scenario.id}
        onScenarioChange={(id) => setScenario((previous) => ({ id, run: previous.run + 1 }))}
        onOpenPalette={() => setPaletteOpen(true)}
      />

      <div className="relative grid min-h-0 grid-cols-[236px_1fr]">
        {ready && (
          <RailPreview
            presentProjects={presentProjects}
            missingProjects={missingProjects}
            activeWorktreeId={activeWorktreeId}
            selectedProjectId={selectedProjectId}
            onSelectWorktree={selectWorktree}
            onSelectMissingProject={selectMissingProject}
          />
        )}

        <div className="grid min-h-0 grid-rows-[1fr_auto]">
          <div className="relative min-h-0 overflow-hidden">
            {activeMissingProject ? (
              // Keyed on the run token so a scenario click genuinely resets
              // this surface. Its recovery mutation and its armed-removal state
              // are component-local, and re-selecting a *still missing* project
              // does not unmount it — so without the key a settled "Still not
              // there" verdict, or a half-armed confirmation, would survive a
              // reset that claims to clear the page and be read as belonging to
              // the run that follows it.
              <MissingProjectPreview key={scenario.run} project={activeMissingProject} />
            ) : activeWorktree ? (
              <EnvironmentPreview title={activeWorktree.title} path={activeWorktree.path} />
            ) : (
              <EmptyState
                title={canvasCopy.freshEmpty.title}
                body={canvasCopy.freshEmpty.body}
                aside={canvasCopy.freshEmpty.aside}
              />
            )}
          </div>

          <StatusStripPreview worktree={activeWorktree} projectKind={activeProjectKind} />
        </div>

        <AnimatePresence>
          {paletteOpen && (
            <PalettePreview projects={projects} onClose={() => setPaletteOpen(false)} />
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

/**
 * The canvas state for a project Isagi can't reach. Composed from the production
 * `EmptyState` with the production copy, because the recovery actions have to be
 * judged in the room they actually get rather than on their own.
 */
function MissingProjectPreview({ project }: { project: MissingProject }) {
  return (
    <EmptyState
      halo="error"
      wide
      eyebrow={missingProjectCopy.eyebrow}
      icon={
        <div className="grid size-14 place-items-center rounded-2xl border border-error/30 bg-error/8 text-error shadow-soft">
          <Unlink size={26} strokeWidth={1.6} />
        </div>
      }
      title={missingProjectCopy.title}
      body={
        <>
          {missingProjectCopy.bodyPrefix}{' '}
          <span className="rounded-md bg-black/25 px-1.5 py-0.5 font-mono text-[13px] text-fg">
            {project.rootPath}
          </span>{' '}
          {missingProjectCopy.bodySuffix(project)}
        </>
      }
      actions={<RecoveryActions project={project} />}
      aside={missingProjectCopy.aside}
    />
  );
}

/**
 * A stand-in for whatever surface the environment holds. The work surface is the
 * hero everywhere else in Isagi; here it is deliberately inert, because this page
 * is judging the chrome around it and a real terminal would win the eye.
 */
function EnvironmentPreview({ title, path }: { title: string; path: string }) {
  return (
    <div className="grid h-full place-items-center">
      <div className="text-center">
        <p className="font-display text-[22px] font-semibold tracking-[-0.03em] text-fg-muted">
          {title}
        </p>
        <p className="mt-1.5 font-mono text-[12px] text-fg-subtle">{path}</p>
        <MonoAside className="mt-4">{'// the work surface lives here'}</MonoAside>
      </div>
    </div>
  );
}
