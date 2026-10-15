import type { Session } from '@yourtechbudstudio/fluidcast-harness';
import {
  Command,
  CommandRejected,
  SubscriptionMessage,
  ToolCommandRejected,
} from '@yourtechbudstudio/fluidcast-harness/protocol';
import { Effect, Fiber, Schema, Stream } from 'effect';

import type {
  ControlPlaneSnapshot,
  SurfaceDetail,
  SurfacePane,
  WorkspaceSnapshot,
} from '@isagi/contracts';

import { requestBodyText } from '../request-body.js';
import { buildHarnessSession } from './harness-sessions.js';

/**
 * The runtime end of the Fluidcast pane harness: a `fetch` stub over real in-page Harness sessions.
 * The page mounts the production `Surface`, `FluidcastPane`, connection, presentation pause and
 * runtime client; only the runtime process is replaced, and only its model and voice are fake.
 *
 * Surface 41 holds two Fluidcast panes (sessions A and B); surface 42 holds one empty pane, so a
 * surface switch hides both sessions at once.
 */

export const RUNTIME_ORIGIN = 'http://fluidcast-test-support.invalid';
export const WORKTREE_ID = 12;
export const FLUIDCAST_SURFACE_ID = 41;
export const OTHER_SURFACE_ID = 42;
export const PANE_A = 71;
export const PANE_B = 72;
export const OTHER_PANE = 73;
export const SESSION_A = 'fc-session-a';
export const SESSION_B = 'fc-session-b';

export interface RecordedCommand {
  readonly fluidcastSessionId: string;
  readonly tag: string;
  /** `performance.now()` when the command reached the fake runtime. */
  readonly at: number;
  /** When its answer went back; a delayed `Pause` lands later than it arrived. */
  settledAt?: number;
  readonly outcome?: 'applied' | 'rejected' | 'failed';
}

export interface RecordedSubscription {
  readonly fluidcastSessionId: string;
  readonly at: number;
}

export interface FluidcastRuntimeControls {
  readonly commands: () => readonly RecordedCommand[];
  readonly subscriptions: () => readonly RecordedSubscription[];
  /** Speech fetches, for diagnostics only: the player may legitimately prefetch. */
  readonly speechRequests: () => readonly string[];
  /** Hold every later `Pause` this long before applying it. */
  readonly delayPauses: (ms: number) => void;
  /** Answer every later `Pause` with a runtime failure instead of applying it. */
  readonly failPauses: (fail: boolean) => void;
  /** The session's paused flag as the Harness holds it. */
  readonly paused: (fluidcastSessionId: string) => Promise<boolean>;
}

const encodeMessage = Schema.encodeSync(SubscriptionMessage);
const decodeCommand = Schema.decodeUnknownSync(Command);
const encodeRejection = Schema.encodeSync(Schema.Union([CommandRejected, ToolCommandRejected]));

