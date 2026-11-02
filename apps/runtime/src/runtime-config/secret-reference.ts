import { Redacted } from 'effect';

const envPrefix = 'env.';

export type SecretResolution =
  | { readonly _tag: 'resolved'; readonly value: Redacted.Redacted<string> }
  | { readonly _tag: 'variable_unset'; readonly variable: string };

/**
 * A secret as written in `config.yaml`: `env.NAME` becomes the value of `NAME` in `environment` (unset or empty is
 * `variable_unset`, named but never valued; only own properties count); anything else is the secret itself. The schema has already checked the
 * name.
 */
export function resolveSecretReference(
  written: Redacted.Redacted<string>,
  environment: Readonly<Record<string, string | undefined>>,
): SecretResolution {
  const text = Redacted.value(written);
  if (!text.startsWith(envPrefix)) return { _tag: 'resolved', value: written };
  const variable = text.slice(envPrefix.length);
  // Own string properties only: a name such as `constructor` or `__proto__` must read as unset, not as an inherited
  // object member.
  const value = Object.hasOwn(environment, variable) ? environment[variable] : undefined;
  return typeof value !== 'string' || value === ''
    ? { _tag: 'variable_unset', variable }
    : { _tag: 'resolved', value: Redacted.make(value) };
}
