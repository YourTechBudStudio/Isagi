type NavigatorWithUaData = Navigator & {
  userAgentData?: { platform?: string };
};

function detectIsMac(): boolean {
  if (typeof navigator === 'undefined') {
    return false;
  }

  const nav = navigator as NavigatorWithUaData;
  const platform = nav.userAgentData?.platform ?? nav.platform ?? '';

  return /mac/i.test(platform);
}

export function isPlatformModifierShortcut(event: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey'>) {
  return detectIsMac() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

/**
 * The platform's modifier glyph for keyboard hints: `⌘` on macOS, `Ctrl`
 * elsewhere. Mirrors the `Mod` abstraction used for shortcuts (`Mod+K`, etc.).
 */
export const modKey: string = detectIsMac() ? '⌘' : 'Ctrl';
