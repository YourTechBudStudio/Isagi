import { Schema } from 'effect';

const nonEmptyStringSchema = Schema.String.pipe(Schema.minLength(1));
const nonBlankStringSchema = nonEmptyStringSchema.pipe(
  Schema.filter((value) => value.trim().length > 0, {
    title: 'nonBlankString',
    description: 'a string containing at least one non-whitespace character',
  }),
);

const hookPathDescription =
  'Relative path. Hook source paths are resolved against the project root; hook destination paths and command cwd values are resolved against the new worktree root. Absolute paths and paths that escape their root are rejected when the hook runs.';

const worktreeCommandPathDescription =
  'Relative path resolved against the worktree root. Absolute paths and paths that escape the worktree root are rejected when command config is used.';

const hookEnvSchema = Schema.Record({
  key: Schema.String,
  value: Schema.String,
}).annotations({
  description:
    'Environment variables added to the command hook process. Values must be strings and are merged over the runtime environment.',
});

export const copyHookSchema = Schema.Struct({
  type: Schema.Literal('copy').annotations({
    description: 'Selects a copy hook for post-create worktree setup.',
  }),
  src: nonBlankStringSchema.annotations({
    description: `${hookPathDescription} For copy hooks, src is the source directory or file under the project root.`,
  }),
  dest: nonBlankStringSchema.annotations({
    description: `${hookPathDescription} For copy hooks, dest is the target directory or file under the worktree root.`,
  }),
  include: Schema.optional(Schema.Array(nonBlankStringSchema)).annotations({
    description:
      'Glob patterns included from copy.src. Defaults to ["**/*"]. Empty or blank pattern strings are rejected.',
  }),
  exclude: Schema.optional(Schema.Array(nonBlankStringSchema)).annotations({
    description:
      'Glob patterns excluded after include matching. Defaults to an empty list. Empty or blank pattern strings are rejected.',
  }),
  overwrite: Schema.optional(Schema.Boolean).annotations({
    description: 'Whether copied files replace existing worktree files. Defaults to true.',
  }),
}).annotations({
  description:
    'Copies files from the project root into each new worktree. Editing hook content changes the hook hash and can trigger a new trust prompt.',
});

export const symlinkHookSchema = Schema.Struct({
  type: Schema.Literal('symlink').annotations({
    description: 'Selects a symlink hook for post-create worktree setup.',
  }),
  src: nonBlankStringSchema.annotations({
    description: `${hookPathDescription} For symlink hooks, src is resolved under the project root.`,
  }),
  dest: nonBlankStringSchema.annotations({
    description: `${hookPathDescription} For symlink hooks, dest is created under the worktree root.`,
  }),
  overwrite: Schema.optional(Schema.Boolean).annotations({
    description: 'Whether an existing destination is replaced. Defaults to true.',
  }),
}).annotations({
  description:
    'Creates a relative symlink in each new worktree. Editing hook content changes the hook hash and can trigger a new trust prompt.',
});

export const commandHookSchema = Schema.Struct({
  type: Schema.Literal('command').annotations({
    description: 'Selects a shell command hook for post-create worktree setup.',
  }),
  run: nonBlankStringSchema.annotations({
    description: 'Shell command run after the worktree is created.',
  }),
  cwd: Schema.optional(nonBlankStringSchema).annotations({
    description: `${hookPathDescription} Defaults to ".".`,
  }),
  timeout: Schema.optional(nonBlankStringSchema).annotations({
    description:
      'Maximum run time before the hook is terminated. Use values like 500ms, 30s, 10m, or 1h. The grammar is validated when the hook runs. Defaults to 10m.',
  }),
  env: Schema.optional(hookEnvSchema).annotations({
    description:
      'Environment variables added to the command hook process. Values must be strings. Defaults to an empty object.',
  }),
}).annotations({
  description:
    'Runs a shell command in each new worktree. Editing hook content changes the hook hash and can trigger a new trust prompt.',
});

