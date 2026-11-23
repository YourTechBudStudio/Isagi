type NavigatorWithUaData = Navigator & {
  userAgentData?: { platform?: string };
};

/**
 * Whether the client runs on macOS: the one platform check for keyboard handling (the `Mod`
 * modifier of app shortcuts, the terminal copy chord) and hints.
 */
export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') {
    return false;
  }

  const nav = navigator as NavigatorWithUaData;
  const platform = nav.userAgentData?.platform ?? nav.platform ?? '';

  return /mac/i.test(platform);
}

/**
 * The platform's modifier glyph for keyboard hints: `⌘` on macOS, `Ctrl`
 * elsewhere. Mirrors the `Mod` abstraction used for shortcuts (`Mod+K`, etc.).
 */
export const modKey: string = isMacPlatform() ? '⌘' : 'Ctrl';
