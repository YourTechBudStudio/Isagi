import type { Page } from '@playwright/test';

/**
 * The client platforms app shortcuts are specified for. Isagi and xterm both read the platform from
 * `navigator` (`userAgentData.platform`, then `platform`), so emulating it is enough for every
 * keyboard decision to take that platform's path; the engine stays the host's Chromium.
 */
export const clientPlatforms = [
  { name: 'Linux', mod: 'Control', platform: 'Linux x86_64', uaPlatform: 'Linux' },
  { name: 'macOS', mod: 'Meta', platform: 'MacIntel', uaPlatform: 'macOS' },
] as const;

export type ClientPlatform = (typeof clientPlatforms)[number];

/** Emulate `client` in every frame of `page`, before any page script runs. Call before `goto`. */
export async function emulateClientPlatform(page: Page, client: ClientPlatform) {
  await page.addInitScript(
    ({ platform, uaPlatform }) => {
      Object.defineProperty(Navigator.prototype, 'platform', {
        get: () => platform,
        configurable: true,
      });
      Object.defineProperty(Navigator.prototype, 'userAgentData', {
        get: () => ({ platform: uaPlatform }),
        configurable: true,
      });
    },
    { platform: client.platform, uaPlatform: client.uaPlatform },
  );
}

/** The control byte a Ctrl+letter chord sends to a PTY (^K is `\x0b`). */
export const controlByte = (letter: string) =>
  String.fromCharCode(letter.toLowerCase().charCodeAt(0) - 96);