export const worktreePostCreateHookSchema = Schema.Union(
  copyHookSchema,
  symlinkHookSchema,
  commandHookSchema,
).annotations({
  description:
    'One post-create hook. Supported hook types are copy, symlink, and command. Extra hook fields are ignored for behavior parity with existing config.',
});

export const worktreeHooksSchema = Schema.Struct({
  postCreate: Schema.Array(worktreePostCreateHookSchema).annotations({
    description:
      'Hooks run after creating a worktree. Project config is read per operation, so hook edits are picked up without restarting Isagi. Editing hook content changes the hook hash and can trigger a new trust prompt.',
  }),
}).annotations({
  description: 'Worktree hook configuration from worktrees.hooks in .isagi/config.yaml.',
});

const commandEnvSchema = Schema.Record({
  key: Schema.String,
  value: Schema.String,
}).annotations({
  description:
    'Environment variables added when Isagi launches the command. Values must be strings; empty keys are rejected when command config is used.',
});

const tcpPortSchema = Schema.Number.pipe(Schema.int(), Schema.between(1, 65_535)).annotations({
  description: 'TCP port number from 1 through 65535 associated with this command.',
});

const lifecyclePostCreateSchema = Schema.Struct({
  start: Schema.optional(Schema.Boolean).annotations({
    description: 'Start the command after worktree creation. Defaults to false.',
  }),
}).annotations({
  description: 'postCreate lifecycle action. Only the start field is supported.',
});

const lifecycleActivateSchema = Schema.Struct({
  start: Schema.optional(Schema.Boolean).annotations({
    description: 'Start the command when the worktree is activated. Defaults to false.',
  }),
}).annotations({
  description: 'activate lifecycle action. Only the start field is supported.',
});

const lifecycleDeactivateSchema = Schema.Struct({
  stop: Schema.optional(Schema.Boolean).annotations({
    description: 'Stop the command when the worktree is deactivated. Defaults to true.',
  }),
}).annotations({
  description: 'deactivate lifecycle action. Only the stop field is supported.',
});

const lifecyclePreDeleteSchema = Schema.Struct({
  stop: Schema.optional(Schema.Boolean).annotations({
    description: 'Stop the command before the worktree is deleted. Defaults to true.',
  }),
}).annotations({
  description: 'preDelete lifecycle action. Only the stop field is supported.',
});

export const worktreeCommandLifecycleSchema = Schema.Struct({
  postCreate: Schema.optional(lifecyclePostCreateSchema).annotations({
    description: 'Lifecycle behavior after worktree creation. Defaults to { start: false }.',
  }),
  activate: Schema.optional(lifecycleActivateSchema).annotations({
    description: 'Lifecycle behavior when the worktree is activated. Defaults to { start: false }.',
  }),
  deactivate: Schema.optional(lifecycleDeactivateSchema).annotations({
    description: 'Lifecycle behavior when the worktree is deactivated. Defaults to { stop: true }.',
  }),
  preDelete: Schema.optional(lifecyclePreDeleteSchema).annotations({
    description: 'Lifecycle behavior before the worktree is deleted. Defaults to { stop: true }.',
  }),
}).annotations({
  description:
    'Command lifecycle defaults are postCreate.start=false, activate.start=false, deactivate.stop=true, and preDelete.stop=true. Unknown lifecycle events or action fields are rejected when command config is used.',
});

