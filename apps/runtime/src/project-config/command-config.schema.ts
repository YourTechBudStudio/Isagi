import { isAbsolute, relative, resolve, sep } from 'node:path';

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

const commandFields = new Set(['name', 'command', 'cwd', 'ports', 'envFiles', 'env', 'lifecycle']);

const lifecycleEvents = new Set(['postCreate', 'activate', 'deactivate', 'preDelete']);

const defaultLifecycle = {
  postCreate: { start: false },
  activate: { start: false },
  deactivate: { stop: true },
  preDelete: { stop: true },
} as const satisfies WorktreeCommandLifecycleConfig;

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

  const name = requiredIdentity(input.name, `${options.field}.name`);
  if (options.seenNames.has(name)) {
    throw new Error(`Duplicate command name: ${name}.`);
  }
  options.seenNames.add(name);

  return {
    name,
    command: requiredCommand(input.command, `${options.field}.command`),
    cwd: optionalCwd(input.cwd, `${options.field}.cwd`, options.worktreeRootPath),
    env: optionalStringRecord(input.env, `${options.field}.env`) ?? {},
    envFiles:
      optionalPathArray(input.envFiles, `${options.field}.envFiles`, options.worktreeRootPath) ??
      [],
    ports: optionalPorts(input.ports, `${options.field}.ports`) ?? [],
    lifecycle: normalizeLifecycle(input.lifecycle, `${options.field}.lifecycle`),
  };
}

function normalizeLifecycle(input: unknown, field: string): WorktreeCommandLifecycleConfig {
  if (input === undefined) {
    return defaultLifecycle;
  }
  if (!isRecord(input)) {
    throw new Error(`${field} must be an object.`);
  }

  assertKnownFields(input, lifecycleEvents, field);

  return {
    postCreate: {
      start: optionalLifecycleBoolean(
        eventObject(input.postCreate, `${field}.postCreate`),
        'start',
        defaultLifecycle.postCreate.start,
        `${field}.postCreate`,
      ),
    },
    activate: {
      start: optionalLifecycleBoolean(
        eventObject(input.activate, `${field}.activate`),
        'start',
        defaultLifecycle.activate.start,
        `${field}.activate`,
      ),
    },
    deactivate: {
      stop: optionalLifecycleBoolean(
        eventObject(input.deactivate, `${field}.deactivate`),
        'stop',
        defaultLifecycle.deactivate.stop,
        `${field}.deactivate`,
      ),
    },
    preDelete: {
      stop: optionalLifecycleBoolean(
        eventObject(input.preDelete, `${field}.preDelete`),
        'stop',
        defaultLifecycle.preDelete.stop,
        `${field}.preDelete`,
      ),
    },
  };
}

function eventObject(value: unknown, field: string) {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`${field} must be an object.`);
  }
  return value;
}

function optionalLifecycleBoolean(
  event: Record<string, unknown> | undefined,
  action: 'start' | 'stop',
  fallback: boolean,
  field: string,
) {
  if (!event) {
    return fallback;
  }
  assertKnownFields(event, new Set([action]), field);
  const value = event[action];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'boolean') {
    throw new Error(`${field}.${action} must be a boolean.`);
  }
  return value;
}

function requiredIdentity(value: unknown, field: string) {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`${field} must be a non-empty string.`);
  }
  if (value.trim() !== value) {
    throw new Error(`${field} must not have leading or trailing whitespace.`);
  }
  return value;
}

function requiredCommand(value: unknown, field: string) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value;
}

function optionalCwd(value: unknown, field: string, worktreeRootPath: string) {
  if (value === undefined || value === null) {
    return null;
  }
  return requiredSafeRelativePath(value, field, worktreeRootPath);
}

function optionalPathArray(value: unknown, field: string, worktreeRootPath: string) {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be a list of relative paths.`);
  }
  return value.map((entry, index) =>
    requiredSafeRelativePath(entry, `${field}[${index}]`, worktreeRootPath),
  );
}

function requiredSafeRelativePath(value: unknown, field: string, worktreeRootPath: string) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} must be a non-empty relative path.`);
  }
  if (isAbsolute(value)) {
    throw new Error(`${field} must be relative to the worktree root.`);
  }
  const resolved = resolve(worktreeRootPath, value);
  const relativePath = relative(worktreeRootPath, resolved);
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`${field} must stay inside the worktree root.`);
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
      if (key === '') {
        throw new Error(`${field} keys must be non-empty strings.`);
      }
      if (typeof entry !== 'string') {
        throw new Error(`${field}.${key} must be a string.`);
      }
      return [key, entry];
    }),
  );
}

function optionalPorts(value: unknown, field: string) {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be a list of TCP port numbers.`);
  }
  return value.map((entry, index) => {
    if (!Number.isInteger(entry) || entry < 1 || entry > 65_535) {
      throw new Error(`${field}[${index}] must be an integer from 1 to 65535.`);
    }
    return entry;
  });
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