export async function installFakeRuntime(): Promise<FluidcastRuntimeControls> {
  const sessions = new Map<string, Session['Service']>([
    [SESSION_A, await buildHarnessSession()],
    [SESSION_B, await buildHarnessSession()],
  ]);
  const commands: RecordedCommand[] = [];
  const subscriptions: RecordedSubscription[] = [];
  const speechRequests: string[] = [];
  let pauseDelay = 0;
  let pauseFails = false;
  // The fake's own view of each session's paused flag, folded from the events it streamed.
  const pausedById = new Map<string, boolean>();

  window.isagi = { getRuntimeUrl: () => Promise.resolve(RUNTIME_ORIGIN) };

  const controls: FluidcastRuntimeControls = {
    commands: () => commands.map((command) => ({ ...command })),
    subscriptions: () => [...subscriptions],
    speechRequests: () => [...speechRequests],
    delayPauses: (ms) => {
      pauseDelay = ms;
    },
    failPauses: (fail) => {
      pauseFails = fail;
    },
    paused: async (id) => pausedById.get(id) ?? false,
  };

  const realFetch = window.fetch.bind(window);

  window.fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      window.location.origin,
    );
    if (url.origin !== RUNTIME_ORIGIN) return realFetch(input as RequestInfo, init);

    const method = init?.method ?? 'GET';
    const path = url.pathname.replace('/api/v1', '');

    if (method === 'GET' && path === '/workspace') return success(workspaceSnapshot());
    if (method === 'GET' && path === '/control-plane') return success(controlPlane());
    if (method === 'GET' && path === '/workspace/durable-sessions') {
      return success({ agentSessions: [], terminalSessions: [] });
    }

    const surface = /^\/surfaces\/(\d+)$/.exec(path);
    if (method === 'GET' && surface) {
      const id = Number(surface[1]);
      if (id === FLUIDCAST_SURFACE_ID) return success(fluidcastSurface());
      if (id === OTHER_SURFACE_ID) return success(otherSurface());
      return failure(404, 'surface_rejected', 'No such surface.', { reason: 'surface_not_found' });
    }

    const route = /^\/fluidcast-sessions\/([^/]+)\/(.+)$/.exec(path);
    const session = route ? sessions.get(decodeURIComponent(route[1]!)) : undefined;
    if (route && !session) {
      return failure(404, 'fluidcast_session_not_found', 'No such session.', {
        fluidcastSessionId: decodeURIComponent(route[1]!),
      });
    }
    if (route && session) {
      const fluidcastSessionId = decodeURIComponent(route[1]!);
      const rest = route[2]!;

      if (method === 'POST' && rest === 'commands') {
        const command = decodeCommand(JSON.parse(requestBodyText(init?.body) ?? 'null'));
        const record: RecordedCommand = {
          fluidcastSessionId,
          tag: command._tag,
          at: performance.now(),
        };
        commands.push(record);
        const settle = (outcome: RecordedCommand['outcome']) => {
          Object.assign(record, { outcome, settledAt: performance.now() });
        };
        if (command._tag === 'Pause') {
          if (pauseDelay > 0) await delay(pauseDelay);
          if (pauseFails) {
            settle('failed');
            return failure(500, 'api_unhandled_error', 'The fixture runtime failed this pause.');
          }
        }
        const exit = await Effect.runPromiseExit(session.command(command));
        if (exit._tag === 'Success') {
          settle('applied');
          return success(null);
        }
        const rejection = exit.cause.reasons.find((reason) => reason._tag === 'Fail');
        settle('rejected');
        return failure(409, 'fluidcast_command_rejected', 'The session refused the command.', {
          rejection: encodeRejection(
            (rejection as { readonly error: CommandRejected | ToolCommandRejected }).error,
          ),
        });
      }

      if (method === 'GET' && rest === 'events') {
        subscriptions.push({ fluidcastSessionId, at: performance.now() });
        return eventStream(
          session.subscribe().pipe(
            Stream.tap((message) =>
              Effect.sync(() => {
                if (message._tag === 'Snapshot') {
                  pausedById.set(fluidcastSessionId, message.state.paused);
                }
                if (message._tag === 'PauseChanged') {
                  pausedById.set(fluidcastSessionId, message.paused);
                }
              }),
            ),
            Stream.map((message) => encodeMessage(message)),
          ),
          init?.signal,
        );
      }
      if (method === 'GET' && rest === 'worker/status') {
        return eventStream(
          Stream.concat(
            Stream.make({ _tag: 'WorkerSummary', status: 'idle', sessionId: 'native-session' }),
            Stream.never,
          ),
          init?.signal,
        );
      }
      if (method === 'GET' && rest === 'worker/transcript') {
        return eventStream(
          Stream.concat(Stream.make({ _tag: 'TranscriptSnapshot', entries: [] }), Stream.never),
          init?.signal,
        );
      }

      const speech = /^speech\/(.+)$/.exec(rest);
      if (method === 'GET' && speech) {
        speechRequests.push(`${fluidcastSessionId}/${decodeURIComponent(speech[1]!)}`);
        const chunks = await Effect.runPromise(
          Stream.runCollect(session.speech(decodeURIComponent(speech[1]!))).pipe(
            Effect.map((collected) => [...collected]),
            Effect.orElseSucceed(() => null),
          ),
        );
        if (chunks === null) return failure(404, 'fluidcast_speech_not_found', 'No such line.');
        return new Response(new Blob(chunks as BlobPart[], { type: 'audio/wav' }), {
          status: 200,
          headers: { 'content-type': 'audio/wav' },
        });
      }
    }

    console.error('[fluidcast test support] no route for', method, path);
    return failure(404, 'api_route_not_found', `No fixture route for ${method} ${path}`);
  };

  return controls;
}

