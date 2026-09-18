/**
 * Launch-surface value shapes. These are carried verbatim from contract version 1: the prompt
 * renderer, the command palette, the question forms, and the contract schemas all read them, and
 * the graph rewrite deliberately leaves them untouched.
 */

export const workflowInputKinds = ['text', 'select', 'multi-select', 'confirm'] as const;

export type WorkflowInputKind = (typeof workflowInputKinds)[number];

export type WorkflowAgentHarness = 'pi' | 'opencode' | 'claude' | 'codex';

export interface WorkflowSkillModifier {
  readonly kind: 'skill';
  readonly name: string;
}

export interface WorkflowCommandModifier {
  readonly kind: 'command';
  readonly name: string;
}

export type WorkflowPromptModifier = WorkflowSkillModifier | WorkflowCommandModifier;

export type WorkflowPromptModifiers =
  | readonly WorkflowSkillModifier[]
  | readonly [WorkflowCommandModifier];

export interface WorkflowPromptInput {
  readonly prompt?: string | undefined;
  readonly modifiers?: WorkflowPromptModifiers | undefined;
}

export interface WorkflowQuestionOption {
  readonly value: string;
  readonly label?: string | undefined;
  readonly hint?: string | undefined;
}

export type WorkflowQuestionSpec =
  | {
      readonly kind: 'text';
      readonly key: string;
      readonly label: string;
      readonly placeholder?: string | undefined;
      readonly default?: string | undefined;
    }
  | {
      readonly kind: 'select';
      readonly key: string;
      readonly label: string;
      readonly options: readonly WorkflowQuestionOption[];
      readonly default?: string | undefined;
    }
  | {
      readonly kind: 'multi-select';
      readonly key: string;
      readonly label: string;
      readonly options: readonly WorkflowQuestionOption[];
      readonly default?: readonly string[] | undefined;
    }
  | {
      readonly kind: 'confirm';
      readonly key: string;
      readonly label: string;
      readonly default?: boolean | undefined;
    };

export type WorkflowConversationRole = 'system' | 'user' | 'assistant';
export type WorkflowConversationPartState = 'streaming' | 'done';

export interface WorkflowConversationPart {
  readonly type: 'text';
  readonly text: string;
  readonly state?: WorkflowConversationPartState | undefined;
}

export interface WorkflowConversationMessage {
  readonly role: WorkflowConversationRole;
  readonly parts: readonly WorkflowConversationPart[];
}

export interface WorkflowUiFeedback {
  readonly kind?: 'info' | 'warning' | 'error' | undefined;
  readonly phase?: string | undefined;
  readonly message?: string | undefined;
}

export type WorkflowLogLevel = 'debug' | 'info' | 'warning' | 'error';

export interface WorkflowCommandManifest {
  readonly title: string;
  readonly description?: string | undefined;
  readonly inputs?: readonly WorkflowQuestionSpec[] | undefined;
}

export type WorkflowUserInputAnswers = Record<string, string | readonly string[] | boolean>;

/** Validated launch inputs. These become the root graph's parameters with no further mapping. */
export type WorkflowInputs = Record<string, unknown>;

/**
 * Where a run was launched from. Descriptive: it may reference a pane or agent session the person
 * has since closed, and it is never used to place work.
 */
export interface WorkflowOrigin {
  readonly worktreeId: number;
  readonly worktreePath: string;
  readonly surfaceId: number;
  readonly paneId?: number | null | undefined;
  readonly agentSessionId?: number | null | undefined;
}

/** Where a run's work is placed. Subgraphs inherit their parent frame's destination. */
export interface WorkflowDestination {
  readonly worktreeId: number;
  readonly worktreePath: string;
  readonly surfaceId: number;
}

/**
 * What the optional `environment` hook may read while choosing where a run is placed.
 *
 * Project-scoped: it lists only the launch project's worktrees and their surfaces. It reads rows as
 * they are recorded without reconciling them against Git or the filesystem, so a listed worktree may
 * already be gone by the time preparation runs. Listing is never a reservation — nothing here holds,
 * locks or claims a resource, and every choice is re-validated at launch and re-checked during
 * preparation. The context is closed once `environment()` returns; a call made after that rejects.
 */
export interface WorkflowEnvironmentContext {
  readonly origin: WorkflowOrigin;
  readonly project: { readonly id: number; readonly name: string; readonly kind: 'git' | 'folder' };
  listWorktrees(): Promise<readonly WorkflowWorktreeSummary[]>;
  listSurfaces(input: { readonly worktreeId: number }): Promise<readonly WorkflowSurfaceSummary[]>;
}

/** A worktree of the launch project, as recorded. `branch` and `head` are null for a folder project. */
export interface WorkflowWorktreeSummary {
  readonly id: number;
  readonly path: string;
  readonly branch: string | null;
  readonly head: string | null;
  readonly isRoot: boolean;
}

/** A surface on one worktree. Whether it is free to take work is decided at launch, not here. */
export interface WorkflowSurfaceSummary {
  readonly id: number;
  readonly worktreeId: number;
  readonly title: string;
}

/**
 * Which worktree the run executes in. `create` requires a `create` surface choice, and its `fromRef`
 * is resolved to a commit at launch — an unknown ref rejects the launch rather than failing later.
 */
export type WorkflowWorktreeChoice =
  | { readonly kind: 'current' }
  | { readonly kind: 'existing'; readonly worktreeId: number }
  | { readonly kind: 'create'; readonly branch: string; readonly fromRef: string };

/** Which surface the run attaches to. An `existing` surface already busy with a run is refused. */
export type WorkflowSurfaceChoice =
  | { readonly kind: 'current' }
  | { readonly kind: 'existing'; readonly surfaceId: number }
  | { readonly kind: 'create'; readonly title: string };

/**
 * A requested placement. It is a request, not an outcome: it is validated against live rows before
 * anything is allocated, and the effective destination is recorded only once preparation commits.
 */
export interface WorkflowPlacementRequest {
  readonly worktree: WorkflowWorktreeChoice;
  readonly surface: WorkflowSurfaceChoice;
}
