import { Schema } from 'effect';

const nonEmptyStringSchema = Schema.String.check(
  Schema.isMinLength(1, { expected: 'a non-empty string' }),
);
const nonBlankStringSchema = nonEmptyStringSchema.check(
  Schema.makeFilter((value: string) => value.trim().length > 0, {
    title: 'nonBlankString',
    expected: 'a string containing at least one non-whitespace character',
  }),
);

const hookPathDescription =
  'Relative path. Hook source paths are resolved against the project root; hook destination paths and command cwd values are resolved against the new worktree root. Absolute paths and paths that escape their root are rejected when the hook runs.';

const worktreeCommandPathDescription =
  'Relative path resolved against the worktree root. Absolute paths and paths that escape the worktree root are rejected when command config is used.';

const hookEnvSchema = Schema.Record(Schema.String, Schema.String).annotate({
  description:
    'Environment variables added to the command hook process. Values must be strings and are merged over the runtime environment.',
});

export const copyHookSchema = Schema.Struct({
  type: Schema.Literal('copy').annotate({
    description: 'Selects a copy hook for post-create worktree setup.',
  }),
  src: nonBlankStringSchema.annotate({
    description: `${hookPathDescription} For copy hooks, src is the source directory or file under the project root. A missing src fails the setup step.`,
  }),
  dest: nonBlankStringSchema.annotate({
    description: `${hookPathDescription} For copy hooks, dest is the target directory or file under the worktree root.`,
  }),
  include: Schema.optional(Schema.Array(nonBlankStringSchema)).annotate({
    description:
      'Glob patterns included from a directory copy.src. Defaults to ["**/*"]. Setting it when copy.src is a file fails the setup step. Empty or blank pattern strings are rejected.',
  }),
  exclude: Schema.optional(Schema.Array(nonBlankStringSchema)).annotate({
    description:
      'Glob patterns excluded after include matching for a directory copy.src. Defaults to an empty list. Setting it when copy.src is a file fails the setup step. Empty or blank pattern strings are rejected.',
  }),
  overwrite: Schema.optional(Schema.Boolean).annotate({
    description: 'Whether copied files replace existing worktree files. Defaults to true.',
  }),
}).annotate({
  description:
    'Copies files from the project root into each new worktree. Editing hook content changes the hook hash and can trigger a new trust prompt.',
});

export const symlinkHookSchema = Schema.Struct({
  type: Schema.Literal('symlink').annotate({
    description: 'Selects a symlink hook for post-create worktree setup.',
  }),
  src: nonBlankStringSchema.annotate({
    description: `${hookPathDescription} For symlink hooks, src is resolved under the project root.`,
  }),
  dest: nonBlankStringSchema.annotate({
    description: `${hookPathDescription} For symlink hooks, dest is created under the worktree root.`,
  }),
  overwrite: Schema.optional(Schema.Boolean).annotate({
    description: 'Whether an existing destination is replaced. Defaults to true.',
  }),
}).annotate({
  description:
    'Creates a relative symlink in each new worktree. Editing hook content changes the hook hash and can trigger a new trust prompt.',
});

export const commandHookSchema = Schema.Struct({
  type: Schema.Literal('command').annotate({
    description: 'Selects a shell command hook for post-create worktree setup.',
  }),
  run: nonBlankStringSchema.annotate({
    description: 'Shell command run after the worktree is created.',
  }),
  cwd: Schema.optional(nonBlankStringSchema).annotate({
    description: `${hookPathDescription} Defaults to ".".`,
  }),
  timeout: Schema.optional(nonBlankStringSchema).annotate({
    description:
      'Maximum run time before the hook is terminated. Use values like 500ms, 30s, 10m, or 1h. The grammar is validated when the hook runs. Defaults to 10m.',
  }),
  env: Schema.optional(hookEnvSchema).annotate({
    description:
      'Environment variables added to the command hook process. Values must be strings. Defaults to an empty object.',
  }),
}).annotate({
  description:
    'Runs a shell command in each new worktree. Editing hook content changes the hook hash and can trigger a new trust prompt.',
});

export const worktreePostCreateHookSchema = Schema.Union([
  copyHookSchema,
  symlinkHookSchema,
  commandHookSchema,
]).annotate({
  identifier: 'a hook object with type copy, symlink, or command',
  description:
    'One post-create hook. Supported hook types are copy, symlink, and command. Extra hook fields are ignored for behavior parity with existing config.',
});

export const worktreeHooksSchema = Schema.Struct({
  postCreate: Schema.Array(worktreePostCreateHookSchema).annotate({
    description:
      'Hooks run after creating a worktree. Project config is read per operation, so hook edits are picked up without restarting Isagi. Editing hook content changes the hook hash and can trigger a new trust prompt.',
  }),
}).annotate({
  description:
    'Worktree hook configuration from worktrees.hooks in the project root .isagi/config.yaml. Git projects only: hooks run in order after a checkout is created, once trusted.',
});

