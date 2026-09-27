/**
 * The `isagi` command table and its parser.
 *
 * Pure data and pure functions, with no IO: `--help`, argument validation and the shipped skill's
 * agreement test all read this one table, so a documented command line cannot drift from the one the
 * CLI accepts. Handlers live beside it in `index.ts`, keyed by the same command ids, and the type of
 * that map forces exactly one handler per entry here.
 *
 * Value rules come from `@isagi/contracts` rather than being restated: a page limit is whatever the
 * contract's pagination query accepts, a run status is one of the contract's literals.
 */
import { parseArgs } from 'node:util';

import { Schema } from 'effect';

import {
  paginationQuerySchema,
  workflowRunStatusSchema,
  type WorkflowRunStatus,
  type WorkflowSurfaceChoiceDto,
  type WorkflowWorktreeChoiceDto,
} from '@isagi/contracts';

/** How a string value is validated and converted before any request. */
export type ValueKind =
  | 'positive_integer'
  | 'page_limit'
  | 'run_status'
  | 'text'
  | 'worktree_placement'
  | 'surface_placement';

export interface StringOptionSpec {
  readonly type: 'string';
  readonly value: ValueKind;
  readonly placeholder: string;
  readonly description: string;
  readonly required?: true;
  readonly multiple?: true;
}

export interface BooleanOptionSpec {
  readonly type: 'boolean';
  readonly description: string;
}

export type OptionSpec = StringOptionSpec | BooleanOptionSpec;

export interface PositionalSpec {
  readonly name: string;
  readonly value: ValueKind;
  readonly placeholder: string;
}

export interface CommandSpec {
  readonly group: string;
  readonly verb: string;
  readonly summary: string;
  readonly positionals: readonly PositionalSpec[];
  readonly options: Readonly<Record<string, OptionSpec>>;
  /** Groups of options of which at most one may be given. */
  readonly exclusive?: readonly (readonly string[])[];
  /** `{ a: 'b' }`: giving `--a` requires `--b`. */
  readonly requires?: Readonly<Record<string, string>>;
  /** `raw` writes bytes to stdout and never a JSON document; `json` prints one document. */
  readonly stdout: 'json' | 'raw';
}

const cursor = {
  type: 'string',
  value: 'text',
  placeholder: 'cursor',
  description: "Continue from a previous page's nextCursor.",
} as const satisfies StringOptionSpec;

const limit = {
  type: 'string',
  value: 'page_limit',
  placeholder: 'n',
  description: 'Page size (1–500; the runtime defaults to 100).',
} as const satisfies StringOptionSpec;

const run = {
  type: 'string',
  value: 'positive_integer',
  placeholder: 'runId',
  description: 'The run the record belongs to.',
  required: true,
} as const satisfies StringOptionSpec;

const originWorktree = {
  type: 'string',
  value: 'positive_integer',
  placeholder: 'worktreeId',
  description:
    'Launch origin worktree. Defaults to the worktree containing the current directory; give with --surface.',
} as const satisfies StringOptionSpec;

const originSurface = {
  type: 'string',
  value: 'positive_integer',
  placeholder: 'surfaceId',
  description:
    "Launch origin surface. Defaults to that worktree's focused surface; give with --worktree.",
} as const satisfies StringOptionSpec;

const runIdPositional = [
  { name: 'runId', value: 'positive_integer', placeholder: 'runId' },
] as const satisfies readonly PositionalSpec[];

