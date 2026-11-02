import { createHmac, timingSafeEqual } from 'node:crypto';

import { Redacted } from 'effect';

export const sessionMaxAgeSeconds = 7 * 24 * 60 * 60;
export const sessionRenewAfterSeconds = 24 * 60 * 60;
/** Clock skew tolerated for an issue time in the future. */
const futureToleranceSeconds = 60;

const sessionVersion = 'v1';

function sessionMac(secret: Redacted.Redacted<string>, issuedAtSeconds: number): Buffer {
  return createHmac('sha256', Redacted.value(secret))
    .update(`${sessionVersion}.${issuedAtSeconds}`)
    .digest();
}

/** `v1.<issuedAt>.<base64url HMAC-SHA256(secret, "v1.<issuedAt>")>`: no username, password or fingerprint. */
export function signSession(secret: Redacted.Redacted<string>, issuedAtSeconds: number): string {
  return `${sessionVersion}.${issuedAtSeconds}.${sessionMac(secret, issuedAtSeconds).toString('base64url')}`;
}

export type SessionCheck =
  | { readonly _tag: 'valid'; readonly renew: boolean }
  | { readonly _tag: 'invalid' };

const sessionPattern = /^v1\.(\d{1,12})\.([A-Za-z0-9_-]+)$/;

/**
 * Valid when the MAC matches (constant time over equal-length digests), the cookie is younger than a week and its issue
 * time is at most a minute ahead. `renew` once it is older than a day.
 */
export function verifySession(
  secret: Redacted.Redacted<string>,
  value: string,
  nowSeconds: number,
): SessionCheck {
  const match = sessionPattern.exec(value);
  if (match === null) return { _tag: 'invalid' };
  const issuedAt = Number(match[1]);
  const given = Buffer.from(match[2]!, 'base64url');
  const expected = sessionMac(secret, issuedAt);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { _tag: 'invalid' };
  }
  const age = nowSeconds - issuedAt;
  if (age >= sessionMaxAgeSeconds || age < -futureToleranceSeconds) return { _tag: 'invalid' };
  return { _tag: 'valid', renew: age > sessionRenewAfterSeconds };
}

/** The token of an `Authorization: Bearer <t>` header; undefined for any other scheme or an empty token. */
export function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header);
  return match === null ? undefined : match[1];
}

/**
 * Constant-time equality of two strings of any length: both are HMAC'd under `key` (a per-process random key), then
 * the fixed-length digests are compared with `timingSafeEqual`.
 */
export function sameSecret(key: Buffer, left: string, right: string): boolean {
  const digest = (text: string) => createHmac('sha256', key).update(text).digest();
  return timingSafeEqual(digest(left), digest(right));
}
