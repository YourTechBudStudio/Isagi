/** The one cookie the runtime sets: the browser's signed login (`credentials.ts` signs and verifies its value). */
export const sessionCookieName = 'isagi_session';

const sessionAttributes = 'Path=/; HttpOnly; SameSite=Lax';

/** The first value of `name` in a `Cookie` header. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=');
    if (separator === -1) continue;
    if (pair.slice(0, separator).trim() === name) return pair.slice(separator + 1).trim();
  }
  return undefined;
}

/** The `Cookie` header without `isagi_session`; undefined when nothing remains. Other cookies pass unchanged. */
export function stripSessionCookie(header: string): string | undefined {
  const kept = header
    .split(';')
    .map((pair) => pair.trim())
    .filter((pair) => pair !== '' && pair.split('=', 1)[0]!.trim() !== sessionCookieName);
  return kept.length === 0 ? undefined : kept.join('; ');
}

/** A persistent login cookie for a week. No `Secure`: a tailnet runtime may be reached over plain HTTP (F3). */
export function sessionSetCookie(value: string): string {
  return `${sessionCookieName}=${value}; Max-Age=604800; ${sessionAttributes}`;
}

/** Clears this browser's login cookie (`auth.logout`). */
export const clearedSessionSetCookie = `${sessionCookieName}=; Max-Age=0; ${sessionAttributes}`;