export const commandTable = [
  {
    group: 'workflows',
    verb: 'list',
    summary: 'List the workflows that can be launched from an origin worktree.',
    positionals: [],
    options: { worktree: originWorktree, surface: originSurface },
    requires: { worktree: 'surface', surface: 'worktree' },
    stdout: 'json',
  },
  {
    group: 'runs',
    verb: 'list',
    summary: 'List runs, newest first.',
    positionals: [],
    options: {
      workflow: {
        type: 'string',
        value: 'text',
        placeholder: 'workflowKey',
        description: 'Only runs of this workflow key.',
      },
      status: {
        type: 'string',
        value: 'run_status',
        placeholder: 'status',
        description: 'Only runs in this status.',
      },
      cursor,
      limit,
    },
    stdout: 'json',
  },
  {
    group: 'runs',
    verb: 'inspect',
    summary: 'Show a run and its root frame.',
    positionals: runIdPositional,
    options: {},
    stdout: 'json',
  },
  {
    group: 'runs',
    verb: 'versions',
    summary: 'List the workflow versions (pins) a run has adopted.',
    positionals: runIdPositional,
    options: { cursor, limit },
    stdout: 'json',
  },
  {
    group: 'runs',
    verb: 'structure',
    summary: "Show a run's workflow structure at its current pin, or at one artifact hash.",
    positionals: runIdPositional,
    options: {
      'artifact-hash': {
        type: 'string',
        value: 'text',
        placeholder: 'hash',
        description: 'The pinned artifact hash to describe instead of the current one.',
      },
    },
    stdout: 'json',
  },
  {
    group: 'runs',
    verb: 'events',
    summary: "List a run's history events, including pauses and Retry pin adoptions.",
    positionals: runIdPositional,
    options: { cursor, limit },
    stdout: 'json',
  },
  {
    group: 'runs',
    verb: 'launch',
    summary: 'Start a fresh run of a workflow, with explicit inputs and placement.',
    positionals: [{ name: 'workflowKey', value: 'text', placeholder: 'workflowKey' }],
    options: {
      inputs: {
        type: 'string',
        value: 'text',
        placeholder: 'json|@file',
        description:
          'The run inputs: a JSON object, or @<path> to a file holding one (relative to the current directory).',
      },
      'worktree-placement': {
        type: 'string',
        value: 'worktree_placement',
        placeholder: 'placement',
        description:
          'current | existing:<worktreeId> | create:<branch>:<fromRef>. Give with --surface-placement.',
      },
      'surface-placement': {
        type: 'string',
        value: 'surface_placement',
        placeholder: 'placement',
        description:
          'current | existing:<surfaceId> | create:<title>. Give with --worktree-placement.',
      },
      worktree: originWorktree,
      surface: originSurface,
    },
    requires: {
      'worktree-placement': 'surface-placement',
      'surface-placement': 'worktree-placement',
      worktree: 'surface',
      surface: 'worktree',
    },
    stdout: 'json',
  },
  {
    group: 'runs',
    verb: 'pause',
    summary: 'Pause a run.',
    positionals: runIdPositional,
    options: {},
    stdout: 'json',
  },
  {
    group: 'runs',
    verb: 'resume',
    summary: 'Resume a paused run.',
    positionals: runIdPositional,
    options: {},
    stdout: 'json',
  },
  {
    group: 'runs',
    verb: 'retry',
    summary: 'Retry a failed run using the latest compatible verified workflow build.',
    positionals: runIdPositional,
    options: {},
    stdout: 'json',
  },
  {
    group: 'runs',
    verb: 'cancel',
    summary: 'Cancel a run.',
    positionals: runIdPositional,
    options: {},
    stdout: 'json',
  },
  {
    group: 'executions',
    verb: 'list',
    summary: "List one frame's executions; the run's root frame unless --frame is given.",
    positionals: [],
    options: {
      run,
      frame: {
        type: 'string',
        value: 'positive_integer',
        placeholder: 'frameId',
        description: 'A child frame to list instead of the root frame.',
      },
      node: {
        type: 'string',
        value: 'text',
        placeholder: 'nodeId',
        description: 'Only executions of this node.',
      },
      cursor,
      limit,
    },
    stdout: 'json',
  },
  {
    group: 'executions',
    verb: 'inspect',
    summary: 'Show one execution.',
    positionals: [{ name: 'executionId', value: 'positive_integer', placeholder: 'executionId' }],
    options: { run },
    stdout: 'json',
  },
  {
    group: 'attempts',
    verb: 'list',
    summary: "List an execution's attempts with their pins and timing.",
    positionals: [],
    options: {
      run,
      execution: {
        type: 'string',
        value: 'positive_integer',
        placeholder: 'executionId',
        description: 'The execution whose attempts to list.',
        required: true,
      },
      cursor,
      limit,
    },
    stdout: 'json',
  },
  {
    group: 'operations',
    verb: 'list',
    summary: "List a run's operations (agent turns and other effects).",
    positionals: [],
    options: {
      run,
      execution: {
        type: 'string',
        value: 'positive_integer',
        placeholder: 'executionId',
        description: 'Only operations of this execution.',
      },
      cursor,
      limit,
    },
    stdout: 'json',
  },
  {
    group: 'operations',
    verb: 'inspect',
    summary: 'Show one operation, with usage and native session references when known.',
    positionals: [{ name: 'operationKey', value: 'text', placeholder: 'operationKey' }],
    options: { run },
    stdout: 'json',
  },
  {
    group: 'payloads',
    verb: 'read',
    summary: 'Read one retained payload (inputs, outputs, answers) by its reference.',
    positionals: [{ name: 'payloadRef', value: 'text', placeholder: 'payloadRef' }],
    options: { run },
    stdout: 'json',
  },
  {
    group: 'evidence',
    verb: 'list',
    summary: "List a run's evidence metadata.",
    positionals: [],
    options: {
      run,
      execution: {
        type: 'string',
        value: 'positive_integer',
        placeholder: 'executionId',
        description: 'Only evidence recorded by this execution.',
      },
      descendants: {
        type: 'boolean',
        description: 'Also include every execution nested beneath --execution.',
      },
      role: {
        type: 'string',
        value: 'text',
        placeholder: 'role',
        description: 'Only evidence with this role.',
      },
      label: {
        type: 'string',
        value: 'text',
        placeholder: 'label',
        description: 'Only evidence carrying this label; repeat for more labels.',
        multiple: true,
      },
      cursor,
      limit,
    },
    requires: { descendants: 'execution' },
    stdout: 'json',
  },
  {
    group: 'evidence',
    verb: 'inspect',
    summary: "Show one evidence record's metadata and source.",
    positionals: [{ name: 'evidenceKey', value: 'text', placeholder: 'evidenceKey' }],
    options: { run },
    stdout: 'json',
  },
  {
    group: 'evidence',
    verb: 'read',
    summary: "Write one evidence record's raw bytes to stdout.",
    positionals: [{ name: 'evidenceKey', value: 'text', placeholder: 'evidenceKey' }],
    options: { run },
    stdout: 'raw',
  },
  {
    group: 'evidence',
    verb: 'export',
    summary: 'Save one evidence record to a new file.',
    positionals: [{ name: 'evidenceKey', value: 'text', placeholder: 'evidenceKey' }],
    options: {
      run,
      output: {
        type: 'string',
        value: 'text',
        placeholder: 'file',
        description: 'The file to create, relative to the current directory. Must not exist.',
        required: true,
      },
    },
    stdout: 'json',
  },
  {
    group: 'checkpoints',
    verb: 'list',
    summary: "List a run's checkpoints.",
    positionals: [],
    options: {
      run,
      execution: {
        type: 'string',
        value: 'positive_integer',
        placeholder: 'executionId',
        description: 'Only checkpoints saved by this execution.',
      },
      descendants: {
        type: 'boolean',
        description: 'Also include every execution nested beneath --execution.',
      },
      cursor,
      limit,
    },
    requires: { descendants: 'execution' },
    stdout: 'json',
  },
  {
    group: 'checkpoints',
    verb: 'inspect',
    summary: 'Show a checkpoint; --resolved adds its final inventory, --manifest its layers.',
    positionals: [{ name: 'checkpointId', value: 'text', placeholder: 'checkpointId' }],
    options: {
      run,
      resolved: {
        type: 'boolean',
        description: 'Add every page of the resolved inventory (final files and absences).',
      },
      manifest: {
        type: 'boolean',
        description: 'Add every page of the layer manifest (inspection only).',
      },
    },
    exclusive: [['resolved', 'manifest']],
    stdout: 'json',
  },
  {
    group: 'checkpoints',
    verb: 'export',
    summary: "Rebuild a checkpoint's files in an empty folder outside every checkout.",
    positionals: [{ name: 'checkpointId', value: 'text', placeholder: 'checkpointId' }],
    options: {
      run,
      output: {
        type: 'string',
        value: 'text',
        placeholder: 'dir',
        description:
          'The export root: absent or empty, and outside every checkout. Relative to the current directory.',
        required: true,
      },
    },
    stdout: 'json',
  },
] as const satisfies readonly CommandSpec[];

