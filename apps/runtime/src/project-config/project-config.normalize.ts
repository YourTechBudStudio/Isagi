import { isAbsolute, relative, resolve, sep } from 'node:path';

import { Either, Schema } from 'effect';

import {
  commandHookSchema,
  copyHookSchema,
  defaultCommandLifecycle,
  symlinkHookSchema,
  worktreeCommandLifecycleSchema,
  worktreeCommandSchema,
  worktreeHooksSchema,
  type CommandHook,
  type CopyHook,
  type SymlinkHook,
  type WorktreeCommandCatalogConfig,
  type WorktreeCommandConfig,
  type WorktreeCommandInput,
  type WorktreeCommandLifecycleConfig,
  type WorktreeHooksConfig,
  type WorktreePostCreateHook,
} from './project-config.schema.js';

const commandFields = new Set(['name', 'command', 'cwd', 'ports', 'envFiles', 'env', 'lifecycle']);

const lifecycleEvents = new Set(['postCreate', 'activate', 'deactivate', 'preDelete']);

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

  const decoded = decode(worktreeHooksSchema, { postCreate }, 'worktrees.hooks');
  return { postCreate: decoded.postCreate.map(normalizePostCreateHook) };
}

export function normalizeCommandCatalogConfig(
  input: unknown,
  options: { readonly worktreeRootPath: string },
): WorktreeCommandCatalogConfig {
  if (!isRecord(input) || !('commands' in input)) {
    return { commands: [] };
  }

  if (!Array.isArray(input.commands)) {
    throw new Error('commands must be a list.');
  }

  const seenNames = new Set<string>();
  const commands = input.commands.map((entry, index) =>
    normalizeCommandEntry(entry, {
      field: `commands[${index}]`,
      seenNames,
      worktreeRootPath: options.worktreeRootPath,
    }),
  );

  return { commands };
}

function normalizePostCreateHook(input: unknown): WorktreePostCreateHook {
  if (!isRecord(input)) {
    throw new Error('Each postCreate hook must be an object.');
  }
  switch (input.type) {
    case 'copy':
      return normalizeCopyHook(decode(copyHookSchema, input, 'copy'));
    case 'symlink':
      return normalizeSymlinkHook(decode(symlinkHookSchema, input, 'symlink'));
    case 'command':
      return normalizeCommandHook(decode(commandHookSchema, input, 'command'));
    default:
      throw new Error('Each postCreate hook needs type copy, symlink, or command.');
  }
}

function normalizeCopyHook(input: Schema.Schema.Type<typeof copyHookSchema>): CopyHook {
  return {
    type: 'copy',
    src: input.src,
    dest: input.dest,
    include: input.include ?? ['**/*'],
    exclude: input.exclude ?? [],
    overwrite: input.overwrite ?? true,
  };
}

function normalizeSymlinkHook(input: Schema.Schema.Type<typeof symlinkHookSchema>): SymlinkHook {
  return {
    type: 'symlink',
    src: input.src,
    dest: input.dest,
    overwrite: input.overwrite ?? true,
  };
}

function normalizeCommandHook(input: Schema.Schema.Type<typeof commandHookSchema>): CommandHook {
  return {
    type: 'command',
    run: input.run,
    cwd: input.cwd ?? '.',
    timeout: input.timeout ?? '10m',
    env: input.env ?? {},
  };
}

function normalizeCommandEntry(
  input: unknown,
  options: {
    readonly field: string;
    readonly seenNames: Set<string>;
    readonly worktreeRootPath: string;
  },
): WorktreeCommandConfig {
  if (!isRecord(input)) {
    throw new Error(`${options.field} must be an object.`);
  }

  assertKnownFields(input, commandFields, options.field);
  assertRawLifecycleKnownFields(input.lifecycle, `${options.field}.lifecycle`);

  const decoded = decode(worktreeCommandSchema, input, options.field);
  const name = normalizeCommandName(decoded.name, `${options.field}.name`);
  if (options.seenNames.has(name)) {
    throw new Error(`Duplicate command name: ${name}.`);
  }
  options.seenNames.add(name);

  return {
    name,
    command: decoded.command,
    cwd:
      decoded.cwd === undefined || decoded.cwd === null
        ? null
        : requiredSafeRelativePath(decoded.cwd, `${options.field}.cwd`, options.worktreeRootPath),
    env: normalizeCommandEnv(decoded.env, `${options.field}.env`),
    envFiles: normalizeCommandEnvFiles(
      decoded.envFiles,
      `${options.field}.envFiles`,
      options.worktreeRootPath,
    ),
    ports: decoded.ports ?? [],
    lifecycle: normalizeLifecycle(decoded.lifecycle, `${options.field}.lifecycle`),
  };
}

