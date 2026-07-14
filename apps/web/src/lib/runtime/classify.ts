import type { ApiError } from '@isagi/contracts';

import { RuntimeApiError, RuntimeDecodeError, RuntimeTransportError } from './errors.js';
import { unwrapRuntimeFailure } from './run.js';

/**
 * A runtime-client failure reduced to the shape the UI reasons about. This is the
 * single authoritative classification of a rejected runtime effect; both the
 * runtime-error copy layer and the palette workflow-failure adapter consume it so
 * the `unwrap → instanceof` ladder lives in exactly one place.
 */
export type ClassifiedRuntimeFailure =
  | { readonly kind: 'api'; readonly apiError: ApiError }
  | { readonly kind: 'transport' }
  | { readonly kind: 'decode'; readonly endpointId: string }
  | { readonly kind: 'unknown' };

/**
 * Classify a thrown/rejected runtime failure. Unwraps an Effect fiber-failure
 * wrapper first, so callers may pass either the raw class instance or a
 * `runPromiseExit`/`FiberFailure`-wrapped value. An already-unwrapped value is
 * returned by `unwrapRuntimeFailure` unchanged, so a second unwrap is harmless.
 */
export function classifyRuntimeFailure(error: unknown): ClassifiedRuntimeFailure {
  const failure = unwrapRuntimeFailure(error);
  if (failure instanceof RuntimeApiError) {
    return { kind: 'api', apiError: failure.apiError };
  }
  if (failure instanceof RuntimeTransportError) {
    return { kind: 'transport' };
  }
  if (failure instanceof RuntimeDecodeError) {
    return { kind: 'decode', endpointId: failure.endpointId };
  }
  return { kind: 'unknown' };
}