type Table = typeof commandTable;
type Entry = Table[number];

/** `'runs list'`, `'evidence read'`, …: one id per table entry, never a group paired with another group's verb. */
export type CommandId = IdOf<Entry>;

type IdOf<Spec> = Spec extends {
  readonly group: infer Group extends string;
  readonly verb: infer Verb extends string;
}
  ? `${Group} ${Verb}`
  : never;

type SpecOf<Id extends CommandId> = Extract<Entry, { group: GroupOf<Id>; verb: VerbOf<Id> }>;
type GroupOf<Id extends string> = Id extends `${infer Group} ${string}` ? Group : never;
type VerbOf<Id extends string> = Id extends `${string} ${infer Verb}` ? Verb : never;

type ConvertedValue<Kind extends ValueKind> = Kind extends 'positive_integer' | 'page_limit'
  ? number
  : Kind extends 'run_status'
    ? WorkflowRunStatus
    : Kind extends 'worktree_placement'
      ? WorkflowWorktreeChoiceDto
      : Kind extends 'surface_placement'
        ? WorkflowSurfaceChoiceDto
        : string;

type AnyConvertedValue = ConvertedValue<ValueKind>;

type OptionValue<Option> = Option extends BooleanOptionSpec
  ? boolean
  : Option extends StringOptionSpec & { readonly multiple: true }
    ? readonly string[]
    : Option extends StringOptionSpec & { readonly required: true }
      ? ConvertedValue<Option['value']>
      : Option extends StringOptionSpec
        ? ConvertedValue<Option['value']> | undefined
        : never;

