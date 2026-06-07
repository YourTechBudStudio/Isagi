import type {
  AttentionState,
  Project as ContractProject,
  Worktree as ContractWorktree,
} from '@isagi/contracts';

export type { AttentionState };

export type AccentColor = 'blue' | 'violet' | 'amber' | 'green' | 'cyan' | 'red';

export type WorkspaceSelection =
  | { readonly kind: 'worktree'; readonly projectId: number; readonly worktreeId: number }
  | { readonly kind: 'missingProject'; readonly projectId: number }
  | { readonly kind: 'empty' };

export type SurfaceKind = 'agent' | 'terminal' | 'browser' | 'editor' | 'artifact';

export interface AgentSession {
  readonly id: string;
  readonly harness: string;
  readonly attention: AttentionState;
  readonly transcript: readonly string[];
}

export interface ShellPane {
  readonly id: string;
  readonly title: string;
  readonly lines: readonly string[];
}

export interface Surface {
  readonly id: string;
  readonly kind: SurfaceKind;
  readonly title: string;
  readonly attention?: AttentionState | undefined;
  readonly source?: string | undefined;
  readonly agentSessions?: readonly AgentSession[] | undefined;
  readonly shells?: readonly ShellPane[] | undefined;
}

export type CommandStatus = 'running' | 'stopped' | 'exited';

export interface Command {
  readonly id: string;
  readonly label: string;
  readonly status: CommandStatus;
  readonly attention: AttentionState;
  readonly ports: readonly number[];
  readonly log: readonly string[];
}

export type Worktree = Omit<ContractWorktree, 'surfaces' | 'commands'> & {
  readonly surfaces: readonly Surface[];
  readonly commands: readonly Command[];
};

export type Project = Omit<ContractProject, 'worktrees'> & {
  readonly glyph: string;
  readonly accent: AccentColor;
  readonly worktrees: readonly Worktree[];
};
