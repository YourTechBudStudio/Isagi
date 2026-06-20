import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createPtyStreamTransport, type PtyStreamSink } from './transport.js';

function createSink() {
  const writes: string[] = [];
  const interactive: boolean[] = [];
  let connected = 0;
  const sink: PtyStreamSink = {
    write: (data) => writes.push(data),
    setInteractive: (next) => interactive.push(next),
    onConnected: () => {
      connected += 1;
    },
  };
  return {
    sink,
    writes,
    interactive,
    connected: () => connected,
  };
}

function createOpenSocket() {
  const sent: string[] = [];
  let closed = false;
  const socket = {
    readyState: WebSocket.OPEN,
    send: (data: string) => sent.push(data),
    close: () => {
      closed = true;
    },
  } as unknown as WebSocket;
  return { socket, sent, closed: () => closed };
}

test('pty stream transport buffers output until a sink connects', () => {
  const transport = createPtyStreamTransport();
  transport.pushOutput('one');
  transport.pushOutput('two');

  const attached = createSink();
  transport.connect(attached.sink);

  assert.deepEqual(attached.writes, ['one', 'two']);
});

test('pty stream transport writes directly once connected', () => {
  const transport = createPtyStreamTransport();
  const attached = createSink();
  transport.connect(attached.sink);

  transport.pushOutput('live');

  assert.deepEqual(attached.writes, ['live']);
});

test('beginAttach resets buffered output and interactivity', () => {
  const transport = createPtyStreamTransport();
  const attached = createSink();
  transport.pushOutput('stale');
  transport.connect(attached.sink);

  transport.pushOutput('old');
  transport.beginAttach(true);
  transport.pushOutput('new');

  assert.deepEqual(attached.writes, ['stale', 'old', 'new']);
  assert.deepEqual(attached.interactive, [false, true]);
});

test('beginAttach drops output buffered for a previous stream before connect', () => {
  const transport = createPtyStreamTransport();
  transport.pushOutput('old');
  transport.beginAttach(false);
  transport.pushOutput('new');

  const attached = createSink();
  transport.connect(attached.sink);

  assert.deepEqual(attached.writes, ['new']);
});

test('input and resize are gated on an open interactive socket', () => {
  const transport = createPtyStreamTransport();
  const open = createOpenSocket();

  transport.bindSocket(open.socket);
  transport.sendInput('ignored');
  transport.sendResize(80, 24);

  transport.setInteractive(true);
  transport.sendInput('a');
  transport.sendResize(120, 40);

  assert.deepEqual(open.sent, [
    JSON.stringify({ type: 'input', data: 'a' }),
    JSON.stringify({ type: 'resize', cols: 120, rows: 40 }),
  ]);
});

test('connect notifies a sink when a socket is already open', () => {
  const transport = createPtyStreamTransport();
  const open = createOpenSocket();
  transport.bindSocket(open.socket);

  const attached = createSink();
  transport.connect(attached.sink);

  assert.equal(attached.connected(), 1);
});

test('freeze disables interactivity and closeSocket closes the active socket', () => {
  const transport = createPtyStreamTransport();
  const attached = createSink();
  const open = createOpenSocket();

  transport.connect(attached.sink);
  transport.bindSocket(open.socket);
  transport.setInteractive(true);
  transport.freeze();
  transport.sendInput('ignored');
  transport.closeSocket();

  assert.deepEqual(attached.interactive, [false, true, false]);
  assert.deepEqual(open.sent, []);
  assert.equal(open.closed(), true);
});
