import { Data, Redacted, Result } from 'effect';

import { resolveSecretReference, type RuntimeConfigShape } from '../runtime-config/index.js';

/** Runtime login as the access guard enforces it: off, or on with every credential resolved. */
export type AuthMode =
  | { readonly _tag: 'disabled' }
  | {
      readonly _tag: 'enabled';
      readonly username: Redacted.Redacted<string>;
      readonly password: Redacted.Redacted<string>;
      readonly signingSecret: Redacted.Redacted<string>;
    };

type AuthField = 'username' | 'password' | 'signingSecret';
type AuthFieldPath = `server.auth.${AuthField}`;

/** One reason login cannot start; it names a path and a variable, never a value. */
export type AccessConfigProblem =
  | { readonly path: AuthFieldPath; readonly problem: 'missing' }
  | { readonly path: AuthFieldPath; readonly problem: 'variable_unset'; readonly variable: string };

/** `server.auth` is enabled but some credential is missing or unreadable; fails startup (AC6). */
export class AccessConfigInvalid extends Data.TaggedError('AccessConfigInvalid')<{
  readonly problems: ReadonlyArray<AccessConfigProblem>;
}> {
  override get message() {
    const parts = this.problems.map((problem) =>
      problem.problem === 'missing'
        ? `${problem.path} is missing or empty`
        : `${problem.path} names env.${problem.variable}, which is unset or empty in the login shell environment`,
    );
    return `server.auth is enabled but ${parts.join('; ')}. Set them in config.yaml, then restart.`;
  }
}

const fields: readonly AuthField[] = ['username', 'password', 'signingSecret'];

/**
 * Off without looking at the fields when `enabled` is false (a disabled section stays inert). Otherwise every field
 * must be present and resolve to a non-empty value against `environment`; every problem is collected, so one restart
 * fixes all of them.
 */
export function resolveAuthMode(
  settings: RuntimeConfigShape['server']['auth'],
  environment: Readonly<Record<string, string | undefined>>,
): Result.Result<AuthMode, AccessConfigInvalid> {
  if (!settings.enabled) return Result.succeed({ _tag: 'disabled' });
  const problems: AccessConfigProblem[] = [];
  const resolved: Partial<Record<AuthField, Redacted.Redacted<string>>> = {};
  for (const field of fields) {
    const path: AuthFieldPath = `server.auth.${field}`;
    const written = settings[field];
    if (written === undefined) {
      problems.push({ path, problem: 'missing' });
      continue;
    }
    const resolution = resolveSecretReference(written, environment);
    if (resolution._tag === 'variable_unset') {
      problems.push({ path, problem: 'variable_unset', variable: resolution.variable });
    } else if (Redacted.value(resolution.value) === '') {
      problems.push({ path, problem: 'missing' });
    } else {
      resolved[field] = resolution.value;
    }
  }
  if (problems.length > 0) return Result.fail(new AccessConfigInvalid({ problems }));
  return Result.succeed({
    _tag: 'enabled',
    username: resolved.username!,
    password: resolved.password!,
    signingSecret: resolved.signingSecret!,
  });
}