/** The validated, converted arguments of one command, typed from its table entry. */
export interface CommandArguments<Id extends CommandId> {
  readonly positionals: {
    readonly [Positional in SpecOf<Id>['positionals'][number] as Positional['name']]: ConvertedValue<
      Positional['value']
    >;
  };
  readonly options: {
    readonly [Name in keyof SpecOf<Id>['options']]: OptionValue<SpecOf<Id>['options'][Name]>;
  };
}

export interface GlobalOptions {
  readonly json: boolean;
  readonly runtimeUrl: string | undefined;
}

export type ParsedCommandLine =
  | {
      readonly kind: 'command';
      readonly id: CommandId;
      readonly spec: CommandSpec;
      readonly arguments: CommandArguments<CommandId>;
      readonly global: GlobalOptions;
    }
  | { readonly kind: 'help'; readonly text: string }
  | { readonly kind: 'usage_error'; readonly message: string; readonly global: GlobalOptions };

const globalOptionSpecs = {
  json: { type: 'boolean' },
  'runtime-url': { type: 'string' },
  help: { type: 'boolean' },
} as const;

/**
 * Parse one `isagi` command line, without touching the network or the filesystem.
 *
 * Every rule the table states — unknown commands and flags, required values, `exclusive` and
 * `requires`, and value kinds — fails here with a usage error, before any request.
 */
