/**
 * Workspace domain types for the shell.
 *
 * Nomenclature (locked): a *worktree* is the user-facing continuity unit for a
 * checkout; an *Isagi project* groups worktrees; a *worktree environment* is
 * the hidden restorable state associated with one worktree; an *agent session*
 * is a harness running inside an agent surface; a *surface* is anything pulled
 * onto the canvas.
 *
 * These describe what the UI renders today from mock data. They will later be
 * fed by the runtime over the oRPC contract; keeping them here (and narrow)
 * lets the presentational shell evolve before the runtime slices land.
 */

/** Raw accent token names usable for project glyphs and decoration. */
export type AccentColor = 'blue' | 'violet' | 'amber' | 'green' | 'cyan' | 'red';

/**
 * Calm attention state for a worktree/agent/surface. Maps to the `attention-*`
 * design tokens (working → violet, waiting → cyan, idle → grey, error → red).
 */
export type AttentionState = 'working' | 'waiting' | 'idle' | 'error';

/** A single agent harness running inside an agent surface. */
export interface AgentSession {
  readonly id: string;
  /** Harness label, e.g. `codex`, `claude`, `pi`. */
  readonly harness: string;
  readonly attention: AttentionState;
  /** Mock terminal scrollback (plain lines for now; real PTY later). */
  readonly transcript: readonly string[];
}

/** A shell pane inside a terminal surface. */
export interface ShellPane {
  readonly id: string;
  readonly title: string;
  /** Mock scrollback (plain lines for now; real PTY later). */
  readonly lines: readonly string[];
}

export type SurfaceKind = 'agent' | 'terminal' | 'browser' | 'editor' | 'artifact';

/**
 * A surface is a switchable canvas under a worktree.
 *
 * `agent` and `terminal` are sibling **split PTY surfaces** — both lay panes out
 * in a split grid; agent panes are driven by agent sessions, terminal panes
 * by raw shells. (A worktree has at most one agent surface; it may have several
 * terminal surfaces.) The rest (browser, editor, artifact) are non-PTY surfaces
 * *sourced from the worktree*. All are tracked here as per-worktree view-state.
 */
export interface Surface {
  readonly id: string;
  readonly kind: SurfaceKind;
  /** Rail label, e.g. `Agents`, `Terminal`, `localhost:5173`, `code-server`. */
  readonly title: string;
  /** Present on the `agent` surface; each agent session renders as one pane. */
  readonly agentSessions?: readonly AgentSession[];
  /** Present on `terminal` surfaces; the shells split inside it. */
  readonly shells?: readonly ShellPane[];
  /** Source hint for non-agent surfaces (URL, path). */
  readonly source?: string;
  /** Surface-level attention dot for non-agent surfaces. */
  readonly attention?: AttentionState;
}

export type CommandStatus = 'running' | 'stopped' | 'exited';

/**
 * A project command run inside a worktree. Commands are worktree-scoped and
 * shown through the status strip + command drawer rather than as rail surfaces.
 * A running command may bind one or more ports.
 */
export interface Command {
  readonly id: string;
  /** The command line, e.g. `pnpm dev`. */
  readonly label: string;
  readonly status: CommandStatus;
  readonly attention: AttentionState;
  readonly ports: readonly number[];
  /** Retained log lines (kept even after exit/crash). */
  readonly log: readonly string[];
}

export interface Worktree {
  readonly id: string;
  /** Human-readable name of the unit of work. */
  readonly title: string;
  /** Worktree branch/address, e.g. `main` or `wt/surfaces`. */
  readonly branch: string;
  /** Aggregate attention shown on the rail row. */
  readonly attention: AttentionState;
  /** Backburnered: alive but quieter, dimmed in place. */
  readonly parked: boolean;
  /**
   * Surfaces the user is looking at in this worktree. Invariant: **at most one**
   * surface has kind `agent` (the home surface, listed first); it may hold
   * multiple agent sessions. Non-agent surfaces (browser/editor/artifact) may
   * repeat. A worktree may also have no surfaces yet.
   */
  readonly surfaces: readonly Surface[];
  /** Remembered per worktree; null when the worktree has no surfaces (Skip). */
  readonly activeSurfaceId: string | null;
  /** The worktree's commands, shown in the status strip + workbench drawer. */
  readonly commands: readonly Command[];
}

export interface Project {
  readonly id: string;
  readonly name: string;
  /** Single-letter badge shown in the rail group header. */
  readonly glyph: string;
  readonly accent: AccentColor;
  readonly worktrees: readonly Worktree[];
}
