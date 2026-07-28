import {
  createTerminalPresentationController,
  type CreateTerminalPresentationControllerInput,
  type TerminalPresentationController,
} from './controller.js';

/**
 * A terminal that could not be built. `detail` is the raw defect text — a local
 * exception, not a runtime-authored message — and is only ever shown as framed
 * diagnostic detail beneath web-owned copy.
 */
export interface TerminalPresentationFailure {
  readonly detail: string | null;
}

export type TerminalPresentationStart =
  | { readonly status: 'started'; readonly controller: TerminalPresentationController }
  | { readonly status: 'cancelled' }
  | { readonly status: 'failed'; readonly failure: TerminalPresentationFailure };

/**
 * Prepares one cache-owned terminal presentation.
 *
 * Preparation is asynchronous for one reason: xterm measures its cell box once,
 * at construction, against whatever face is loaded at that moment, and it has no
 * font-loading awareness of its own. Building before the terminal face has
 * loaded permanently mis-boxes every glyph, so construction waits behind font
 * readiness — the same contract the disposable command-log renderer follows. The
 * cache entry is already reserved by `beginAttachment()` while this waits, and
 * `abortPreparation()` releases it on either exit that produces no controller.
 *
 * Construction failure is returned, never swallowed: a pane whose session is
 * alive but whose terminal did not build has to say so and offer a retry.
 */
export async function startTerminalPresentation(
  input: CreateTerminalPresentationControllerInput & {
    /** True once this attempt has been superseded by a newer attachment request. */
    readonly isCancelled: () => boolean;
  },
): Promise<TerminalPresentationStart> {
  await input.environment.fontsReady();
  if (input.isCancelled()) {
    input.attachment.abortPreparation();
    return { status: 'cancelled' };
  }

  try {
    return { status: 'started', controller: createTerminalPresentationController(input) };
  } catch (error) {
    input.attachment.abortPreparation();
    return { status: 'failed', failure: { detail: failureDetail(error) } };
  }
}

function failureDetail(error: unknown): string | null {
  const detail = error instanceof Error ? error.message : String(error);
  return detail.trim() || null;
}