export function parseCommandLine(argv: readonly string[]): ParsedCommandLine {
  const global = scanGlobalOptions(argv);
  const [group, verb] = leadingWords(argv);

  if (global.help) {
    return { kind: 'help', text: helpText(group, verb) };
  }
  if (group === undefined) {
    return usageError('No command given. Run `isagi --help` for the command list.', global);
  }
  if (!commandTable.some((entry) => entry.group === group)) {
    return usageError(`Unknown command group "${group}".`, global);
  }
  if (verb === undefined) {
    return usageError(`Missing a command after "${group}".`, global);
  }
  const spec = findCommand(group, verb);
  if (!spec) {
    return usageError(`Unknown command "${group} ${verb}".`, global);
  }

  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: { ...globalOptionSpecs, ...parseArgsOptions(spec) },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    return usageError(error instanceof Error ? error.message : String(error), global);
  }

  const [, , ...positionalValues] = parsed.positionals;
  if (positionalValues.length > spec.positionals.length) {
    return usageError(
      `Unexpected argument "${positionalValues[spec.positionals.length]}" for "${spec.group} ${spec.verb}".`,
      global,
    );
  }

  const positionals: Record<string, AnyConvertedValue> = {};
  for (const [index, positional] of spec.positionals.entries()) {
    const raw = positionalValues[index];
    if (raw === undefined) {
      return usageError(`"${spec.group} ${spec.verb}" needs <${positional.placeholder}>.`, global);
    }
    const converted = convertValue(positional.value, raw);
    if (!converted.ok) {
      return usageError(`<${positional.placeholder}> ${converted.problem}`, global);
    }
    positionals[positional.name] = converted.value;
  }

  const options: Record<string, AnyConvertedValue | boolean | readonly string[] | undefined> = {};
  for (const [name, option] of Object.entries(spec.options)) {
    const raw = parsed.values[name];
    if (option.type === 'boolean') {
      options[name] = raw === true;
      continue;
    }
    if (raw === undefined) {
      if (option.required) return usageError(`--${name} is required.`, global);
      options[name] = option.multiple ? [] : undefined;
      continue;
    }
    const rawValues = Array.isArray(raw) ? raw : [raw];
    const converted: AnyConvertedValue[] = [];
    for (const value of rawValues) {
      const result = convertValue(option.value, String(value));
      if (!result.ok) return usageError(`--${name} ${result.problem}`, global);
      converted.push(result.value);
    }
    options[name] = option.multiple ? (converted as string[]) : converted[0];
  }

  for (const exclusive of spec.exclusive ?? []) {
    const given = exclusive.filter((name) => isGiven(options[name]));
    if (given.length > 1) {
      return usageError(
        `${given.map((name) => `--${name}`).join(' and ')} cannot be combined.`,
        global,
      );
    }
  }
  for (const [name, required] of Object.entries(spec.requires ?? {})) {
    if (isGiven(options[name]) && !isGiven(options[required])) {
      return usageError(`--${name} requires --${required}.`, global);
    }
  }

  return {
    kind: 'command',
    id: `${spec.group} ${spec.verb}` as CommandId,
    spec,
    arguments: { positionals, options } as unknown as CommandArguments<CommandId>,
    global: { json: global.json, runtimeUrl: global.runtimeUrl },
  };
}

export function findCommand(group: string, verb: string): CommandSpec | undefined {
  return commandTable.find((entry) => entry.group === group && entry.verb === verb);
}

/** `isagi --help`, `isagi <group> --help` or `isagi <group> <verb> --help`. */
export function helpText(group?: string, verb?: string): string {
  const spec = group !== undefined && verb !== undefined ? findCommand(group, verb) : undefined;
  if (spec) return commandHelp(spec);
  const entries = commandTable.filter((entry) => group === undefined || entry.group === group);
  const listed = entries.length > 0 ? entries : commandTable;
  const width = Math.max(...listed.map((entry) => `${entry.group} ${entry.verb}`.length));
  return [
    'Usage: isagi <group> <command> [arguments] [--json] [--runtime-url <url>]',
    '',
    'Commands:',
    ...listed.map((entry) => `  ${`${entry.group} ${entry.verb}`.padEnd(width)}  ${entry.summary}`),
    '',
    'Global options:',
    '  --json               Print exactly one JSON document on stdout.',
    '  --runtime-url <url>  The runtime to call; overrides ISAGI_RUNTIME_URL.',
    '  --help               Show help for a command.',
    '',
  ].join('\n');
}

