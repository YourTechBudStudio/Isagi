import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createClipboardCopy,
  type ClipboardCopyState,
  type ClipboardCopyDeps,
} from './clipboard-copy.js';

/** A hand-driven clock, so "after the reset delay" is a step rather than a wait. */
function fakeTimers() {
  const pending = new Map<number, () => void>();
  let next = 1;
  return {
    setTimer: (run: () => void, _ms: number) => {
      const handle = next++;
      pending.set(handle, run);
      return handle;
    },
    clearTimer: (handle: unknown) => {
      pending.delete(handle as number);
    },
    /** Fire every timer currently scheduled. */
    flush: () => {
      const due = [...pending.entries()];
      pending.clear();
      for (const [, run] of due) {
        run();
      }
    },
    get scheduled() {
      return pending.size;
    },
  };
}

interface Harness {
  readonly states: ClipboardCopyState[];
  readonly settled: ('copied' | 'failed')[];
  readonly timers: ReturnType<typeof fakeTimers>;
  readonly copy: (text: string) => void;
  readonly dispose: () => void;
}

function harness(writeText: ClipboardCopyDeps['writeText']): Harness {
  const states: ClipboardCopyState[] = [];
  const settled: ('copied' | 'failed')[] = [];
  const timers = fakeTimers();
  const controller = createClipboardCopy({
    writeText,
    onState: (state) => states.push(state),
    onSettled: (state) => settled.push(state),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  return { states, settled, timers, copy: controller.copy, dispose: controller.dispose };
}

/** A promise whose settlement this test decides. */
function deferred() {
  let resolve!: () => void;
  let reject!: () => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = () => rej(new Error('denied'));
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('createClipboardCopy', () => {
  it('confirms a write and returns to idle when its own timer fires', async () => {
    const h = harness(() => Promise.resolve());

    h.copy('http://localhost:5173/');
    await tick();

    assert.deepEqual(h.states, ['idle', 'copied']);
    assert.deepEqual(h.settled, ['copied']);

    h.timers.flush();
    assert.deepEqual(h.states, ['idle', 'copied', 'idle']);
  });

  it('reports a rejected write as a visible failure rather than swallowing it', async () => {
    const h = harness(() => Promise.reject(new Error('denied')));

    h.copy('http://localhost:5173/');
    await tick();

    assert.deepEqual(h.states, ['idle', 'failed']);
    assert.deepEqual(h.settled, ['failed']);
  });

  it('fails visibly when the clipboard API is absent entirely', () => {
    // No promise involved: the failure is known synchronously, and silence here
    // is exactly the pre-existing behavior this replaces.
    const h = harness(null);

    h.copy('http://localhost:5173/');

    assert.deepEqual(h.states, ['idle', 'failed']);
    assert.deepEqual(h.settled, ['failed']);
  });

  it('resets to idle synchronously when retried from a terminal state', async () => {
    const h = harness(() => Promise.resolve());

    h.copy('a');
    await tick();
    assert.equal(h.states.at(-1), 'copied');

    // The retry must not keep showing the previous invocation's confirmation
    // while its own write is still in flight.
    h.copy('b');
    assert.equal(h.states.at(-1), 'idle');
    await tick();
    assert.equal(h.states.at(-1), 'copied');
  });

  it('lets the newest invocation win when an older write settles last', async () => {
    const first = deferred();
    const second = deferred();
    const writes = [first.promise, second.promise];
    let call = 0;
    const h = harness(() => writes[call++]!);

    h.copy('first');
    h.copy('second');

    // The newer write succeeds, then the older one rejects afterwards.
    second.resolve();
    await tick();
    assert.equal(h.states.at(-1), 'copied');

    first.reject();
    await tick();

    // The stale rejection is dropped: it cannot repaint a newer success as a
    // failure the user never caused.
    assert.equal(h.states.at(-1), 'copied');
    assert.deepEqual(h.settled, ['copied']);
  });

  it('lets the newest invocation win in the opposite settlement order too', async () => {
    const first = deferred();
    const second = deferred();
    const writes = [first.promise, second.promise];
    let call = 0;
    const h = harness(() => writes[call++]!);

    h.copy('first');
    h.copy('second');

    // The older write succeeds first; its success belongs to a dead invocation.
    first.resolve();
    await tick();
    assert.deepEqual(h.settled, []);

    second.reject();
    await tick();

    assert.equal(h.states.at(-1), 'failed');
    assert.deepEqual(h.settled, ['failed']);
  });

  it('gives the reset timer to the invocation that started it', async () => {
    const h = harness(() => Promise.resolve());

    h.copy('a');
    await tick();
    assert.equal(h.timers.scheduled, 1);

    // A newer copy clears the previous invocation's pending reset before writing,
    // so exactly one reset is ever outstanding.
    h.copy('b');
    await tick();
    assert.equal(h.timers.scheduled, 1);

    h.timers.flush();
    assert.equal(h.states.at(-1), 'idle');
  });

  it('writes nothing and schedules nothing after disposal', async () => {
    const h = harness(() => Promise.resolve());

    h.copy('a');
    h.dispose();
    await tick();

    // The settlement lands after unmount and is dropped; no timer survives.
    assert.deepEqual(h.states, ['idle']);
    assert.deepEqual(h.settled, []);
    assert.equal(h.timers.scheduled, 0);

    h.copy('b');
    assert.deepEqual(h.states, ['idle']);
  });
});
