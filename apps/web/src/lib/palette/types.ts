import type { IconType } from '../icon.js';
import type { Project, Surface, Worktree } from '../workspace/types.js';

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
  readonly activeSurface: Surface | null;
  readonly activePaneId: number | null;
}

export interface Option<Payload = unknown> {
  readonly value: string;
  readonly label?: string;
  readonly hint?: string;
  readonly isDefault?: boolean;
  /** A synthetic "create new" option (combo steps). */
  readonly create?: boolean;
  /** Command-specific metadata for dynamic wizard decisions. */
  readonly payload?: Payload;
}

export type ArgValues = Record<string, string>;
export type ArgPayloads = Record<string, unknown>;
export type MaybePromise<T> = T | Promise<T>;

export type CommandOutcomeTone = 'info' | 'success' | 'warning' | 'danger';

export interface CommandOutcomeDiagnostic {
  readonly label: string;
  readonly detail: string;
}

export interface CommandOutcomeAction {
  readonly value: 'close' | 'cancel' | (string & {});
  readonly label: string;
  readonly intent?: 'default' | 'primary' | 'danger' | 'cancel';
}

export interface CommandResultContent {
  readonly tone: CommandOutcomeTone;
  readonly title: string;
  readonly body?: string | undefined;
  readonly diagnostic?: CommandOutcomeDiagnostic | undefined;
  readonly actions?: readonly CommandOutcomeAction[] | undefined;
}

export interface CommandErrorContent {
  readonly tone?: CommandOutcomeTone | undefined;
  readonly title: string;
  readonly body?: string | undefined;
  readonly diagnostic?: CommandOutcomeDiagnostic | undefined;
  readonly actions?: readonly CommandOutcomeAction[] | undefined;
}

export type CommandOutcome =
  | {
      readonly kind: 'close';
    }
  | {
      readonly kind: 'result';
      readonly content: CommandResultContent;
    }
  | {
      readonly kind: 'error';
      readonly content: CommandErrorContent;
    };

export type CommandPreflightResult =
  | {
      readonly mode: 'run';
      readonly values?: ArgValues;
      readonly payloads?: ArgPayloads;
    }
  | {
      readonly mode: 'palette';
      readonly values?: ArgValues;
    }
  | {
      readonly mode: 'unavailable';
    };

export interface ReviewChoice<Payload = unknown> {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
  /**
   * Visual + semantic weight of the choice. `danger` is the destructive accept
   * (red, reserved per the design system); `cancel` is the quiet back-out. The
   * palette wizard owns what each value does — `intent` only drives presentation.
   */
  readonly intent?: 'default' | 'danger' | 'cancel';
  readonly payload?: Payload;
}

export interface ReviewContent<Payload = unknown> {
  readonly title: string;
  readonly body: string;
  readonly items: readonly {
    readonly label: string;
    readonly detail?: string | undefined;
    readonly envKeys?: readonly string[] | undefined;
  }[];
  readonly choices: readonly ReviewChoice<Payload>[];
}

export type ArgSpec =
  | {
      readonly kind: 'select';
      readonly key: string;
      readonly label: string;
      readonly options: (ctx: PaletteContext, values: ArgValues) => MaybePromise<readonly Option[]>;
      /** Empty-query selection behavior. Defaults to selecting the first/default option. */
      readonly defaultSelection?: 'first' | 'none';
      readonly emptyHint?: string;
      readonly finishOnAccept?: (
        value: string,
        payload: unknown,
        ctx: PaletteContext,
        values: ArgValues,
      ) => boolean;
      /**
       * Skip this step entirely when the prior steps make it irrelevant (e.g. an
       * existing branch needs no "create from" base). Evaluated synchronously
       * from the values/payloads gathered so far.
       */
      readonly skip?: (ctx: PaletteContext, values: ArgValues, payloads: ArgPayloads) => boolean;
    }
  | {
      readonly kind: 'combo';
      readonly key: string;
      readonly label: string;
      readonly prefix?: string;
      readonly options: (ctx: PaletteContext, values: ArgValues) => MaybePromise<readonly Option[]>;
      /** Empty-query selection behavior. Defaults to selecting the first/default option. */
      readonly defaultSelection?: 'first' | 'none';
      readonly emptyHint?: string;
      readonly createHint?: string;
      readonly finishOnAccept?: (
        value: string,
        payload: unknown,
        ctx: PaletteContext,
        values: ArgValues,
      ) => boolean;
    }
  | {
      readonly kind: 'review';
      readonly key: string;
      readonly label: string;
      /**
       * Loads the review screen. Returning `null` means there is nothing to
       * review — the wizard skips the screen and finishes immediately (e.g. an
       * open-worktree with no setup hooks to approve).
       */
      readonly load: (ctx: PaletteContext, values: ArgValues) => MaybePromise<ReviewContent | null>;
    }
  | {
      readonly kind: 'text';
      readonly key: string;
      readonly label: string;
      readonly placeholder?: string;
      readonly default?: (ctx: PaletteContext, values: ArgValues) => string;
    }
  | {
      readonly kind: 'path';
      readonly key: string;
      readonly label: string;
      readonly placeholder?: string;
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
  /**
   * Applies only when a command is invoked from an external workbench affordance
   * (rail row, pane button, shortcut), not when the user runs it from palette
   * search. `direct` preserves the current behavior: external dispatch may
   * preflight/run directly and use caller or fallback error handling. `palette`
   * routes external dispatch through the palette so command-owned reviews,
   * localized errors, results, and diagnostics stay at the action site.
   */
  readonly feedbackSurface?: 'direct' | 'palette';
  readonly available?: (ctx: PaletteContext) => boolean;
  readonly preflight?: (
    ctx: PaletteContext,
    values: ArgValues,
  ) => MaybePromise<CommandPreflightResult>;
  readonly args?: readonly ArgSpec[];
  readonly run: (
    values: ArgValues,
    ctx: PaletteContext,
    payloads?: ArgPayloads,
  ) => CommandOutcome | void | Promise<CommandOutcome | void>;
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
  readonly run: () => MaybePromise<CommandOutcome | void>;
}
