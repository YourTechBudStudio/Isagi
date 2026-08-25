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
  type CommandPortPathConfig,
  type CopyHook,
  type SymlinkHook,
  type WorktreeCommandCatalogConfig,
  type WorktreeCommandConfig,
  type WorktreeCommandInput,
  type WorktreeCommandLifecycleConfig,
  type WorktreeCommandPortConfig,
  type WorktreeHooksConfig,
  type WorktreePostCreateHook,
} from './project-config.schema.js';

const commandFields = new Set(['name', 'command', 'cwd', 'ports', 'envFiles', 'env', 'lifecycle']);

const portFields = new Set(['port', 'envVar', 'paths']);

const portPathFields = new Set(['label', 'path']);

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
  assertRawPortKnownFields(input.ports, `${options.field}.ports`);
  assertRawLifecycleKnownFields(input.lifecycle, `${options.field}.lifecycle`);

  const decoded = decode(worktreeCommandSchema, input, options.field);
  const name = normalizeCommandName(decoded.name, `${options.field}.name`);
  if (options.seenNames.has(name)) {
    throw new Error(`Duplicate command name: ${name}.`);
  }
  options.seenNames.add(name);

  const cwd =
    decoded.cwd === undefined || decoded.cwd === null
      ? null
      : requiredSafeRelativePath(decoded.cwd, `${options.field}.cwd`, options.worktreeRootPath);
  // Normalized once, then reused: the allocated-port collision rule is checked
  // against the same record the command actually launches with.
  const env = normalizeCommandEnv(decoded.env, `${options.field}.env`);
  const envFiles = normalizeCommandEnvFiles(
    decoded.envFiles,
    `${options.field}.envFiles`,
    options.worktreeRootPath,
  );
  const ports = normalizeCommandPorts(decoded.ports, env, `${options.field}.ports`);

  return {
    name,
    command: decoded.command,
    cwd,
    env,
    envFiles,
    ports,
    lifecycle: normalizeLifecycle(decoded.lifecycle, `${options.field}.lifecycle`),
  };
}

// Allow-lists run against the raw YAML before decode, so an unknown or
// misshapen port entry fails with its own path rather than as a decode leaf.
// A number, string, null, or array entry is rejected here — `assertKnownFields`
// would find no keys on a number and let it through to a vaguer decode error.
function assertRawPortKnownFields(value: unknown, field: string) {
  if (value === undefined || value === null || !Array.isArray(value)) {
    return;
  }
  value.forEach((entry, index) => {
    const entryField = `${field}[${index}]`;
    if (!isRecord(entry)) {
      throw new Error(`${entryField} must be an object.`);
    }
    assertKnownFields(entry, portFields, entryField);
    const paths = entry.paths;
    if (paths === undefined || paths === null || !Array.isArray(paths)) {
      return;
    }
    paths.forEach((path, pathIndex) => {
      const pathField = `${entryField}.paths[${pathIndex}]`;
      if (!isRecord(path)) {
        throw new Error(`${pathField} must be an object.`);
      }
      assertKnownFields(path, portPathFields, pathField);
    });
  });
}

// Cross-entry rules the schema cannot express. Each is scoped to one command:
// there is no cross-command or cross-worktree port bookkeeping.
function normalizeCommandPorts(
  input: WorktreeCommandInput['ports'],
  env: Readonly<Record<string, string>>,
  field: string,
): readonly WorktreeCommandPortConfig[] {
  if (input === undefined) {
    return [];
  }

  const seenPorts = new Set<number>();
  const seenEnvVars = new Set<string>();
  // Labels become badges, so two identical labels anywhere on one command
  // would be indistinguishable to the user regardless of which port they sit on.
  const seenLabels = new Set<string>();

  return input.map((entry, index) => {
    const entryField = `${field}[${index}]`;
    if ((entry.port === undefined) === (entry.envVar === undefined)) {
      throw new Error(`${entryField} must declare exactly one of port or envVar.`);
    }

    const paths = (entry.paths ?? []).map((path, pathIndex) =>
      normalizeCommandPortPath(path, seenLabels, `${entryField}.paths[${pathIndex}]`),
    );

    if (entry.port !== undefined) {
      if (seenPorts.has(entry.port)) {
        throw new Error(`${entryField}.port ${entry.port} is declared more than once.`);
      }
      seenPorts.add(entry.port);
      return { kind: 'fixed', port: entry.port, paths };
    }

    const envVar = entry.envVar as string;
    if (seenEnvVars.has(envVar)) {
      throw new Error(`${entryField}.envVar ${envVar} is declared more than once.`);
    }
    // A name set in both places is contradictory intent: the allocated value
    // would silently win. Rejecting is louder than resolving it by precedence.
    if (Object.hasOwn(env, envVar)) {
      throw new Error(`${entryField}.envVar collides with env.${envVar}; remove one.`);
    }
    seenEnvVars.add(envVar);
    return { kind: 'allocated', envVar, paths };
  });
}

function normalizeCommandPortPath(
  path: CommandPortPathConfig,
  seenLabels: Set<string>,
  field: string,
): CommandPortPathConfig {
  if (path.label.trim() !== path.label) {
    throw new Error(`${field}.label must not have leading or trailing whitespace.`);
  }
  if (seenLabels.has(path.label)) {
    throw new Error(`${field}.label ${path.label} is declared more than once.`);
  }
  seenLabels.add(path.label);
  return { label: path.label, path: path.path };
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
