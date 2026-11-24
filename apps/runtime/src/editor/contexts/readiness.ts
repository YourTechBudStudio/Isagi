import http from 'node:http';

import { Context, Duration, Effect } from 'effect';

import { editorUpstreamHost, editorUpstreamOrigin } from './launch-spec.js';

/**
 * Runs one incarnation's readiness probe and reports its settlement through `onSettled`. Never fails; it ends by
 * settling or by interruption.
 */
export type EditorProbeRunner = (input: {
  /** The incarnation's HTTP listen socket. */
  readonly socketPath: string;
  readonly onSettled: (settlement: EditorReadinessSettlement) => Effect.Effect<void>;
}) => Effect.Effect<void>;

/**
 * The probe the editor context service forks for every incarnation it launches: the real HTTP probe by default.
 *
 * A seam for the whole probe, not its HTTP internals. Service tests care about probe *lifecycle* — registered before
 * start, ended by supersession or a terminal event, cleaned up at shutdown — and replacing the runner keeps them from
 * also asserting the HTTP polling behaviour that `readiness.test.ts` owns. A test that wants the real probe on a
 * scripted transport provides a runner that calls `probeWorkbench` with its own `request` and `timing`.
 */
export const EditorReadinessProbe = Context.Reference<{ readonly run: EditorProbeRunner }>(
  'isagi/runtime/editor/EditorReadinessProbe',
  { defaultValue: () => ({ run: (input) => probeWorkbench(input) }) },
);

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
  /** A 3xx whose `Location` left the incarnation's own origin. */
  | { readonly kind: 'redirected_away' }
  | { readonly kind: 'marker_absent' }
  | { readonly kind: 'timed_out' }
  | { readonly kind: 'no_response' };

export type EditorProbeRequest = (input: {
  readonly socketPath: string;
  /** The request path, from the incarnation's root. */
  readonly path: string;
  /** Stage 2 only: the response must be HTML *and* carry the workbench marker. */
  readonly requireMarker: boolean;
}) => Effect.Effect<EditorProbeOutcome>;

export interface EditorReadinessSettlement {
  readonly state: 'ready' | 'unreachable';
  readonly detail: string | null;
}

/**
 * Poll one incarnation's listen socket until the workbench answers, or until
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
  readonly socketPath: string;
  readonly onSettled: (settlement: EditorReadinessSettlement) => Effect.Effect<void>;
  readonly request?: EditorProbeRequest | undefined;
  readonly timing?: Partial<EditorProbeTiming> | undefined;
}): Effect.Effect<void> {
  const timing = { ...editorProbeTiming, ...input.timing };
  const request = input.request ?? defaultEditorProbeRequest;

  // The furthest stage reached and what last happened there. Read only after the
  // loop has ended, to compose the settled detail.
  let stage: EditorProbeStage = 'healthz';
  let lastOutcome: EditorProbeOutcome = { kind: 'no_response' };

  const attempt = Effect.suspend(() =>
    request({
      socketPath: input.socketPath,
      path: stage === 'healthz' ? '/healthz' : '/',
      requireMarker: stage === 'workbench',
    }).pipe(
      // The per-request bound lives here rather than inside the request, so the
      // default implementation carries no timing of its own and every stub
      // inherits the same cancellation. Timing out interrupts the request, which
      // aborts its signal.
      Effect.timeoutOrElse({
        duration: Duration.millis(timing.requestTimeoutMs),
        orElse: () => Effect.succeed<EditorProbeOutcome>({ kind: 'timed_out' }),
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
    Effect.map((): EditorReadinessSettlement => ({
      state: 'ready',
      detail: null,
    })),
    Effect.timeoutOrElse({
      duration: Duration.millis(timing.deadlineMs),
      // Evaluated only when the deadline fires, so it reads the furthest stage
      // and last outcome reached at that moment.
      orElse: () =>
        Effect.sync((): EditorReadinessSettlement => ({
          state: 'unreachable',
          detail: describeUnreachable({
            socketPath: input.socketPath,
            stage,
            outcome: lastOutcome,
            deadlineMs: timing.deadlineMs,
          }),
        })),
    }),
    Effect.flatMap(input.onSettled),
  );
}

/**
 * The settled diagnostic, rendered verbatim to a user as evidence.
 *
 * Every component is authored by this codebase: the socket path is the one we
 * chose and Code Server listens on, the stage is a two-member literal, and the outcome is
 * a closed union. Nothing from a foreign error, a response header, or a response
 * body appears — which is the whole reason the outcome union exists instead of a
 * caught error being formatted here.
 */
