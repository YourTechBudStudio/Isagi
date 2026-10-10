// The runtime-events connection as a resource atom: one socket at a time, backoff reconnects,
// the open-time handshake order, and teardown on unmount (web-state §5.12).
import assert from 'node:assert/strict';
import { mock, test, type TestContext } from 'node:test';

import { Effect } from 'effect';

import type { RuntimeEvent } from '@isagi/contracts';

import { appRuntime } from '../../state/runtime.js';
import { flush, makeTestRegistry } from '../../state/testing.js';
import { attentionSourcesAtom } from '../attention.js';
import { connectRuntimeEvents, type RuntimeEventsSocket } from '../runtime-events.js';
import { terminalFactsAtom } from '../terminal-presentation/facts.js';
import { runtimeConnectionPhaseAtom } from '../workflow/live.js';

type Listener = (event: { readonly data: unknown }) => void;

class FakeSocket implements RuntimeEventsSocket {
  readyState = 0;
  closed = false;
  readonly sent: unknown[] = [];
  private readonly listeners = new Map<string, Listener[]>();

  constructor(
    readonly url: string,
    private readonly log: string[],
  ) {}

  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  send(data: string) {
    const message = JSON.parse(data) as { readonly type: string };
    this.sent.push(message);
    this.log.push(`send:${message.type}`);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.emit('close');
  }
  open() {
    this.readyState = 1;
    this.emit('open');
  }
  message(data: unknown) {
    this.emit('message', { data });
  }
  private emit(type: string, event: { readonly data: unknown } = { data: undefined }) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function connectionSession(t: TestContext, options: { readonly urlFails?: () => boolean } = {}) {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000 });
  t.after(() => mock.timers.reset());
  const log: string[] = [];
  const sockets: FakeSocket[] = [];
  const registry = makeTestRegistry({
    api: {
      resolveRuntimeEventsWebSocketUrl: () =>
        Effect.suspend(() =>
          options.urlFails?.()
            ? (Effect.fail(new Error('runtime url unavailable')) as never)
            : Effect.succeed('ws://runtime.test/events'),
        ),
    },
  });
  t.after(() => registry.dispose());
  registry.get(terminalFactsAtom).subscribe((fact) => log.push(`fact:${fact.type}`));
  // The workflow layer's view of the connection: the phase it records for each (dis)connect.
  t.after(registry.subscribe(runtimeConnectionPhaseAtom, (phase) => log.push(`signal:${phase}`)));
  const connection = appRuntime.atom(
    connectRuntimeEvents((url) => {
      const socket = new FakeSocket(url, log);
      sockets.push(socket);
      return socket;
    }),
  );
  return { registry, connection, log, sockets };
}

const tick = async (ms: number) => {
  await flush();
  mock.timers.tick(ms);
  await flush();
};

test('socket: open, messages, close, 500 ms then 1 s backoff, reset by an open, unmount closes', async (t) => {
  const { registry, connection, sockets, log } = connectionSession(t);
  const unmount = registry.mount(connection);
  await flush();
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0]?.url, 'ws://runtime.test/events');

  sockets[0]!.open();
  await flush();
  sockets[0]!.message(JSON.stringify(attentionSnapshot()));
  await flush();
  assert.equal(Object.keys(registry.get(attentionSourcesAtom)).length, 1, 'events are applied');

  sockets[0]!.close();
  await flush();
  assert.equal(log.at(-1), 'signal:disconnected');
  await tick(499);
  assert.equal(sockets.length, 1);
  await tick(1);
  assert.equal(sockets.length, 2, 'reconnect after 500 ms');

  sockets[1]!.close();
  await tick(999);
  assert.equal(sockets.length, 2);
  await tick(1);
  assert.equal(sockets.length, 3, 'then after 1 s');

  sockets[2]!.open();
  await flush();
  sockets[2]!.close();
  await tick(500);
  assert.equal(sockets.length, 4, 'a successful open resets the backoff');

  unmount();
  await flush();
  assert.equal(sockets[3]!.closed, true, 'unmount closes the live socket');
  await tick(20_000);
  assert.equal(sockets.length, 4, 'and nothing reconnects after it');
});

test('socket: on open, the coordinator is told first, then attention, workflow, and the run snapshot', async (t) => {
  const { registry, connection, sockets, log } = connectionSession(t);
  t.after(registry.mount(connection));
  await flush();
  log.length = 0;

  sockets[0]!.open();
  await flush();

  assert.deepEqual(log, [
    'fact:runtime_connected',
    'send:attention_snapshot_requested',
    'signal:connected',
    'send:workflow_run_snapshot_requested',
  ]);
});

test('socket: an undecodable message is logged and the connection keeps going', async (t) => {
  const { registry, connection, sockets, log } = connectionSession(t);
  t.after(registry.mount(connection));
  await flush();
  sockets[0]!.open();
  await flush();
  log.length = 0;

  sockets[0]!.message('{not json');
  sockets[0]!.message(JSON.stringify({ type: 'nobody_knows_this', payload: {} }));
  sockets[0]!.message(JSON.stringify(attentionSnapshot()));
  await flush();

  assert.equal(sockets[0]!.closed, false);
  assert.deepEqual(log, ['fact:runtime_event'], 'only the valid event was applied');
  assert.equal(Object.keys(registry.get(attentionSourcesAtom)).length, 1);
});

test('socket: a runtime URL that cannot be resolved goes to the same backoff', async (t) => {
  let failing = true;
  const { registry, connection, sockets } = connectionSession(t, { urlFails: () => failing });
  t.after(registry.mount(connection));
  await flush();
  assert.equal(sockets.length, 0);

  failing = false;
  await tick(499);
  assert.equal(sockets.length, 0);
  await tick(1);
  assert.equal(sockets.length, 1, 'retried after 500 ms');
});

test('socket: a socket error closes it and reconnects', async (t) => {
  const { registry, connection, sockets } = connectionSession(t);
  t.after(registry.mount(connection));
  await flush();
  sockets[0]!.open();
  await flush();

  (sockets[0] as unknown as { emit: (type: string) => void }).emit('error');
  await tick(500);

  assert.equal(sockets[0]!.closed, true);
  assert.equal(sockets.length, 2);
});

function attentionSnapshot(): RuntimeEvent {
  return {
    id: 'evt_attention',
    type: 'attention_snapshot',
    occurredAt: '2026-06-12T00:00:00.000Z',
    payload: {
      sources: [
        {
          worktreeId: 2,
          surfaceId: 3,
          paneId: 4,
          source: { kind: 'agent_session', id: 1 },
          attention: 'working',
        },
      ],
    },
  };
}