const commandEnvSchema = Schema.Record(Schema.String, Schema.String).annotate({
  description:
    'Environment variables added when Isagi launches the command. Values must be strings; empty keys are rejected when command config is used.',
});

const tcpPortSchema = Schema.Int.check(
  Schema.isBetween(
    { minimum: 1, maximum: 65_535 },
    { expected: 'a TCP port from 1 through 65535' },
  ),
).annotate({
  description: 'TCP port number from 1 through 65535 associated with this command.',
});

const envVarNameSchema = nonBlankStringSchema.check(
  Schema.makeFilter((value: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(value), {
    title: 'envVarName',
    expected:
      'a POSIX shell variable name: letters, digits, and underscores, not starting with a digit',
  }),
);

export const commandPortPathSchema = Schema.Struct({
  label: nonBlankStringSchema.annotate({
    description:
      "Short badge label for this URL, unique across all of the command's ports. Must not have leading or trailing whitespace.",
  }),
  path: Schema.String.check(
    Schema.makeFilter((value: string) => value.startsWith('/') && !/[\s?#]/.test(value), {
      title: 'httpUrlPath',
      expected: 'a URL path starting with "/" and containing no whitespace, query, or fragment',
    }),
  ).annotate({
    description:
      'URL path served on this port, starting with "/". "/" alone is the root. Resolved URLs are http://localhost:<port><path>, shown only when the client and runtime run on the same machine.',
  }),
}).annotate({
  description: 'One labelled URL path served by this HTTP port.',
});

export const commandPortSchema = Schema.Struct({
  port: Schema.optional(tcpPortSchema).annotate({
    description:
      'Fixed command port used exactly as declared. Declare either port or envVar, never both.',
  }),
  envVar: Schema.optional(envVarNameSchema).annotate({
    description:
      'Marks this command port as runtime-allocated. Isagi picks an inactive port at each launch, prefers the previous allocation without reserving it, and injects the value into the process environment under this name, overriding the same key from envFiles. It cannot collide with a key in env. Declare either port or envVar, never both.',
  }),
  paths: Schema.optional(Schema.Array(commandPortPathSchema)).annotate({
    description:
      'Labelled URL paths served on this port. Defaults to an empty list; a pathless port still resolves, and an allocated pathless port still injects its value, but neither produces URLs.',
  }),
}).annotate({
  description:
    'One port of this command: fixed ({ port }) or runtime-allocated ({ envVar }), with optional labelled HTTP paths.',
});

const lifecyclePostCreateSchema = Schema.Struct({
  start: Schema.optional(Schema.Boolean).annotate({
    description:
      'Start the command after Git checkout creation, once setup succeeds or is skipped; never on registration or recovery. Defaults to false.',
  }),
}).annotate({
  description: 'postCreate lifecycle action. Only the start field is supported.',
});

const lifecycleActivateSchema = Schema.Struct({
  start: Schema.optional(Schema.Boolean).annotate({
    description:
      'When activate.start is true, start the command on activation only if it has no prior outcome. This automation does not restart an exited, failed, explicitly stopped, or suspended command; suspension resumes separately when the user returns to the worktree. Defaults to false.',
  }),
}).annotate({
  description: 'activate lifecycle action. Only the start field is supported.',
});

const lifecycleDeactivateSchema = Schema.Struct({
  stop: Schema.optional(Schema.Boolean).annotate({
    description:
      'Stop the current command process when the worktree is deactivated. A command stopped this way is suspended: Isagi records resume intent and starts a new process incarnation when the user returns to the worktree, unless explicit Stop clears that intent. When Isagi starts, commands that were running are suspended; the active worktree resumes its own, and stop: false commands resume in every worktree. Defaults to true.',
  }),
}).annotate({
  description: 'deactivate lifecycle action. Only the stop field is supported.',
});

const lifecyclePreDeleteSchema = Schema.Struct({
  stop: Schema.optional(Schema.Boolean).annotate({
    description:
      'Stop the command before the worktree is deleted. Defaults to true; false does not keep the command running after project removal.',
  }),
}).annotate({
  description: 'preDelete lifecycle action. Only the stop field is supported.',
});

export const worktreeCommandLifecycleSchema = Schema.Struct({
  postCreate: Schema.optional(lifecyclePostCreateSchema).annotate({
    description: 'Lifecycle behavior after worktree creation. Defaults to { start: false }.',
  }),
  activate: Schema.optional(lifecycleActivateSchema).annotate({
    description: 'Lifecycle behavior when the worktree is activated. Defaults to { start: false }.',
  }),
  deactivate: Schema.optional(lifecycleDeactivateSchema).annotate({
    description: 'Lifecycle behavior when the worktree is deactivated. Defaults to { stop: true }.',
  }),
  preDelete: Schema.optional(lifecyclePreDeleteSchema).annotate({
    description: 'Lifecycle behavior before the worktree is deleted. Defaults to { stop: true }.',
  }),
}).annotate({
  description:
    'Command lifecycle defaults are postCreate.start=false, activate.start=false, deactivate.stop=true, and preDelete.stop=true. Unknown lifecycle events or action fields are rejected when command config is used.',
});

export const worktreeCommandSchema = Schema.Struct({
  name: nonBlankStringSchema.annotate({
    description:
      'Stable command name shown in Isagi. Must be non-empty, unique within the config, and must not have leading or trailing whitespace.',
  }),
  command: nonBlankStringSchema.annotate({
    description: 'Shell command line Isagi runs for this command.',
  }),
  cwd: Schema.optional(Schema.NullOr(nonBlankStringSchema)).annotate({
    description: `${worktreeCommandPathDescription} Null or omitted means the worktree root.`,
  }),
  env: Schema.optional(commandEnvSchema).annotate({
    description:
      'Environment variables added to the command process. The login-shell environment is the baseline, then envFiles in order, then env, so env wins. PORT, HOST and ISAGI_* are never inherited from the runtime but can be set here. Values must be strings; empty keys are rejected when command config is used.',
  }),
  envFiles: Schema.optional(Schema.Array(nonBlankStringSchema)).annotate({
    description: `${worktreeCommandPathDescription} Each file is read as dotenv-style environment input. Defaults to an empty list.`,
  }),
  ports: Schema.optional(Schema.Array(commandPortSchema)).annotate({
    description:
      'Ports this command uses. Fixed entries use their declared port, allocated entries receive a runtime-chosen port, and optional paths produce labelled HTTP URLs. Defaults to an empty list.',
  }),
  lifecycle: Schema.optional(worktreeCommandLifecycleSchema).annotate({
    description:
      'Optional lifecycle automation. Unknown command and lifecycle fields are rejected; this stricter behavior is intentionally preserved from the current command config parser.',
  }),
}).annotate({
  description:
    'One Isagi command entry from the commands list in the worktree .isagi/config.yaml. Project config is re-read per operation, so command edits are hot.',
});

export const worktreeCommandCatalogSchema = Schema.Struct({
  commands: Schema.Array(worktreeCommandSchema).annotate({
    description:
      'Commands available for a worktree. Missing commands means an empty catalog. Duplicate names are rejected when command config is used.',
  }),
}).annotate({
  description: 'Command catalog configuration from the worktree .isagi/config.yaml.',
});

export const projectConfigSchema = Schema.Struct({
  worktrees: Schema.optional(
    Schema.Struct({
      hooks: Schema.optional(worktreeHooksSchema).annotate({
        description: 'Worktree hook settings. Missing hooks means no setup hooks are configured.',
      }),
    }),
  ).annotate({
    description: 'Worktree-related project configuration.',
  }),
  commands: Schema.optional(Schema.Array(worktreeCommandSchema)).annotate({
    description:
      'Worktree command catalog. Missing commands means an empty catalog. Command entries reject unknown fields when command config is used.',
  }),
}).annotate({
  description:
    'Project-local Isagi config from .isagi/config.yaml, re-read per operation. worktrees.hooks is read from the project root copy; commands are read from each worktree copy.',
});

export type WorktreePostCreateHookInput = typeof worktreePostCreateHookSchema.Type;
export type WorktreeHooksInput = typeof worktreeHooksSchema.Type;
export type WorktreeCommandInput = typeof worktreeCommandSchema.Type;
export type WorktreeCommandCatalogInput = typeof worktreeCommandCatalogSchema.Type;

export type WorktreePostCreateHook = CopyHook | SymlinkHook | CommandHook;

export interface CopyHook {
  readonly type: 'copy';
  readonly src: string;
  readonly dest: string;
  /** Undefined when not configured; directory sources then include everything. */
  readonly include?: readonly string[];
  /** Undefined when not configured; directory sources then exclude nothing. */
  readonly exclude?: readonly string[];
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

export interface CommandPortPathConfig {
  readonly label: string;
  readonly path: string;
}

// The normalized port declaration carries an internal discriminant so every
// downstream switch is exhaustive. The YAML stays key-presence based: a `type`
// key is rejected like any other unknown field.
export type WorktreeCommandPortConfig =
  | {
      readonly kind: 'fixed';
      readonly port: number;
      readonly paths: readonly CommandPortPathConfig[];
    }
  | {
      readonly kind: 'allocated';
      readonly envVar: string;
      readonly paths: readonly CommandPortPathConfig[];
    };

export interface WorktreeCommandConfig {
  readonly name: string;
  readonly command: string;
  readonly cwd: string | null;
  readonly env: Readonly<Record<string, string>>;
  readonly envFiles: readonly string[];
  readonly ports: readonly WorktreeCommandPortConfig[];
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
