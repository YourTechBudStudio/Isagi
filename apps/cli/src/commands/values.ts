/**
 * The value kinds of `isagi` flags and positionals: how a string is validated and converted before
 * any request. A value that breaks its rule fails as `effect/cli`'s `InvalidValue`, so it surfaces
 * like any other parse error (a `cli_usage_invalid` document, see `usage.ts`), and
 * `checkCommandLine` judges it too.
 *
 * Rules come from `@isagi/contracts` rather than being restated: a page limit is whatever the
 * contract's pagination query accepts, a run status is one of the contract's literals.
 */
import { Effect, Schema } from 'effect';
import { Argument, CliError, Flag } from 'effect/cli';

import {
  paginationQuerySchema,
  workflowRunStatusSchema,
  type WorkflowRunStatus,
  type WorkflowSurfaceChoiceDto,
  type WorkflowWorktreeChoiceDto,
} from '@isagi/contracts';

/** A conversion: the value, or what it must be (`must be a positive integer`). */
type Converted<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly problem: string };

export interface ValueKind<A> {
  /** The placeholder help shows: `<runId>`, `--limit <n>`. */
  readonly metavar: string;
  readonly convert: (raw: string) => Converted<A>;
}

/** A flag of this kind, named as written (`worktree-placement`). */
export function flag<A>(name: string, kind: ValueKind<A>, description: string): Flag.Flag<A> {
  return Flag.String(name).pipe(
    Flag.withMetavar(kind.metavar),
    Flag.withDescription(description),
    Flag.mapEffect((raw) => converted(kind, raw, `--${name}`, 'flag')),
  );
}

/** A positional of this kind; help and errors name it `<metavar>`. */
export function argument<A>(kind: ValueKind<A>, description: string): Argument.Argument<A> {
  return Argument.String(kind.metavar).pipe(
    Argument.withDescription(description),
    Argument.mapEffect((raw) => converted(kind, raw, `<${kind.metavar}>`, 'argument')),
  );
}

function converted<A>(
  kind: ValueKind<A>,
  raw: string,
  option: string,
  type: 'flag' | 'argument',
): Effect.Effect<A, CliError.CliError> {
  const result = kind.convert(raw);
  return result.ok
    ? Effect.succeed(result.value)
    : Effect.fail(
        new CliError.InvalidValue({ option, value: raw, expected: result.problem, kind: type }),
      );
}

export const positiveInteger = (metavar: string): ValueKind<number> => ({
  metavar,
  convert: (raw) => {
    const value = integerOf(raw);
    return value !== undefined && value > 0
      ? { ok: true, value }
      : { ok: false, problem: 'must be a positive integer' };
  },
});

export const nonEmptyText = (metavar: string): ValueKind<string> => ({
  metavar,
  convert: (raw) =>
    raw.length > 0 ? { ok: true, value: raw } : { ok: false, problem: 'must not be empty' },
});

export const pageLimit: ValueKind<number> = {
  metavar: 'n',
  convert: (raw) => {
    const value = integerOf(raw);
    return value !== undefined && Schema.is(paginationQuerySchema)({ limit: value })
      ? { ok: true, value }
      : { ok: false, problem: 'must be a page size the runtime accepts (1–500)' };
  },
};

export const runStatus: ValueKind<WorkflowRunStatus> = {
  metavar: 'status',
  convert: (raw) =>
    Schema.is(workflowRunStatusSchema)(raw)
      ? { ok: true, value: raw }
      : { ok: false, problem: `must be one of ${workflowRunStatusSchema.literals.join(', ')}` },
};

/**
 * `current | existing:<id> | create:<branch>:<fromRef>`. Git ref names cannot contain `:`, so the
 * value splits at its first two colons; anything after the second belongs to `fromRef`.
 */
export const worktreePlacement: ValueKind<WorkflowWorktreeChoiceDto> = {
  metavar: 'placement',
  convert: (raw) => {
    const problem = {
      ok: false,
      problem: 'must be current, existing:<worktreeId> or create:<branch>:<fromRef>',
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
  },
};

/** `current | existing:<id> | create:<title>`. A title is everything after `create:`, colons included. */
export const surfacePlacement: ValueKind<WorkflowSurfaceChoiceDto> = {
  metavar: 'placement',
  convert: (raw) => {
    const problem = {
      ok: false,
      problem: 'must be current, existing:<surfaceId> or create:<title>',
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
  },
};

function integerOf(raw: string): number | undefined {
  if (!/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}