export function describeUnreachable(input: {
  readonly socketPath: string;
  readonly stage: EditorProbeStage;
  readonly outcome: EditorProbeOutcome;
  readonly deadlineMs: number;
}): string {
  return [
    input.socketPath,
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
    case 'redirected_away':
      return 'redirected off its own origin';
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
 * The maximum redirects the probe will follow. Code Server needs exactly one;
 * the bound exists so a misconfigured workbench cannot turn readiness into an
 * unbounded walk inside a request that already has its own timeout.
 */
const maxProbeRedirects = 3;

/**
 * The real HTTP probe, over the incarnation's listen socket.
 *
 * Every request names `editorUpstreamHost`, the authority the proxy presents
 * too, and redirects are never followed blindly: readiness is a statement about
 * this incarnation, and a followed redirect could otherwise satisfy the check
 * from somewhere else entirely. Redirects are followed by hand, but only while
 * they stay on the upstream origin — a `Location` that leaves it settles as
 * `redirected_away` rather than being chased.
 *
 * Following at all is required, not a convenience. Code Server answers `GET /`
 * with a same-origin 302 to `?folder=…` whenever a folder was given on the
 * command line and the query carries none, which every Isagi launch does. The
 * pane's iframe follows that redirect like any browser, so a probe that refused
 * to would report `unreachable` for a workbench the user can see working.
 *
 * The body is never accumulated and never retained. Stage 2 searches the
 * decoded stream with a rolling overlap so a marker split across chunks still
 * matches, and stops reading as soon as it does.
 */
export const defaultEditorProbeRequest: EditorProbeRequest = ({
  socketPath,
  path,
  requireMarker,
}) =>
  Effect.tryPromise({
    try: async (signal): Promise<EditorProbeOutcome> => {
      let target = path;

      for (let hop = 0; ; hop += 1) {
        const response = await probeGet({ socketPath, path: target, signal });
        const status = response.statusCode ?? 0;

        if (status >= 300 && status < 400) {
          const location = response.headers.location;
          response.destroy();
          if (!location || hop >= maxProbeRedirects) {
            return { kind: 'http_status', status };
          }
          let next;
          try {
            next = new URL(location, `${editorUpstreamOrigin}${target}`);
          } catch {
            // An unparseable `Location` is the server's answer being unusable,
            // not a transport fault; the status is the honest report.
            return { kind: 'http_status', status };
          }
          // The whole point of following by hand: readiness may only ever be
          // satisfied by this incarnation.
          if (next.origin !== editorUpstreamOrigin) return { kind: 'redirected_away' };
          target = `${next.pathname}${next.search}`;
          continue;
        }

        if (status < 200 || status >= 300) {
          response.destroy();
          return { kind: 'http_status', status };
        }
        if (!requireMarker) {
          response.destroy();
          return { kind: 'ok' };
        }
        const contentType = response.headers['content-type'];
        if (!contentType?.toLowerCase().includes('text/html')) {
          response.destroy();
          // The header value itself is never rendered; that it was not HTML is the
          // whole fact.
          return { kind: 'not_html' };
        }
        return (await bodyContainsMarker(response)) ? { kind: 'ok' } : { kind: 'marker_absent' };
      }
    },
    // The rejection is never inspected. A transport failure carries platform
    // detail, and reading it would make this a second redaction policy.
    catch: (): EditorProbeOutcome => ({ kind: 'no_response' }),
  }).pipe(Effect.catch(Effect.succeed));

/** One GET over the socket, resolving with the response head; aborting the signal destroys the request. */
function probeGet(input: {
  readonly socketPath: string;
  readonly path: string;
  readonly signal: AbortSignal;
}): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      socketPath: input.socketPath,
      path: input.path,
      method: 'GET',
      headers: { host: editorUpstreamHost },
      agent: false,
      signal: input.signal,
    });
    request.on('response', resolve);
    request.on('error', reject);
    request.end();
  });
}

async function bodyContainsMarker(response: http.IncomingMessage): Promise<boolean> {
  // Streaming decode, because the marker is ASCII but the surrounding document
  // is not guaranteed to be: decoding each chunk independently could corrupt a
  // code point split across a chunk boundary and, with it, the overlap.
  const decoder = new TextDecoder('utf-8');
  const overlapLength = EDITOR_WORKBENCH_MARKER.length - 1;
  let overlap = '';
  try {
    for await (const chunk of response) {
      const window = overlap + decoder.decode(chunk as Buffer, { stream: true });
      if (window.includes(EDITOR_WORKBENCH_MARKER)) return true;
      overlap = window.slice(-overlapLength);
    }
    return (overlap + decoder.decode()).includes(EDITOR_WORKBENCH_MARKER);
  } finally {
    // Stops reading as soon as the answer is known; a no-op once the body ended.
    response.destroy();
  }
}
