import { create } from 'zustand';

import { MOCK_PROJECTS } from './mock-data.js';
import { findActiveSurface } from './selectors.js';
import type { AgentSession, Project, Worktree, ShellPane, Surface } from './types.js';

interface DrawerState {
  readonly open: boolean;
  /** The command whose logs are shown; the drawer is commands-only. */
  readonly selectedCommandId: string | null;
}

interface WorkspaceStore {
  projects: readonly Project[];
  activeWorktreeId: string | null;
  drawer: DrawerState;
  /** Zen / focus mode: hide all chrome, the active surface fills the window. */
  zen: boolean;
  setZen: (zen: boolean) => void;
  toggleZen: () => void;

  selectWorktree: (worktreeId: string) => void;
  selectSurface: (worktreeId: string, surfaceId: string) => void;
  /** Mock run/stop toggle for a worktree command. */
  toggleCommand: (worktreeId: string, commandId: string) => void;
  /** Mock restart for a worktree command. */
  restartCommand: (worktreeId: string, commandId: string) => void;

  /** Open the commands drawer, optionally focused on a command. */
  openDrawer: (commandId?: string) => void;
  closeDrawer: () => void;
  selectCommand: (commandId: string) => void;

  /** Create a new worktree (mock) and make it active. */
  createWorktree: (projectId: string, branchName: string, harness: string) => void;

  // Action-bar verbs (mock creation flows).
  /** Add an agent session to the worktree's agent surface, creating it if absent. */
  addAgentSession: (worktreeId: string) => void;
  /** Spawn a review agent session into the agent surface. */
  aiReview: (worktreeId: string) => void;
  /** Add a new terminal surface (one shell) and focus it. */
  addTerminalSurface: (worktreeId: string) => void;
  /** Open (or focus an existing) code-server editor surface. */
  openCodeServer: (worktreeId: string) => void;
}

function firstWorktreeId(projects: readonly Project[]): string | null {
  for (const project of projects) {
    const worktree = project.worktrees.find(
      (candidate) => !candidate.parked && candidate.attention !== 'idle',
    );
    if (worktree) {
      return worktree.id;
    }
  }

  for (const project of projects) {
    const worktree = project.worktrees.find((candidate) => !candidate.parked);
    if (worktree) {
      return worktree.id;
    }
  }

  return projects[0]?.worktrees[0]?.id ?? null;
}