/** A server-sent event stream fed by `stream`, ended when the client aborts. */
function eventStream(stream: Stream.Stream<unknown>, signal: AbortSignal | null | undefined) {
  const encoder = new TextEncoder();
  let fiber: Fiber.Fiber<void> | null = null;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(': open\n\n'));
      fiber = Effect.runFork(
        Stream.runForEach(stream, (value) =>
          Effect.sync(() =>
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`)),
          ),
        ).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              try {
                controller.close();
              } catch {
                // Already cancelled by the reader.
              }
            }),
          ),
        ),
      );
      signal?.addEventListener('abort', () => {
        if (fiber) Effect.runFork(Fiber.interrupt(fiber));
      });
    },
    cancel() {
      if (fiber) Effect.runFork(Fiber.interrupt(fiber));
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function agentPane(id: number, title: string, fluidcastSessionId: string): SurfacePane {
  return {
    id,
    surfaceId: FLUIDCAST_SURFACE_ID,
    title,
    sortOrder: id,
    session: {
      kind: 'agent_session',
      agentSession: {
        id: id + 100,
        paneId: id,
        worktreeId: WORKTREE_ID,
        harness: 'claude',
        cwd: '/work/isagi',
        harnessSessionId: 'native-session',
        statusReason: null,
        recoveryAction: 'connect_existing',
        interaction: { mode: 'fluidcast', fluidcastSessionId },
        status: 'running',
        processIncarnation: null,
        diagnosticCode: null,
        diagnosticDetail: null,
        createdAt: '2026-10-13T09:00:00.000Z',
        updatedAt: '2026-10-13T09:00:00.000Z',
        lastSeenAt: null,
      },
    },
  };
}

function fluidcastSurface(): SurfaceDetail {
  return {
    id: FLUIDCAST_SURFACE_ID,
    worktreeId: WORKTREE_ID,
    title: 'Voice',
    layout: {
      kind: 'split',
      nodeId: 'root',
      axis: 'row',
      sizing: 'auto',
      weights: [0.5, 0.5],
      children: [
        { kind: 'leaf', nodeId: 'a', paneId: PANE_A, collapsed: false },
        { kind: 'leaf', nodeId: 'b', paneId: PANE_B, collapsed: false },
      ],
    },
    activePaneId: PANE_A,
    panes: [
      agentPane(PANE_A, 'claude · voice A', SESSION_A),
      agentPane(PANE_B, 'claude · voice B', SESSION_B),
    ],
  };
}

function otherSurface(): SurfaceDetail {
  return {
    id: OTHER_SURFACE_ID,
    worktreeId: WORKTREE_ID,
    title: 'Shell',
    layout: { kind: 'leaf', nodeId: 'only', paneId: OTHER_PANE, collapsed: false },
    activePaneId: OTHER_PANE,
    panes: [
      { id: OTHER_PANE, surfaceId: OTHER_SURFACE_ID, title: 'shell', sortOrder: 0, session: null },
    ],
  };
}

function workspaceSnapshot(): WorkspaceSnapshot {
  return {
    projects: [
      {
        id: 1,
        name: 'isagi',
        rootPath: '/work/isagi',
        kind: 'git',
        status: 'present',
        worktrees: [
          {
            id: WORKTREE_ID,
            projectId: 1,
            title: 'feat/embed-fluidcast',
            path: '/work/isagi',
            branch: 'feat/embed-fluidcast',
            head: 'abcdef0',
            isRoot: false,
            parked: false,
            activeSurfaceId: FLUIDCAST_SURFACE_ID,
            surfaces: [
              { id: FLUIDCAST_SURFACE_ID, title: 'Voice', paneKinds: ['agent_session'] },
              { id: OTHER_SURFACE_ID, title: 'Shell', paneKinds: [] },
            ],
          },
        ],
      },
    ],
  };
}

function controlPlane(): ControlPlaneSnapshot {
  return {
    onboardingComplete: true,
    configStatus: 'valid',
    configDiagnostic: null,
    policyRevision: 'rev-1',
    inventory: { status: 'ready', generation: 1, environment: 'trusted' },
    harnesses: [],
    reconciliation: {
      desiredFingerprint: null,
      runningFingerprint: null,
      lastCompletedFingerprint: null,
      lastAppliedFingerprint: null,
      lastResult: null,
    },
    editorProvisioning: { status: 'ready', version: '4.135.0' },
  };
}

function success(data: unknown): Response {
  return new Response(JSON.stringify({ data, meta: { requestId: 'req-fluidcast-fixture' } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function failure(
  status: number,
  code: string,
  message: string,
  data?: Record<string, unknown>,
): Response {
  return new Response(
    JSON.stringify({
      error: {
        code,
        status,
        message,
        requestId: 'req-fluidcast-fixture',
        ...(data ? { data } : {}),
      },
    }),
    { status, headers: { 'content-type': 'application/json' } },
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
