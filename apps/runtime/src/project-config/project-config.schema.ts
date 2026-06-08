import type { WorktreeSetupSummary } from '@isagi/contracts';

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

export function normalizeWorktreeHooksConfig(input: unknown): WorktreeHooksConfig | null {
  if (!isRecord(input)) {
    return null;
  }
  const worktrees = input.worktrees;
  if (!isRecord(worktrees)) {
    return null;
  }
  const hooks = worktrees.hooks;
  if (!isRecord(hooks)) {
    return null;
  }
  const postCreate = hooks.postCreate;
  if (postCreate === undefined) {
    return null;
  }
  if (!Array.isArray(postCreate)) {
    throw new Error('worktrees.hooks.postCreate must be a list.');
  }
  return { postCreate: postCreate.map(normalizePostCreateHook) };
}

export function summarizeWorktreeHooks(
  config: WorktreeHooksConfig,
): readonly WorktreeSetupSummary[] {
  return config.postCreate.map((hook, index) => {
    const oneBased = index + 1;
    switch (hook.type) {
      case 'copy':
        return {
          index: oneBased,
          type: hook.type,
          label: `copy ${hook.src} → ${hook.dest}`,
          detail: `include ${hook.include.join(', ')}${hook.exclude.length ? ` · exclude ${hook.exclude.join(', ')}` : ''}`,
        } satisfies WorktreeSetupSummary;
      case 'symlink':
        return {
          index: oneBased,
          type: hook.type,
          label: `symlink ${hook.src} → ${hook.dest}`,
        } satisfies WorktreeSetupSummary;
      case 'command':
        return {
          index: oneBased,
          type: hook.type,
          label: `run ${hook.run}`,
          detail: `cwd ${hook.cwd} · timeout ${hook.timeout} · inherits runtime environment`,
          envKeys: Object.keys(hook.env).sort(),
        } satisfies WorktreeSetupSummary;
    }
  });
}

function normalizePostCreateHook(input: unknown): WorktreePostCreateHook {
  if (!isRecord(input)) {
    throw new Error('Each postCreate hook must be an object.');
  }
  switch (input.type) {
    case 'copy':
      return {
        type: 'copy',
        src: requiredString(input.src, 'copy.src'),
        dest: requiredString(input.dest, 'copy.dest'),
        include: optionalStringArray(input.include, 'copy.include') ?? ['**/*'],
        exclude: optionalStringArray(input.exclude, 'copy.exclude') ?? [],
        overwrite: optionalBoolean(input.overwrite, 'copy.overwrite') ?? true,
      };
    case 'symlink':
      return {
        type: 'symlink',
        src: requiredString(input.src, 'symlink.src'),
        dest: requiredString(input.dest, 'symlink.dest'),
        overwrite: optionalBoolean(input.overwrite, 'symlink.overwrite') ?? true,
      };
    case 'command':
      return {
        type: 'command',
        run: requiredString(input.run, 'command.run'),
        cwd: optionalString(input.cwd, 'command.cwd') ?? '.',
        timeout: optionalString(input.timeout, 'command.timeout') ?? '10m',
        env: optionalStringRecord(input.env, 'command.env') ?? {},
      };
    default:
      throw new Error('Each postCreate hook needs type copy, symlink, or command.');
  }
}

function requiredString(value: unknown, field: string) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value;
}

function optionalString(value: unknown, field: string) {
  if (value === undefined) {
    return undefined;
  }
  return requiredString(value, field);
}

function optionalBoolean(value: unknown, field: string) {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw new Error(`${field} must be a boolean.`);
  }
  return value;
}

function optionalStringArray(value: unknown, field: string) {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry)) {
    throw new Error(`${field} must be a list of non-empty strings.`);
  }
  return value;
}

function optionalStringRecord(value: unknown, field: string) {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`${field} must be an object.`);
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      if (typeof entry !== 'string') {
        throw new Error(`${field}.${key} must be a string.`);
      }
      return [key, entry];
    }),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