function commandHelp(spec: CommandSpec): string {
  const lines = [`Usage: ${usageLine(spec)}`, '', spec.summary, ''];
  const options = Object.entries(spec.options);
  if (options.length > 0) {
    lines.push('Options:');
    for (const [name, option] of options) {
      const flag = option.type === 'string' ? `--${name} <${option.placeholder}>` : `--${name}`;
      const notes = [
        option.type === 'string' && option.required ? 'required' : undefined,
        option.type === 'string' && option.multiple ? 'repeatable' : undefined,
      ].filter((note) => note !== undefined);
      const suffix = notes.length > 0 ? ` (${notes.join(', ')})` : '';
      lines.push(`  ${flag}  ${option.description}${suffix}`);
    }
    lines.push('');
  }
  for (const group of spec.exclusive ?? []) {
    lines.push(`${group.map((name) => `--${name}`).join(' and ')} are mutually exclusive.`);
  }
  for (const [name, required] of Object.entries(spec.requires ?? {})) {
    lines.push(`--${name} requires --${required}.`);
  }
  if (spec.stdout === 'raw') {
    lines.push('Writes raw bytes to stdout; failures go to stderr.');
  }
  lines.push('Global options: --json, --runtime-url <url>, --help.', '');
  return lines.join('\n');
}

function usageLine(spec: CommandSpec): string {
  const parts = [`isagi ${spec.group} ${spec.verb}`];
  for (const positional of spec.positionals) parts.push(`<${positional.placeholder}>`);
  for (const [name, option] of Object.entries(spec.options)) {
    const flag = option.type === 'string' ? `--${name} <${option.placeholder}>` : `--${name}`;
    const required = option.type === 'string' && option.required;
    const repeat = option.type === 'string' && option.multiple ? '…' : '';
    parts.push(required ? flag : `[${flag}]${repeat}`);
  }
  return parts.join(' ');
}

function parseArgsOptions(spec: CommandSpec) {
  const options: Record<string, { type: 'string' | 'boolean'; multiple?: boolean }> = {};
  for (const [name, option] of Object.entries(spec.options)) {
    options[name] =
      option.type === 'string' && option.multiple
        ? { type: 'string', multiple: true }
        : { type: option.type };
  }
  return options;
}

type Converted =
  | { readonly ok: true; readonly value: AnyConvertedValue }
  | { readonly ok: false; readonly problem: string };

function convertValue(kind: ValueKind, raw: string): Converted {
  switch (kind) {
    case 'text':
      return raw.length > 0
        ? { ok: true, value: raw }
        : { ok: false, problem: 'must not be empty.' };
    case 'positive_integer': {
      const value = integerOf(raw);
      return value !== undefined && value > 0
        ? { ok: true, value }
        : { ok: false, problem: `must be a positive integer, got "${raw}".` };
    }
    case 'page_limit': {
      const value = integerOf(raw);
      return value !== undefined && Schema.is(paginationQuerySchema)({ limit: value })
        ? { ok: true, value }
        : { ok: false, problem: `must be a page size the runtime accepts (1–500), got "${raw}".` };
    }
    case 'worktree_placement':
      return worktreePlacementOf(raw);
    case 'surface_placement':
      return surfacePlacementOf(raw);
    case 'run_status':
      return Schema.is(workflowRunStatusSchema)(raw)
        ? { ok: true, value: raw }
        : {
            ok: false,
            problem: `must be one of ${workflowRunStatusSchema.literals.join(', ')}, got "${raw}".`,
          };
  }
}

