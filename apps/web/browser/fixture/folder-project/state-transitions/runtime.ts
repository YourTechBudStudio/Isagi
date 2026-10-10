import type {
  ActiveContext,
  ControlPlaneSnapshot,
  RuntimeEvent,
  SetActiveContextInput,
  WorkspaceSnapshot,
} from '@isagi/contracts';

import { requestBodyText } from '../../test-support/request-body.js';
import { FIXTURE_CONTROL_PLANE } from '../seed.js';
import {
  INITIAL_WORKSPACE,
  INVENTORY_PENDING_CONTROL_PLANE,
  WORKSPACE_VARIANTS,
  type WorkspaceVariant,
} from './seed.js';

/**
 * The fake runtime behind the state-transitions page (`/folder-project/?app=state-transitions`).
 *
 * That page mounts the *production* entry (`src/main.tsx`) unchanged, so everything about how the
 * app reads, caches, retries and refreshes runtime facts is production behaviour. This module is
 * the only thing that is not: a `fetch` stub and a `WebSocket` stub for one invented origin, with
 * the instrumentation a state-transition oracle needs and nothing else:
 *
 * - a read log, so a spec can count reads per endpoint (`reads('GET /workspace')`);
 * - per-endpoint holds (a read waits until released) and failures (a read rejects as a dropped
 *   connection would), so loading, refresh and error transitions can be looked at one at a time;
 * - a controllable runtime-events socket (close it, refuse reconnects, push events), with a log of
 *   every connection attempt and every message the client sent.
 *
 * Nothing here knows how the client caches. A spec observes the page and these counters only, so
 * the same specs hold whatever state library sits behind the production components.
 */

/** An endpoint as the read log names it: method, a space, the path below `/api/v1`. */
export type EndpointKey = `${'GET' | 'POST' | 'PUT' | 'DELETE'} /${string}`;

/** One request the page made, in arrival order. */
export interface RuntimeCall {
  readonly key: EndpointKey;
  readonly at: number;
  /** Whether the stub answered with a refusal (an injected failure or an unknown route). */
  readonly failed: boolean;
}

/** One runtime-events connection attempt, newest last. */
export interface SocketAttempt {
  readonly startedAt: number;
  /** `open` once the stub accepted it; `refused` when it was turned away. */
  readonly outcome: 'pending' | 'open' | 'refused';
  readonly closedAt: number | null;
  /** The input messages the client sent on this connection, by `type`. */
  readonly sent: readonly string[];
}

/**
 * What a spec may set before the page loads, through `page.addInitScript` on
 * `window.stateTransitionsFixtureInit`. Everything here can also be changed later through the
 * controls; the init form exists for the facts the *first* render already depends on.
 */
export interface StateTransitionsFixtureInit {
  readonly holds?: readonly EndpointKey[];
  readonly failures?: readonly EndpointKey[];
  readonly controlPlane?: 'ready' | 'inventory_pending';
}

export interface StateTransitionsFixtureControls {
  /** How many requests with this key the page has made. */
  readonly reads: (key: EndpointKey) => number;
  readonly calls: () => readonly RuntimeCall[];
  /** Requests currently being answered, held ones included. */
  readonly inFlight: () => number;
  /** Requests that reached no fixture route, so a spec can prove the page asked for nothing odd. */
  readonly unhandled: () => readonly EndpointKey[];

  /** From now on, requests with this key wait until {@link release}. */
  readonly hold: (key: EndpointKey) => void;
  /** Stop holding this key and let every waiting request through. */
  readonly release: (key: EndpointKey) => void;
  /** From now on, requests with this key reject like a dropped connection. */
  readonly fail: (key: EndpointKey) => void;
  readonly succeed: (key: EndpointKey) => void;

  readonly setWorkspace: (variant: WorkspaceVariant) => void;
  readonly setControlPlane: (state: 'ready' | 'inventory_pending') => void;
  /** The runtime's persisted active context, written behind the client's back. */
  readonly setActiveContext: (activeContext: SetActiveContextInput) => void;
  readonly activeContext: () => ActiveContext;

  readonly socketAttempts: () => readonly SocketAttempt[];
  /** Turn away the next `count` connection attempts. */
  readonly refuseSockets: (count: number) => void;
  /** Close the open connection from the runtime side, as a runtime restart would. */
  readonly closeSocket: () => void;
  /** Push one runtime event down the open connection. */
  readonly emit: (event: RuntimeEvent) => void;
}

declare global {
  interface Window {
    stateTransitionsFixture?: StateTransitionsFixtureControls;
    stateTransitionsFixtureInit?: StateTransitionsFixtureInit;
  }
}

const RUNTIME_ORIGIN = 'http://state-transitions-fixture.invalid';
const SOCKET_HOST = new URL(RUNTIME_ORIGIN).host;

/**
 * The runtime's persisted active context survives a page reload, as the runtime's database does.
 * `sessionStorage` is per Playwright context, so every spec starts from an empty context.
 */
const ACTIVE_CONTEXT_STORAGE_KEY = 'isagi.state-transitions-fixture.active-context';

