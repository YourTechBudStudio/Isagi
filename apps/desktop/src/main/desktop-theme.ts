// The theme the window paints before the runtime answers: `appearance.theme` from the same `config.yaml` the managed
// runtime will read, through the one shared reader. Read synchronously, before the window exists.
import { appearanceSettingsDefaults, type AppearanceTheme } from '@isagi/shared/contracts';
import { parseAppearance, readGlobalConfig } from '@isagi/shared/global-config';

/**
 * The configured theme, or the default when the file is missing, unreadable, not YAML, or its `appearance` section is
 * invalid. The desktop never reports those: the runtime owns the message (the web UI's `config_invalid` view), so a
 * broken config costs the loader only its theme.
 */
export function readDesktopTheme(
  dataDirectory: string,
  read: typeof readGlobalConfig = readGlobalConfig,
): AppearanceTheme {
  const file = read(dataDirectory);
  if (file.status !== 'loaded') return appearanceSettingsDefaults.theme;
  const appearance = parseAppearance(file.value);
  return appearance.status === 'decoded'
    ? appearance.appearance.theme
    : appearanceSettingsDefaults.theme;
}

/** The window's background for `theme`: the web canvas colour, generated into the loader build from `styles.css`. */
export function windowBackgroundColor(
  backgrounds: Readonly<Record<AppearanceTheme, string>>,
  theme: AppearanceTheme,
): string {
  return backgrounds[theme];
}
