import { Effect } from 'effect';
import { create } from 'zustand';

import type { PathSuggestOutput, WorkspaceSnapshot } from '@isagi/contracts';

import {
  addProject,
  fetchWorkspace,
  formatRuntimeError,
  suggestProjectPaths,
  updateActiveContext,
} from './runtime-data.js';
import { findActiveSurface } from './selectors.js';
import type { AccentColor, Project, Surface, Worktree } from './types.js';

interface DrawerState {
  readonly open: boolean;
  readonly selectedCommandId: string | null;
}

interface WorkspaceStore {
  projects: readonly Project[];
  activeWorktreeId: number | null;
  selectedProjectId: number | null;
  loading: boolean;
  error: string | null;
  drawer: DrawerState;
  zen: boolean;

  setZen: (zen: boolean) => void;
  toggleZen: () => void;
  loadWorkspace: () => void;
  addProjectPath: (path: string) => Promise<void>;
  suggestPaths: (input: string) => Promise<PathSuggestOutput>;
  selectWorktree: (worktreeId: number) => void;
  selectMissingProject: (projectId: number) => void;
  selectSurface: (worktreeId: number, surfaceId: string) => void;
  openDrawer: (commandId?: string) => void;
  closeDrawer: () => void;
  selectCommand: (commandId: string) => void;
}

let activeSelectionRequest = 0;

function findWorktree(projects: readonly Project[], worktreeId: number | null): Worktree | null {
  if (!worktreeId) {
    return null;
  }

  for (const project of projects) {
    const worktree = project.worktrees.find((candidate) => candidate.id === worktreeId);
    if (worktree) {
      return worktree;
    }
  }

  return null;
}

function findMissingProject(
  projects: readonly Project[],
  projectId: number | null,
): Project | null {
  if (!projectId) {
    return null;
  }
  return (
    projects.find((project) => project.id === projectId && project.status === 'missing') ?? null
  );
}

function mapWorktree(
  projects: readonly Project[],
  worktreeId: number,
  update: (worktree: Worktree) => Worktree,
): readonly Project[] {
  return projects.map((project) => ({
    ...project,
    worktrees: project.worktrees.map((worktree) =>
      worktree.id === worktreeId ? update(worktree) : worktree,
    ),
  }));
}

const accents = [
  'blue',
  'violet',
  'amber',
  'green',
  'cyan',
] as const satisfies readonly AccentColor[];

function stateFromSnapshot(snapshot: WorkspaceSnapshot) {
  const projects: readonly Project[] = snapshot.projects.map((project) => ({
    ...project,
    glyph: projectGlyph(project.name),
    accent: accents[(project.id - 1) % accents.length] ?? 'blue',
    worktrees: project.worktrees.map((worktree) => ({
      ...worktree,
      surfaces: worktree.surfaces,
      commands: worktree.commands,
    })),
  }));
  const firstMissing = projects.find((project) => project.status === 'missing');

  return {
    projects,
    activeWorktreeId: snapshot.activeContext.worktreeId,
    selectedProjectId: snapshot.activeContext.projectId ?? firstMissing?.id ?? null,
    error: null,
  };
}

function projectGlyph(name: string) {
  return (
    name
      .split(/[-_\s.]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? '')
      .join('') ||
    name.slice(0, 2).toUpperCase() ||
    'P'
  );
}

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => ({
  projects: [],
  activeWorktreeId: null,
  selectedProjectId: null,
  loading: false,
  error: null,
  drawer: { open: false, selectedCommandId: null },
  zen: false,

  setZen: (zen) => set({ zen }),
  toggleZen: () => set((state) => ({ zen: !state.zen })),

  loadWorkspace: () => {
    set({ loading: true, error: null });
    void Effect.runPromise(fetchWorkspace()).then(
      (snapshot) => set({ ...stateFromSnapshot(snapshot), loading: false }),
      (error: unknown) => set({ loading: false, error: formatRuntimeError(error) }),
    );
  },

  addProjectPath: async (path) => {
    set({ loading: true, error: null });
    await Effect.runPromise(addProject(path)).then(
      (snapshot) => set({ ...stateFromSnapshot(snapshot), loading: false }),
      (error: unknown) => {
        set({ loading: false, error: formatRuntimeError(error) });
        throw error;
      },
    );
  },

  suggestPaths: (input) => Effect.runPromise(suggestProjectPaths(input)),

  selectWorktree: (worktreeId) => {
    const requestId = ++activeSelectionRequest;
    const selectedWorktree = findWorktree(get().projects, worktreeId);
    const previous = {
      activeWorktreeId: get().activeWorktreeId,
      selectedProjectId: get().selectedProjectId,
    };
    set({
      activeWorktreeId: worktreeId,
      selectedProjectId: selectedWorktree?.projectId ?? get().selectedProjectId,
      error: null,
    });
    void Effect.runPromise(updateActiveContext(worktreeId)).then(
      (snapshot) => {
        if (requestId === activeSelectionRequest) {
          set(stateFromSnapshot(snapshot));
        }
      },
      (error: unknown) => {
        if (requestId === activeSelectionRequest) {
          set({ ...previous, error: formatRuntimeError(error) });
        }
      },
    );
  },

  selectMissingProject: (projectId) => {
    activeSelectionRequest += 1;
    set({
      selectedProjectId: projectId,
      activeWorktreeId: null,
      drawer: { open: false, selectedCommandId: null },
    });
  },

  selectSurface: (worktreeId, surfaceId) =>
    set((state) => ({
      projects: mapWorktree(state.projects, worktreeId, (worktree) => ({
        ...worktree,
        activeSurfaceId: surfaceId,
      })),
    })),

  openDrawer: (commandId) =>
    set((state) => ({
      drawer: {
        open: true,
        selectedCommandId: commandId ?? state.drawer.selectedCommandId,
      },
    })),

  closeDrawer: () => set((state) => ({ drawer: { ...state.drawer, open: false } })),

  selectCommand: (commandId) =>
    set((state) => ({ drawer: { ...state.drawer, selectedCommandId: commandId } })),
}));

export function useWorkspace() {
  const projects = useWorkspaceStore((state) => state.projects);
  const activeWorktreeId = useWorkspaceStore((state) => state.activeWorktreeId);
  const selectedProjectId = useWorkspaceStore((state) => state.selectedProjectId);
  const selectWorktree = useWorkspaceStore((state) => state.selectWorktree);
  const selectMissingProject = useWorkspaceStore((state) => state.selectMissingProject);
  const selectSurface = useWorkspaceStore((state) => state.selectSurface);
  const loading = useWorkspaceStore((state) => state.loading);
  const error = useWorkspaceStore((state) => state.error);

  const activeWorktree = findWorktree(projects, activeWorktreeId);
  const activeMissingProject = findMissingProject(projects, selectedProjectId);
  const activeSurface = activeWorktree ? findActiveSurface(activeWorktree) : null;

  return {
    projects,
    activeWorktreeId,
    selectedProjectId,
    activeWorktree,
    activeMissingProject,
    activeSurface,
    loading,
    error,
    selectWorktree,
    selectMissingProject,
    selectSurface,
  };
}

export function useActiveWorktree(): Worktree | null {
  const projects = useWorkspaceStore((state) => state.projects);
  const activeWorktreeId = useWorkspaceStore((state) => state.activeWorktreeId);
  return findWorktree(projects, activeWorktreeId);
}

export type { Surface };
