import type { SourcedValue } from './serve/launch.js';

/**
 * The one flag-then-environment rule: a flag if given (even empty, so it fails validation rather
 * than silently falling through), else a non-empty environment variable, else nothing. An empty
 * environment variable counts as unset.
 */
export function fromFlagOrEnv(input: {
  readonly flag: string | undefined;
  readonly flagName: `--${string}`;
  readonly envName: string | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
}): SourcedValue<string> | undefined {
  if (input.flag !== undefined) return { value: input.flag, source: 'flag', name: input.flagName };
  if (input.envName === undefined) return undefined;
  const fromEnvironment = input.env[input.envName];
  return fromEnvironment === undefined || fromEnvironment === ''
    ? undefined
    : { value: fromEnvironment, source: 'env', name: input.envName };
}
