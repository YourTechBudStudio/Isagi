import { Duration, Effect } from 'effect';

import { editorOrigin } from './launch-spec.js';

/**
 * The string a served Code Server workbench document contains.
 *
 * `/healthz` answering proves the server process is up; it does not prove the
 * workbench itself was served, which is what the pane is about to frame. This
 * marker is the cheapest signal that it was.
 *
 * It lives in exactly one place so a version bump has one edit site. A wrong
 * marker fails closed — a working editor reads as `unreachable` — which is why
 * confirming it against the pinned release is a provisioning-time obligation
 * rather than something to infer.
 */
export const EDITOR_WORKBENCH_MARKER = 'vscode-workbench-web-configuration';

/**
 * Deliberately tunable, because only the deadline's *existence* is a
 * requirement. The pane must always reach a settled state; how quickly it gets
 * there is a judgement call, and tests need to make it instant.
 */
export interface EditorProbeTiming {
  /** Code Server is never up sooner than this, so a first attempt at t=0 is waste. */
  readonly initialDelayMs: number;
  readonly intervalMs: number;
  readonly requestTimeoutMs: number;
  readonly deadlineMs: number;
}

export const editorProbeTiming: EditorProbeTiming = {
  initialDelayMs: 250,
  intervalMs: 500,
  requestTimeoutMs: 2_000,
  deadlineMs: 60_000,
};

export type EditorProbeStage = 'healthz' | 'workbench';

/**
 * What one request established, in this domain's own closed vocabulary.
 *
 * Every member is authored here. Nothing derived from a foreign error, a
 * response header value, or a response body ever becomes one of these, which is
 * what lets the settled detail be rendered verbatim to a user.
 */
export type EditorProbeOutcome =
  | { readonly kind: 'ok' }
  | { readonly kind: 'http_status'; readonly status: number }
  | { readonly kind: 'not_html' }
  | { readonly kind: 'marker_absent' }
  | { readonly kind: 'timed_out' }
  | { readonly kind: 'no_response' };

export type EditorProbeRequest = (input: {
  readonly url: string;
  /** Stage 2 only: the response must be HTML *and* carry the workbench marker. */
  readonly requireMarker: boolean;
}) => Effect.Effect<EditorProbeOutcome>;

export interface EditorReadinessSettlement {
  readonly state: 'ready' | 'unreachable';
  readonly detail: string | null;
}

/**
 * Poll one incarnation's loopback origin until the workbench answers, or until
 * the deadline says it never will.
 *
 * Two properties make this safe to fork and forget. It always settles — there is
 * no path that polls forever, so the pane never shows an indefinite spinner. And
 * it is fully interruptible: supersession, the incarnation's own terminal PTY
 * event, and layer shutdown all end it by interruption, and an interrupted probe
 * writes no observation at all rather than a half-formed one.
 *
 * Stage progression is monotonic. Once `/healthz` has answered, the process is
 * up and every subsequent attempt asks the workbench question; re-asking the
 * health question would throw away the fact just established, and the settled
 * detail would then name the wrong stage.
 */
export function probeWorkbench(input: {
  readonly host: string;
  readonly port: number;
  readonly onSettled: (settlement: EditorReadinessSettlement) => Effect.Effect<void>;
  readonly request?: EditorProbeRequest | undefined;
  readonly timing?: Partial<EditorProbeTiming> | undefined;
}): Effect.Effect<void> {
  const timing = { ...editorProbeTiming, ...input.timing };
  const request = input.request ?? defaultEditorProbeRequest;
  const origin = editorOrigin(input.host, input.port);

  // The furthest stage reached and what last happened there. Read only after the
  // loop has ended, to compose the settled detail.
  let stage: EditorProbeStage = 'healthz';
  let lastOutcome: EditorProbeOutcome = { kind: 'no_response' };

  const attempt = Effect.suspend(() =>
    request({
      url: stage === 'healthz' ? `${origin}/healthz` : `${origin}/`,
      requireMarker: stage === 'workbench',
    }).pipe(
      // The per-request bound lives here rather than inside the request, so the
      // default implementation carries no timing of its own and every stub
      // inherits the same cancellation. Timing out interrupts the request, which
      // aborts its signal.
      Effect.timeoutTo({
        duration: Duration.millis(timing.requestTimeoutMs),
        onTimeout: (): EditorProbeOutcome => ({ kind: 'timed_out' }),
        onSuccess: (outcome): EditorProbeOutcome => outcome,
      }),
    ),
  );

  const poll = Effect.gen(function* () {
    yield* Effect.sleep(Duration.millis(timing.initialDelayMs));
    for (;;) {
      const outcome = yield* attempt;
      lastOutcome = outcome;
      if (outcome.kind === 'ok') {
        if (stage === 'workbench') return;
        // Health answered: advance and ask the workbench question immediately
        // rather than spending an interval re-asking a settled one.
        stage = 'workbench';
        continue;
      }
      yield* Effect.sleep(Duration.millis(timing.intervalMs));
    }
  });

  return poll.pipe(
    // The deadline wraps the initial delay, the schedule, both stages, and any
    // request in flight.
    Effect.timeoutTo({
      duration: Duration.millis(timing.deadlineMs),
      onTimeout: (): EditorReadinessSettlement => ({
        state: 'unreachable',
        detail: describeUnreachable({
          host: input.host,
          port: input.port,
          stage,
          outcome: lastOutcome,
          deadlineMs: timing.deadlineMs,
        }),
      }),
      onSuccess: (): EditorReadinessSettlement => ({
        state: 'ready',
        detail: null,
      }),
    }),
    Effect.flatMap(input.onSettled),
  );
}