function assertRawLifecycleKnownFields(value: unknown, field: string) {
  if (value === undefined || value === null) {
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  assertKnownFields(value, lifecycleEvents, field);
  for (const event of lifecycleEvents) {
    const eventValue = value[event];
    if (eventValue === undefined || !isRecord(eventValue)) {
      continue;
    }
    assertKnownFields(
      eventValue,
      new Set(event === 'postCreate' || event === 'activate' ? ['start'] : ['stop']),
      `${field}.${event}`,
    );
  }
}

function normalizeLifecycle(
  input: WorktreeCommandInput['lifecycle'],
  field: string,
): WorktreeCommandLifecycleConfig {
  if (input === undefined) {
    return defaultCommandLifecycle;
  }
  if (!isRecord(input)) {
    throw new Error(`${field} must be an object.`);
  }

  assertKnownFields(input, lifecycleEvents, field);
  const decoded = decode(worktreeCommandLifecycleSchema, input, field);

  return {
    postCreate: {
      start: normalizeLifecycleEvent(
        decoded.postCreate,
        'start',
        defaultCommandLifecycle.postCreate.start,
      ),
    },
    activate: {
      start: normalizeLifecycleEvent(
        decoded.activate,
        'start',
        defaultCommandLifecycle.activate.start,
      ),
    },
    deactivate: {
      stop: normalizeLifecycleEvent(
        decoded.deactivate,
        'stop',
        defaultCommandLifecycle.deactivate.stop,
      ),
    },
    preDelete: {
      stop: normalizeLifecycleEvent(
        decoded.preDelete,
        'stop',
        defaultCommandLifecycle.preDelete.stop,
      ),
    },
  };
}

function normalizeLifecycleEvent<Action extends 'start' | 'stop'>(
  event: Readonly<Partial<Record<Action, boolean | undefined>>> | undefined,
  action: Action,
  fallback: boolean,
) {
  return event?.[action] ?? fallback;
}

function normalizeCommandName(value: string, field: string) {
  if (value.trim() !== value) {
    throw new Error(`${field} must not have leading or trailing whitespace.`);
  }
  return value;
}

function normalizeCommandEnv(value: Readonly<Record<string, string>> | undefined, field: string) {
  if (value === undefined) {
    return {};
  }
  for (const key of Object.keys(value)) {
    if (key === '') {
      throw new Error(`${field} keys must be non-empty strings.`);
    }
  }
  return value;
}

function normalizeCommandEnvFiles(
  value: readonly string[] | undefined,
  field: string,
  worktreeRootPath: string,
) {
  return (value ?? []).map((entry, index) =>
    requiredSafeRelativePath(entry, `${field}[${index}]`, worktreeRootPath),
  );
}

function requiredSafeRelativePath(value: string, field: string, worktreeRootPath: string) {
  if (isAbsolute(value)) {
    throw new Error(`${field} must be relative to the worktree root.`);
  }
  const resolved = resolve(worktreeRootPath, value);
  const relativePath = relative(worktreeRootPath, resolved);
  if (
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    relativePath.startsWith('../') ||
    relativePath.startsWith('..\\') ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`${field} must stay inside the worktree root.`);
  }
  return value;
}

function assertKnownFields(
  input: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  field: string,
) {
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      throw new Error(`${field}.${key} is not a supported field.`);
    }
  }
}

function decode<A, I>(schema: Schema.Schema<A, I>, value: unknown, field: string): A {
  const decoded = Schema.decodeUnknownEither(schema)(value);
  if (Either.isRight(decoded)) {
    return decoded.right;
  }
  throw new Error(formatSchemaError(decoded.left, field));
}

function formatSchemaError(cause: unknown, field: string) {
  const message = cause instanceof Error ? cause.message : '';
  const leaf = message
    .split('\n')
    .map((line) => line.replace(/[└├│─]/g, '').trim())
    .reverse()
    .find((line) => line.startsWith('Expected ') && !line.startsWith('Expected undefined'));
  const detail = leaf?.includes('actual ""')
    ? 'Expected a non-empty string, actual ""'
    : leaf?.includes('actual null')
      ? 'Expected an object, actual null'
      : leaf;

  return `${field}${fieldDetail(message)} ${detail ?? 'is invalid.'}`;
}

function fieldDetail(message: string) {
  const path = message
    .split('\n')
    .map((line) => line.replace(/[└├│─]/g, '').trim())
    .filter((line) => /^\[(?:"[^"]+"|\d+)\]$/.test(line))
    .map((line) => line.slice(1, -1).replace(/^"|"$/g, ''));

  if (path.length === 0) {
    return '';
  }
  return path.map((part) => (/^\d+$/.test(part) ? `[${part}]` : `.${part}`)).join('');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