/**
 * `current | existing:<id> | create:<branch>:<fromRef>`. Git ref names cannot contain `:`, so the
 * value splits at its first two colons; anything after the second belongs to `fromRef`.
 */
function worktreePlacementOf(raw: string): Converted {
  const problem = {
    ok: false,
    problem: `must be current, existing:<worktreeId> or create:<branch>:<fromRef>, got "${raw}".`,
  } as const;
  if (raw === 'current') return { ok: true, value: { kind: 'current' } };
  if (raw.startsWith('existing:')) {
    const worktreeId = integerOf(raw.slice('existing:'.length));
    return worktreeId !== undefined && worktreeId > 0
      ? { ok: true, value: { kind: 'existing', worktreeId } }
      : problem;
  }
  if (raw.startsWith('create:')) {
    const rest = raw.slice('create:'.length);
    const colon = rest.indexOf(':');
    const branch = colon < 0 ? '' : rest.slice(0, colon);
    const fromRef = colon < 0 ? '' : rest.slice(colon + 1);
    return branch.length > 0 && fromRef.length > 0
      ? { ok: true, value: { kind: 'create', branch, fromRef } }
      : problem;
  }
  return problem;
}

/** `current | existing:<id> | create:<title>`. A title is everything after `create:`, colons included. */
function surfacePlacementOf(raw: string): Converted {
  const problem = {
    ok: false,
    problem: `must be current, existing:<surfaceId> or create:<title>, got "${raw}".`,
  } as const;
  if (raw === 'current') return { ok: true, value: { kind: 'current' } };
  if (raw.startsWith('existing:')) {
    const surfaceId = integerOf(raw.slice('existing:'.length));
    return surfaceId !== undefined && surfaceId > 0
      ? { ok: true, value: { kind: 'existing', surfaceId } }
      : problem;
  }
  if (raw.startsWith('create:')) {
    const title = raw.slice('create:'.length);
    return title.length > 0 ? { ok: true, value: { kind: 'create', title } } : problem;
  }
  return problem;
}

function integerOf(raw: string): number | undefined {
  if (!/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}

function isGiven(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined && value !== false;
}

/**
 * The global flags, read leniently so a malformed command line still knows whether its failure must
 * be a JSON document and which runtime it was aimed at.
 */
function scanGlobalOptions(argv: readonly string[]) {
  let json = false;
  let help = false;
  let runtimeUrl: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === '--') break;
    if (token === '--json') json = true;
    else if (token === '--help' || token === '-h') help = true;
    else if (token === '--runtime-url') runtimeUrl = argv[++index];
    else if (token.startsWith('--runtime-url=')) runtimeUrl = token.slice('--runtime-url='.length);
  }
  return { json, help, runtimeUrl };
}

/** The group and verb: the first two words that are neither flags nor a flag's value. */
function leadingWords(argv: readonly string[]): [string | undefined, string | undefined] {
  const valueFlags = new Set(['--runtime-url']);
  for (const entry of commandTable) {
    for (const [name, option] of Object.entries(entry.options)) {
      if (option.type === 'string') valueFlags.add(`--${name}`);
    }
  }
  const words: string[] = [];
  for (let index = 0; index < argv.length && words.length < 2; index += 1) {
    const token = argv[index]!;
    if (token === '--') {
      words.push(...argv.slice(index + 1, index + 1 + (2 - words.length)));
      break;
    }
    if (token.startsWith('-')) {
      if (valueFlags.has(token)) index += 1;
      continue;
    }
    words.push(token);
  }
  return [words[0], words[1]];
}

function usageError(message: string, global: { json: boolean; runtimeUrl: string | undefined }) {
  return {
    kind: 'usage_error',
    message,
    global: { json: global.json, runtimeUrl: global.runtimeUrl },
  } as const;
}