export function installStateTransitionsRuntime() {
  const init = window.stateTransitionsFixtureInit ?? {};
  const calls: RuntimeCall[] = [];
  const unhandled: EndpointKey[] = [];
  const holds = new Map<EndpointKey, (() => void)[]>();
  const failures = new Set<EndpointKey>(init.failures ?? []);
  let inFlight = 0;
  let workspace: WorkspaceSnapshot = INITIAL_WORKSPACE;
  let controlPlane: ControlPlaneSnapshot =
    init.controlPlane === 'inventory_pending'
      ? INVENTORY_PENDING_CONTROL_PLANE
      : FIXTURE_CONTROL_PLANE;
  for (const key of init.holds ?? []) holds.set(key, []);

  const sockets = installFakeRuntimeEventsSocket();

  window.isagi = { getRuntimeUrl: () => Promise.resolve(RUNTIME_ORIGIN) };
  window.stateTransitionsFixture = {
    reads: (key) => calls.filter((call) => call.key === key).length,
    calls: () => calls,
    inFlight: () => inFlight,
    unhandled: () => unhandled,
    hold: (key) => {
      if (!holds.has(key)) holds.set(key, []);
    },
    release: (key) => {
      const waiting = holds.get(key) ?? [];
      holds.delete(key);
      for (const resume of waiting) resume();
    },
    fail: (key) => {
      failures.add(key);
    },
    succeed: (key) => {
      failures.delete(key);
    },
    setWorkspace: (variant) => {
      workspace = WORKSPACE_VARIANTS[variant];
    },
    setControlPlane: (state) => {
      controlPlane =
        state === 'inventory_pending' ? INVENTORY_PENDING_CONTROL_PLANE : FIXTURE_CONTROL_PLANE;
    },
    setActiveContext: (activeContext) => storeActiveContext(activeContext),
    activeContext: readActiveContext,
    socketAttempts: sockets.attempts,
    refuseSockets: sockets.refuse,
    closeSocket: sockets.close,
    emit: sockets.emit,
  };

  const realFetch = window.fetch.bind(window);

  window.fetch = async (input, requestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      window.location.origin,
    );
    if (url.origin !== RUNTIME_ORIGIN) return realFetch(input as RequestInfo, requestInit);

    const method = (requestInit?.method ?? 'GET').toUpperCase();
    const key = `${method} ${url.pathname.replace('/api/v1', '')}` as EndpointKey;
    const call = { key, at: Date.now(), failed: false };
    calls.push(call);
    inFlight += 1;
    try {
      const waiting = holds.get(key);
      if (waiting) await new Promise<void>((resume) => waiting.push(resume));
      if (failures.has(key)) {
        calls[calls.indexOf(call)] = { ...call, failed: true };
        // What `fetch` does when nothing answers: the client classifies it as a transport
        // failure, which is the failure every read must survive, whatever its endpoint.
        throw new TypeError('Failed to fetch');
      }
      const response = answer(method, key, requestInit);
      if (!response) {
        unhandled.push(key);
        calls[calls.indexOf(call)] = { ...call, failed: true };
        return json(404, {
          error: {
            code: 'api_route_not_found',
            status: 404,
            message: `No fixture route for ${key}`,
            requestId: 'state-transitions-fixture',
          },
        });
      }
      return response;
    } finally {
      inFlight -= 1;
    }
  };

  /**
   * Every route the production workspace asks for on this page, answered with an explicit, valid,
   * honest value: an empty command catalog, an empty durable-session inventory, no workflows.
   */
  function answer(method: string, key: EndpointKey, requestInit: RequestInit | undefined) {
    const path = key.slice(method.length + 1);

    if (key === 'GET /control-plane') return success(controlPlane);
    if (key === 'GET /client-settings') return success(CLIENT_SETTINGS);
    if (key === 'GET /workspace') return success(workspace);
    if (key === 'GET /workspace/durable-sessions') return success({ sessions: [] });
    if (key === 'GET /workspace/active-context') {
      return success({ activeContext: readActiveContext() });
    }
    if (key === 'PUT /workspace/active-context') {
      const body = JSON.parse(requestBodyText(requestInit?.body) ?? '{}') as {
        activeContext: SetActiveContextInput;
      };
      storeActiveContext(body.activeContext);
      return success({ activeContext: body.activeContext });
    }
    // Presence never changes on this page, so a reconcile finds nothing.
    if (key === 'POST /workspace/reconcile') return success({ findings: [] });
    if (key === 'POST /workflows/descriptors') return success({ workflows: [] });

    const commands = /^\/worktrees\/(\d+)\/commands$/.exec(path);
    if (method === 'GET' && commands) {
      return success({
        status: 'configured',
        worktreeId: Number(commands[1]),
        commands: [],
        removedCommands: [],
      });
    }
    return null;
  }
}

function readActiveContext(): ActiveContext {
  const stored = window.sessionStorage.getItem(ACTIVE_CONTEXT_STORAGE_KEY);
  return stored ? (JSON.parse(stored) as ActiveContext) : { projectId: null, worktreeId: null };
}

