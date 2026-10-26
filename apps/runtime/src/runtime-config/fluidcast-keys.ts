import { Redacted } from 'effect';

import type { FluidcastConfig } from './policy.js';

const envPrefix = 'env.';

/** A key's variable that the environment does not set, by its config path; never its value. */
export interface UnsetFluidcastKeyVariable {
  readonly issuePath: string;
  readonly variable: string;
}

export type ResolvedFluidcastKeys =
  | { readonly status: 'resolved'; readonly config: FluidcastConfig }
  | { readonly status: 'unset'; readonly unset: ReadonlyArray<UnsetFluidcastKeyVariable> };

/**
 * Replaces each `env.NAME` key with the value of `NAME` in `environment`; other keys are used as
 * written. The schema has already checked each name. An unset or empty variable is reported by path
 * and name, so the caller can say what is missing without a key ever leaving its `Redacted`.
 */
export function resolveFluidcastKeys(
  config: FluidcastConfig,
  environment: Readonly<Record<string, string | undefined>>,
): ResolvedFluidcastKeys {
  const unset: UnsetFluidcastKeyVariable[] = [];
  const resolve = (key: Redacted.Redacted<string>, issuePath: string) => {
    const written = Redacted.value(key);
    if (!written.startsWith(envPrefix)) return key;
    const variable = written.slice(envPrefix.length);
    const value = environment[variable];
    if (value === undefined || value === '') {
      unset.push({ issuePath, variable });
      return key;
    }
    return Redacted.make(value);
  };
  // Every connection has a key; only an openai-compatible model's is optional.
  const resolveKey = <
    Connection extends { readonly apiKey?: Redacted.Redacted<string> | undefined },
  >(
    connection: Connection,
    issuePath: string,
  ): Connection => {
    const key = connection.apiKey;
    return key === undefined ? connection : { ...connection, apiKey: resolve(key, issuePath) };
  };
  const resolved: FluidcastConfig = {
    ...config,
    languageModel: resolveKey(config.languageModel, 'fluidcast.languageModel.apiKey'),
    ...(config.summaryModel === undefined
      ? {}
      : { summaryModel: resolveKey(config.summaryModel, 'fluidcast.summaryModel.apiKey') }),
    speech: resolveKey(config.speech, 'fluidcast.speech.apiKey'),
  };
  return unset.length === 0 ? { status: 'resolved', config: resolved } : { status: 'unset', unset };
}
