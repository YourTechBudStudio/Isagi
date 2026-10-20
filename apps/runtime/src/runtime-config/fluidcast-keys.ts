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
  const languageModelKey = config.languageModel.apiKey;
  const resolved: FluidcastConfig = {
    ...config,
    languageModel: {
      ...config.languageModel,
      ...(languageModelKey === undefined
        ? {}
        : { apiKey: resolve(languageModelKey, 'fluidcast.languageModel.apiKey') }),
    } as FluidcastConfig['languageModel'],
    speech: { ...config.speech, apiKey: resolve(config.speech.apiKey, 'fluidcast.speech.apiKey') },
  };
  return unset.length === 0 ? { status: 'resolved', config: resolved } : { status: 'unset', unset };
}