/**
 * The settled diagnostic, rendered verbatim to a user as evidence.
 *
 * Every component is authored by this codebase: the host and port are the values
 * we allocated and bound, the stage is a two-member literal, and the outcome is
 * a closed union. Nothing from a foreign error, a response header, or a response
 * body appears — which is the whole reason the outcome union exists instead of a
 * caught error being formatted here.
 */
export function describeUnreachable(input: {
  readonly host: string;
  readonly port: number;
  readonly stage: EditorProbeStage;
  readonly outcome: EditorProbeOutcome;
  readonly deadlineMs: number;
}): string {
  return [
    `${input.host}:${input.port}`,
    input.stage,
    describeOutcome(input.outcome),
    `gave up after ${Math.round(input.deadlineMs / 1_000)}s`,
  ].join(' · ');
}

function describeOutcome(outcome: EditorProbeOutcome): string {
  switch (outcome.kind) {
    case 'ok':
      return 'ok';
    case 'http_status':
      return `http ${outcome.status}`;
    case 'not_html':
      return 'not html';
    case 'marker_absent':
      return 'marker absent';
    // Our own timer, so naming it precisely is a fact we own rather than one
    // read off a foreign error.
    case 'timed_out':
      return 'request timed out';
    // Every opaque transport failure collapses here. Reaching an errno would
    // mean walking a foreign error's cause chain, which is exactly the
    // property reader the runtime's redaction policy refuses.
    case 'no_response':
      return 'no response';
  }
}

/**
 * The real HTTP probe.
 *
 * `redirect: 'manual'` because readiness is a statement about the origin we
 * allocated. Following a redirect could satisfy the check from somewhere else
 * entirely; a 3xx simply fails the 2xx test and is reported as the status it is.
 *
 * The body is never accumulated and never retained. Stage 2 searches the
 * decoded stream with a rolling overlap so a marker split across chunks still
 * matches, and stops reading as soon as it does.
 */
export const defaultEditorProbeRequest: EditorProbeRequest = ({ url, requireMarker }) =>
  Effect.tryPromise({
    try: async (signal): Promise<EditorProbeOutcome> => {
      const response = await fetch(url, { signal, redirect: 'manual' });
      if (response.status < 200 || response.status >= 300) {
        await discardBody(response);
        return { kind: 'http_status', status: response.status };
      }
      if (!requireMarker) {
        await discardBody(response);
        return { kind: 'ok' };
      }
      const contentType = response.headers.get('content-type');
      if (!contentType?.toLowerCase().includes('text/html')) {
        await discardBody(response);
        // The header value itself is never rendered; that it was not HTML is the
        // whole fact.
        return { kind: 'not_html' };
      }
      return (await bodyContainsMarker(response)) ? { kind: 'ok' } : { kind: 'marker_absent' };
    },
    // The rejection is never inspected. `fetch` rejects with a foreign error
    // whose cause carries platform detail, and reading either would make this a
    // second redaction policy.
    catch: (): EditorProbeOutcome => ({ kind: 'no_response' }),
  }).pipe(Effect.merge);

/** Drain rather than leak the socket; the status is the whole payload we needed. */
async function discardBody(response: Response): Promise<void> {
  await response.body?.cancel();
}

async function bodyContainsMarker(response: Response): Promise<boolean> {
  if (!response.body) return false;
  const reader = response.body.getReader();
  // Streaming decode, because the marker is ASCII but the surrounding document
  // is not guaranteed to be: decoding each chunk independently could corrupt a
  // code point split across a chunk boundary and, with it, the overlap.
  const decoder = new TextDecoder('utf-8');
  const overlapLength = EDITOR_WORKBENCH_MARKER.length - 1;
  let overlap = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return (overlap + decoder.decode()).includes(EDITOR_WORKBENCH_MARKER);
      const window = overlap + decoder.decode(value, { stream: true });
      if (window.includes(EDITOR_WORKBENCH_MARKER)) {
        // Cancel through the reader: the body is locked while we hold one, so
        // cancelling the stream itself would fail.
        await reader.cancel();
        return true;
      }
      overlap = window.slice(-overlapLength);
    }
  } finally {
    reader.releaseLock();
  }
}