export const worktreeCommandSchema = Schema.Struct({
  name: nonBlankStringSchema.annotations({
    description:
      'Stable command name shown in Isagi. Must be non-empty, unique within the config, and must not have leading or trailing whitespace.',
  }),
  command: nonBlankStringSchema.annotations({
    description: 'Shell command line Isagi runs for this command.',
  }),
  cwd: Schema.optional(Schema.NullOr(nonBlankStringSchema)).annotations({
    description: `${worktreeCommandPathDescription} Null or omitted means the worktree root.`,
  }),
  env: Schema.optional(commandEnvSchema).annotations({
    description:
      'Environment variables added to the command process. Values must be strings; empty keys are rejected when command config is used.',
  }),
  envFiles: Schema.optional(Schema.Array(nonBlankStringSchema)).annotations({
    description: `${worktreeCommandPathDescription} Each file is read as dotenv-style environment input. Defaults to an empty list.`,
  }),
  ports: Schema.optional(Schema.Array(tcpPortSchema)).annotations({
    description:
      'TCP ports associated with this command for UI/status metadata. Defaults to an empty list.',
  }),
  lifecycle: Schema.optional(worktreeCommandLifecycleSchema).annotations({
    description:
      'Optional lifecycle automation. Unknown command and lifecycle fields are rejected; this stricter behavior is intentionally preserved from the current command config parser.',
  }),
}).annotations({
  description:
    'One Isagi command entry from the commands list in .isagi/config.yaml. Project config is re-read per operation, so command edits are hot.',
});

export const worktreeCommandCatalogSchema = Schema.Struct({
  commands: Schema.Array(worktreeCommandSchema).annotations({
    description:
      'Commands available for a worktree. Missing commands means an empty catalog. Duplicate names are rejected when command config is used.',
  }),
}).annotations({
  description: 'Command catalog configuration from .isagi/config.yaml.',
});

export const projectConfigSchema = Schema.Struct({
  worktrees: Schema.optional(
    Schema.Struct({
      hooks: Schema.optional(worktreeHooksSchema).annotations({
        description: 'Worktree hook settings. Missing hooks means no setup hooks are configured.',
      }),
    }),
  ).annotations({
    description: 'Worktree-related project configuration.',
  }),
  commands: Schema.optional(Schema.Array(worktreeCommandSchema)).annotations({
    description:
      'Worktree command catalog. Missing commands means an empty catalog. Command entries reject unknown fields when command config is used.',
  }),
}).annotations({
  description:
    'Project-local Isagi config from .isagi/config.yaml. The file is read relative to the worktree and is re-read per operation.',
});

export type WorktreePostCreateHookInput = Schema.Schema.Type<typeof worktreePostCreateHookSchema>;
export type WorktreeHooksInput = Schema.Schema.Type<typeof worktreeHooksSchema>;
export type WorktreeCommandInput = Schema.Schema.Type<typeof worktreeCommandSchema>;
export type WorktreeCommandCatalogInput = Schema.Schema.Type<typeof worktreeCommandCatalogSchema>;

export type WorktreePostCreateHook = CopyHook | SymlinkHook | CommandHook;

export interface CopyHook {
  readonly type: 'copy';
  readonly src: string;
  readonly dest: string;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly overwrite: boolean;
}

export interface SymlinkHook {
  readonly type: 'symlink';
  readonly src: string;
  readonly dest: string;
  readonly overwrite: boolean;
}

export interface CommandHook {
  readonly type: 'command';
  readonly run: string;
  readonly cwd: string;
  readonly timeout: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface WorktreeHooksConfig {
  readonly postCreate: readonly WorktreePostCreateHook[];
}

export interface WorktreeCommandCatalogConfig {
  readonly commands: readonly WorktreeCommandConfig[];
}

export interface WorktreeCommandConfig {
  readonly name: string;
  readonly command: string;
  readonly cwd: string | null;
  readonly env: Readonly<Record<string, string>>;
  readonly envFiles: readonly string[];
  readonly ports: readonly number[];
  readonly lifecycle: WorktreeCommandLifecycleConfig;
}

export interface WorktreeCommandLifecycleConfig {
  readonly postCreate: { readonly start: boolean };
  readonly activate: { readonly start: boolean };
  readonly deactivate: { readonly stop: boolean };
  readonly preDelete: { readonly stop: boolean };
}

export const defaultCommandLifecycle = {
  postCreate: { start: false },
  activate: { start: false },
  deactivate: { stop: true },
  preDelete: { stop: true },
} as const satisfies WorktreeCommandLifecycleConfig;
