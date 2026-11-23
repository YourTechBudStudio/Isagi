import { Schema } from 'effect';

import { appearanceSettingsDefaults, type AppearanceSettings } from '../contracts/index.js';
import { runtimeAppearanceSettingsSchema } from './config-schema.js';
import { schemaIssuePaths } from './issue-paths.js';

/**
 * The `appearance` section of a parsed `config.yaml` value with its defaults applied. A missing
 * section is the defaults; an invalid one is `invalid` with its issue paths, and each caller decides
 * what that means (the runtime refuses to start, the desktop paints the defaults).
 */
export function parseAppearance(
  value: unknown,
):
  | { readonly status: 'decoded'; readonly appearance: AppearanceSettings }
  | { readonly status: 'invalid'; readonly issuePaths: ReadonlyArray<string> } {
  if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, 'appearance')) {
    return { status: 'decoded', appearance: appearanceSettingsDefaults };
  }
  const decoded = Schema.decodeUnknownExit(runtimeAppearanceSettingsSchema)(value.appearance);
  if (decoded._tag === 'Failure') {
    return { status: 'invalid', issuePaths: schemaIssuePaths(decoded.cause, ['appearance']) };
  }
  return {
    status: 'decoded',
    appearance: { theme: decoded.value.theme ?? appearanceSettingsDefaults.theme },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
