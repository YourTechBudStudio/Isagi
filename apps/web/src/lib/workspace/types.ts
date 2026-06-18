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
  readonly id: number;
  readonly kind: SurfaceKind;
  readonly title: string;
  readonly attention: AttentionState;
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
  readonly attention: AttentionState;
  readonly surfaces: readonly Surface[];
  readonly commands: readonly Command[];
};

/** `Omit` that distributes over a union so the discriminant is preserved. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * The UI-side project. Built by distributing over the contract's
 * `present | missing` union (and intersection distributes too), so `Project`
 * stays a genuine discriminated union on `status` — `MissingProject` can be
 * extracted from it and `status` narrows `missingReason` correctly.
 */
export type Project = DistributiveOmit<ContractProject, 'worktrees'> & {
  readonly glyph: string;
  readonly accent: AccentColor;
  readonly worktrees: readonly Worktree[];
};

/** A project the runtime can currently reach — the normal, worktree-bearing case. */
export type PresentProject = Extract<Project, { status: 'present' }>;

/** A project the runtime can't currently reach. `missingReason` is guaranteed. */
export type MissingProject = Extract<Project, { status: 'missing' }>;