function storeActiveContext(activeContext: SetActiveContextInput) {
  window.sessionStorage.setItem(ACTIVE_CONTEXT_STORAGE_KEY, JSON.stringify(activeContext));
}

/**
 * Replaces `window.WebSocket` for the fixture origin only; every other URL still gets a real
 * socket. The stub behaves like the runtime's events route: it accepts (or refuses) a connection
 * asynchronously, answers the two snapshot requests the client sends on open, and closes with a
 * `close` event the client cannot tell from a real one.
 */
function installFakeRuntimeEventsSocket() {
  const RealWebSocket = window.WebSocket;
  const attempts: SocketAttempt[] = [];
  let refuseNext = 0;
  /** Open connections; the client keeps at most one, and the newest is the one it uses. */
  const open = new Set<FakeRuntimeEventsSocket>();
  const current = () => [...open].at(-1) ?? null;

  class FakeRuntimeEventsSocket extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSING = 2;
    readonly CLOSED = 3;
    readonly url: string;
    readonly protocol = '';
    readonly extensions = '';
    binaryType: BinaryType = 'blob';
    bufferedAmount = 0;
    readyState = 0;
    onopen: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    readonly #index: number;

    constructor(url: string) {
      super();
      this.url = url;
      this.#index = attempts.length;
      attempts.push({ startedAt: Date.now(), outcome: 'pending', closedAt: null, sent: [] });
      const refused = refuseNext > 0;
      if (refused) refuseNext -= 1;
      // Never synchronously: a real socket reports on a later task, after the caller has
      // attached its listeners.
      void Promise.resolve().then(() => {
        if (this.readyState !== 0) return;
        if (refused) {
          this.#update({ outcome: 'refused' });
          this.#fire(new Event('error'));
          this.#finish(1006);
          return;
        }
        this.readyState = 1;
        open.add(this);
        this.#update({ outcome: 'open' });
        this.#fire(new Event('open'));
      });
    }

    send(data: string) {
      if (this.readyState !== 1) throw new DOMException('not open', 'InvalidStateError');
      const message = JSON.parse(data) as { readonly type: string };
      const attempt = attempts[this.#index]!;
      this.#update({ sent: [...attempt.sent, message.type] });
      if (message.type === 'attention_snapshot_requested') {
        this.deliver(runtimeEvent('attention_snapshot', { sources: [] }));
      }
      if (message.type === 'workflow_run_snapshot_requested') {
        this.deliver(runtimeEvent('workflow_run_snapshot', { summaries: [] }));
      }
    }

    close() {
      if (this.readyState >= 2) return;
      this.readyState = 2;
      void Promise.resolve().then(() => this.#finish(1000));
    }

    /** The runtime went away: an unclean close the client did not ask for. */
    drop() {
      void Promise.resolve().then(() => this.#finish(1006));
    }

    deliver(event: RuntimeEvent) {
      void Promise.resolve().then(() => {
        if (this.readyState !== 1) return;
        this.#fire(new MessageEvent('message', { data: JSON.stringify(event) }));
      });
    }

    #finish(code: number) {
      if (this.readyState === 3) return;
      this.readyState = 3;
      open.delete(this);
      this.#update({ closedAt: Date.now() });
      this.#fire(new CloseEvent('close', { code, wasClean: code === 1000 }));
    }

    #update(patch: Partial<SocketAttempt>) {
      attempts[this.#index] = { ...attempts[this.#index]!, ...patch };
    }

    #fire(event: Event) {
      this.dispatchEvent(event);
      const handler = (this as unknown as Record<string, unknown>)[`on${event.type}`];
      if (typeof handler === 'function') handler.call(this, event);
    }
  }

  window.WebSocket = new Proxy(RealWebSocket, {
    construct(target, args: [string | URL, (string | string[])?]) {
      const url = new URL(String(args[0]));
      if (url.host === SOCKET_HOST) {
        return new FakeRuntimeEventsSocket(url.toString()) as unknown as WebSocket;
      }
      return Reflect.construct(target, args) as WebSocket;
    },
  });

  return {
    attempts: () => attempts,
    refuse: (count: number) => {
      refuseNext = count;
    },
    close: () => {
      const socket = current();
      if (!socket) throw new Error('No runtime-events connection is open.');
      socket.drop();
    },
    emit: (event: RuntimeEvent) => {
      const socket = current();
      if (!socket) throw new Error('No runtime-events connection is open.');
      socket.deliver(event);
    },
  };
}

let eventSequence = 0;

function runtimeEvent<T extends RuntimeEvent['type']>(
  type: T,
  payload: Extract<RuntimeEvent, { readonly type: T }>['payload'],
): RuntimeEvent {
  eventSequence += 1;
  return {
    id: `state-transitions-${eventSequence}`,
    type,
    occurredAt: new Date().toISOString(),
    payload,
  } as RuntimeEvent;
}

const CLIENT_SETTINGS = {
  terminal: {
    scrollbackLines: 5_000,
    cache: { idleTtlMinutes: 180, maxHiddenSessions: 4, maxEstimatedBufferMiB: 64 },
  },
};

function success(data: unknown) {
  return json(200, { data, meta: { requestId: 'state-transitions-fixture' } });
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
