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
  return Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum, maximum }));
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

/** The Catppuccin flavor the client paints with: Macchiato for `dark`, Latte for `light`. */
export const appearanceThemeSchema = Schema.Literals(['dark', 'light']);

/**
 * The default foreground and background each appearance theme paints a terminal with, as `#rrggbb`.
 * The web terminal reads them from `--color-fg` and `--color-terminal-surface` in `apps/web/src/styles.css`
 * (a web test keeps the two equal); the runtime uses them to answer a program's colour queries
 * (OSC 10/11) itself, so the answer is the same whether or not a terminal pane is attached.
 */
export const terminalPalette = {
  dark: { foreground: '#cad3f5', background: '#2d3145' },
  light: { foreground: '#4c4f69', background: '#eff1f5' },
} as const satisfies Record<typeof appearanceThemeSchema.Type, TerminalPaletteEntry>;

export interface TerminalPaletteEntry {
  readonly foreground: string;
  readonly background: string;
}

export const appearanceSettingsDefaults = { theme: 'light' } as const;

export const appearanceSettingsSchema = Schema.Struct({
  theme: appearanceThemeSchema,
});

export const clientSettingsOutputSchema = Schema.Struct({
  terminal: terminalSettingsSchema,
  appearance: appearanceSettingsSchema,
});

export type TerminalCacheSettings = typeof terminalCacheSettingsSchema.Type;
export type TerminalSettings = typeof terminalSettingsSchema.Type;
export type AppearanceTheme = typeof appearanceThemeSchema.Type;
export type AppearanceSettings = typeof appearanceSettingsSchema.Type;
export type ClientSettingsOutput = typeof clientSettingsOutputSchema.Type;