function findWorktree(projects: readonly Project[], worktreeId: string | null): Worktree | null {
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

function mapWorktree(
  projects: readonly Project[],
  worktreeId: string,
  update: (worktree: Worktree) => Worktree,
): readonly Project[] {
  return projects.map((project) => ({
    ...project,
    worktrees: project.worktrees.map((worktree) =>
      worktree.id === worktreeId ? update(worktree) : worktree,
    ),
  }));
}

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

function makeAgentSession(label: string, transcript: readonly string[]): AgentSession {
  return { id: nextId('agent-session'), harness: label, attention: 'working', transcript };
}

/** Append an agent session to the agent surface, creating the agent surface if absent. */
function withNewAgentSession(worktree: Worktree, agentSession: AgentSession): Worktree {
  const agent = worktree.surfaces.find((surface) => surface.kind === 'agent');
  if (agent) {
    return {
      ...worktree,
      activeSurfaceId: agent.id,
      surfaces: worktree.surfaces.map((surface) =>
        surface.id === agent.id
          ? { ...surface, agentSessions: [...(surface.agentSessions ?? []), agentSession] }
          : surface,
      ),
    };
  }

  const newAgent: Surface = {
    id: nextId('agent'),
    kind: 'agent',
    title: 'Agents',
    agentSessions: [agentSession],
  };
  return { ...worktree, activeSurfaceId: newAgent.id, surfaces: [newAgent, ...worktree.surfaces] };
}

function withNewTerminal(worktree: Worktree): Worktree {
  const count = worktree.surfaces.filter((surface) => surface.kind === 'terminal').length;
  const shell: ShellPane = {
    id: nextId('shell'),
    title: 'zsh',
    lines: [`~/isagi/${worktree.branch} ❯`],
  };
  const surface: Surface = {
    id: nextId('terminal'),
    kind: 'terminal',
    title: count === 0 ? 'Terminal' : `Terminal ${count + 1}`,
    shells: [shell],
  };
  return { ...worktree, activeSurfaceId: surface.id, surfaces: [...worktree.surfaces, surface] };
}

const HARNESS_LABELS: Record<string, string> = {
  pi: 'pi',
  claude: 'claude',
  codex: 'codex',
  opencode: 'opencode',
};

function normalizeWorktreeBranch(branchName: string): string {
  const name = branchName.trim() || 'main';
  return name.startsWith('wt/') || name === 'main' ? name : `wt/${name}`;
}

function newWorktree(branchName: string, harness: string): Worktree {
  const branch = normalizeWorktreeBranch(branchName);
  const name = branch.replace(/^wt\//, '');
  const title = name.charAt(0).toUpperCase() + name.slice(1);
  const surfaces: readonly Surface[] =
    harness === 'skip'
      ? []
      : [
          {
            id: nextId('agent'),
            kind: 'agent',
            title: 'Agents',
            agentSessions: [
              makeAgentSession(HARNESS_LABELS[harness] ?? harness, [
                `# ${HARNESS_LABELS[harness] ?? harness} — ready`,
                '❯',
              ]),
            ],
          },
        ];
  return {
    id: nextId('worktree'),
    title,
    branch,
    attention: harness === 'skip' ? 'idle' : 'working',
    parked: false,
    surfaces,
    activeSurfaceId: surfaces[0]?.id ?? null,
    commands: [],
  };
}

function withCodeServer(worktree: Worktree): Worktree {
  const existing = worktree.surfaces.find((surface) => surface.kind === 'editor');
  if (existing) {
    return { ...worktree, activeSurfaceId: existing.id };
  }

  const surface: Surface = {
    id: nextId('editor'),
    kind: 'editor',
    title: 'code-server',
    source: `code-server · ${worktree.branch}`,
    attention: 'idle',
  };
  return { ...worktree, activeSurfaceId: surface.id, surfaces: [...worktree.surfaces, surface] };
}

export const useWorkspaceStore = create<WorkspaceStore>((set) => ({
  projects: MOCK_PROJECTS,
  activeWorktreeId: firstWorktreeId(MOCK_PROJECTS),
  drawer: { open: false, selectedCommandId: null },
  zen: false,

  setZen: (zen) => set({ zen }),
  toggleZen: () => set((state) => ({ zen: !state.zen })),

  selectWorktree: (worktreeId) => set({ activeWorktreeId: worktreeId }),

  selectSurface: (worktreeId, surfaceId) =>
    set((state) => ({
      projects: mapWorktree(state.projects, worktreeId, (worktree) => ({
        ...worktree,
        activeSurfaceId: surfaceId,
      })),
    })),

  toggleCommand: (worktreeId, commandId) =>
    set((state) => ({
      projects: mapWorktree(state.projects, worktreeId, (worktree) => ({
        ...worktree,
        commands: worktree.commands.map((command) => {
          if (command.id !== commandId) {
            return command;
          }

          const running = command.status === 'running';
          return {
            ...command,
            status: running ? 'stopped' : 'running',
            attention: running ? 'idle' : 'working',
          };
        }),
      })),
    })),

  restartCommand: (worktreeId, commandId) =>
    set((state) => ({
      projects: mapWorktree(state.projects, worktreeId, (worktree) => ({
        ...worktree,
        commands: worktree.commands.map((command) =>
          command.id === commandId
            ? {
                ...command,
                status: 'running',
                attention: 'working',
                log: [...command.log, '$ restart', 'restarting…'],
              }
            : command,
        ),
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

  createWorktree: (projectId, branchName, harness) =>
    set((state) => {
      const branch = normalizeWorktreeBranch(branchName);
      const existingProject = state.projects.find((project) => project.id === projectId);
      const existingWorktree = existingProject?.worktrees.find(
        (worktree) => worktree.branch === branch,
      );
      if (existingWorktree) {
        return { activeWorktreeId: existingWorktree.id };
      }

      const worktree = newWorktree(branchName, harness);
      const projects =
        projectId === '__new'
          ? [
              ...state.projects,
              {
                id: nextId('project'),
                name: 'new-project',
                glyph: 'N',
                accent: 'green' as const,
                worktrees: [worktree],
              },
            ]
          : state.projects.map((project) =>
              project.id === projectId
                ? { ...project, worktrees: [...project.worktrees, worktree] }
                : project,
            );
      return { projects, activeWorktreeId: worktree.id };
    }),

  addAgentSession: (worktreeId) =>
    set((state) => ({
      projects: mapWorktree(state.projects, worktreeId, (worktree) =>
        withNewAgentSession(
          worktree,
          makeAgentSession('codex', ['# codex — fresh agent session', '❯']),
        ),
      ),
    })),

  aiReview: (worktreeId) =>
    set((state) => ({
      projects: mapWorktree(state.projects, worktreeId, (worktree) =>
        withNewAgentSession(
          worktree,
          makeAgentSession('codex · review', [
            '# codex — reviewing the working tree',
            '● read  the diff',
            '▌ looks solid; one nit in restore.ts',
            '❯',
          ]),
        ),
      ),
    })),

  addTerminalSurface: (worktreeId) =>
    set((state) => ({
      projects: mapWorktree(state.projects, worktreeId, withNewTerminal),
    })),

  openCodeServer: (worktreeId) =>
    set((state) => ({
      projects: mapWorktree(state.projects, worktreeId, withCodeServer),
    })),
}));

/** Convenience hook for navigation consumers (rail + canvas). */
export function useWorkspace() {
  const projects = useWorkspaceStore((state) => state.projects);
  const activeWorktreeId = useWorkspaceStore((state) => state.activeWorktreeId);
  const selectWorktree = useWorkspaceStore((state) => state.selectWorktree);
  const selectSurface = useWorkspaceStore((state) => state.selectSurface);

  const activeWorktree = findWorktree(projects, activeWorktreeId);
  const activeSurface = activeWorktree ? findActiveSurface(activeWorktree) : null;

  return {
    projects,
    activeWorktreeId,
    activeWorktree,
    activeSurface,
    selectWorktree,
    selectSurface,
  };
}

/** The active worktree, or null. */
export function useActiveWorktree(): Worktree | null {
  const projects = useWorkspaceStore((state) => state.projects);
  const activeWorktreeId = useWorkspaceStore((state) => state.activeWorktreeId);
  return findWorktree(projects, activeWorktreeId);
}

export type { Surface };
