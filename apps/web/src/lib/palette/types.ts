import type { IconType } from '../icon.js';
import type { Project, Worktree } from '../workspace/types.js';

/**
 * The four palette groups. **Only `global` is config-driven** (the extensible
 * command registry); the other three are first-class internal features assembled
 * from workspace state.
 */
export type PaletteGroup = 'global' | 'worktree-actions' | 'worktree-surfaces' | 'switch-worktree';

/**
 * Snapshot of the current workspace context, derived from the Zustand store.
 * Arg `options`/`default` functions read this so global commands get
 * worktree-optimized defaults (e.g. default project = the active worktree's).
 */
export interface PaletteContext {
  readonly projects: readonly Project[];
  readonly activeWorktree: Worktree | null;
  readonly activeProject: Project | null;
}

export interface Option {
  readonly value: string;
  readonly label?: string;
  readonly hint?: string;
  readonly isDefault?: boolean;
  /** A synthetic "create new" option (combo steps). */
  readonly create?: boolean;
}

export type ArgValues = Record<string, string>;

export type ArgSpec =
  | {
      readonly kind: 'select';
      readonly key: string;
      readonly label: string;
      readonly options: (ctx: PaletteContext, values: ArgValues) => readonly Option[];
    }
  | {
      readonly kind: 'combo';
      readonly key: string;
      readonly label: string;
      readonly prefix?: string;
      readonly options: (ctx: PaletteContext, values: ArgValues) => readonly Option[];
    }
  | {
      readonly kind: 'text';
      readonly key: string;
      readonly label: string;
      readonly placeholder?: string;
      readonly default?: (ctx: PaletteContext, values: ArgValues) => string;
    };

/**
 * A config-driven global command. Self-contained and append-only so adding one
 * never edits a shared list (merge-conflict-friendly). `args` empty/absent = a
 * zero-arg command; otherwise the generic wizard runner drives the steps.
 */
export interface PaletteCommand {
  readonly id: string;
  readonly label: string;
  readonly icon: IconType;
  readonly group: PaletteGroup;
  readonly available?: (ctx: PaletteContext) => boolean;
  readonly args?: readonly ArgSpec[];
  readonly run: (values: ArgValues, ctx: PaletteContext) => void;
}

/** A resolved, runnable item shown in the palette list. */
export interface PaletteEntry {
  readonly id: string;
  readonly label: string;
  readonly icon: IconType;
  readonly group: PaletteGroup;
  readonly sub?: string;
  readonly accent?: boolean;
  /** Global commands with args open the wizard instead of running immediately. */
  readonly command?: PaletteCommand;
  readonly run: () => void;
}
