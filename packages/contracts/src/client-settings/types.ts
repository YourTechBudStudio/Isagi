import { Schema } from 'effect';

export const terminalSettingsDefaults = {
  scrollbackLines: 5_000,
  cache: {
    idleTtlMinutes: 180,
    maxHiddenSessions: 4,
    maxEstimatedBufferMiB: 64,
  },
} as const;

export const terminalSettingsBounds = {
  scrollbackLines: { minimum: 0, maximum: 100_000 },
  cache: {
    idleTtlMinutes: { minimum: 0, maximum: 10_080 },
    maxHiddenSessions: { minimum: 0, maximum: 32 },
    maxEstimatedBufferMiB: { minimum: 0, maximum: 2_048 },
  },
} as const;

function boundedInteger(minimum: number, maximum: number) {
  return Schema.Number.pipe(Schema.int(), Schema.between(minimum, maximum));
}

export const terminalCacheSettingsSchema = Schema.Struct({
  idleTtlMinutes: boundedInteger(
    terminalSettingsBounds.cache.idleTtlMinutes.minimum,
    terminalSettingsBounds.cache.idleTtlMinutes.maximum,
  ),
  maxHiddenSessions: boundedInteger(
    terminalSettingsBounds.cache.maxHiddenSessions.minimum,
    terminalSettingsBounds.cache.maxHiddenSessions.maximum,
  ),
  maxEstimatedBufferMiB: boundedInteger(
    terminalSettingsBounds.cache.maxEstimatedBufferMiB.minimum,
    terminalSettingsBounds.cache.maxEstimatedBufferMiB.maximum,
  ),
});

export const terminalSettingsSchema = Schema.Struct({
  scrollbackLines: boundedInteger(
    terminalSettingsBounds.scrollbackLines.minimum,
    terminalSettingsBounds.scrollbackLines.maximum,
  ),
  cache: terminalCacheSettingsSchema,
});

export const clientSettingsOutputSchema = Schema.Struct({
  terminal: terminalSettingsSchema,
});

export type TerminalCacheSettings = Schema.Schema.Type<typeof terminalCacheSettingsSchema>;
export type TerminalSettings = Schema.Schema.Type<typeof terminalSettingsSchema>;
export type ClientSettingsOutput = Schema.Schema.Type<typeof clientSettingsOutputSchema>;
