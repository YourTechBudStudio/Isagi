/**
 * The text of a request body a `fetch` stub received. The runtime client hands `fetch` its JSON as
 * UTF-8 bytes (`effect/http` encodes the body before sending), so `String(body)` would read the byte
 * list rather than the JSON text.
 */
export function requestBodyText(body: BodyInit | null | undefined): string | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  throw new Error(
    `A fixture fetch stub cannot read a ${Object.prototype.toString.call(body)} body.`,
  );
}
