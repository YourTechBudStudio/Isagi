import assert from 'node:assert/strict';
import test from 'node:test';

import { createShortcutDispatcher, type ShortcutWindow } from './dispatcher.js';
import { appKeymap, type ShortcutEntry } from './keymap.js';

interface FakeWindow extends ShortcutWindow {
  /** Deliver an event to the listeners of one phase, the way the browser would. */
  readonly fire: (phase: 'capture' | 'bubble', event: KeyboardEvent) => void;
  readonly listenerCount: () => number;
}

function fakeWindow(): FakeWindow {
  const listeners: { listener: EventListener; capture: boolean }[] = [];
  return {
    addEventListener: ((_type: string, listener: EventListener, capture?: boolean) => {
      listeners.push({ listener, capture: capture === true });
    }) as ShortcutWindow['addEventListener'],
    removeEventListener: ((_type: string, listener: EventListener, capture?: boolean) => {
      const index = listeners.findIndex(
        (entry) => entry.listener === listener && entry.capture === (capture === true),
      );
      if (index !== -1) listeners.splice(index, 1);
    }) as ShortcutWindow['removeEventListener'],
    fire: (phase, event) => {
      for (const entry of [...listeners]) {
        if (entry.capture === (phase === 'capture')) entry.listener(event);
      }
    },
    listenerCount: () => listeners.length,
  };
}

interface FakeEvent extends KeyboardEvent {
  readonly prevented: () => boolean;
  readonly stopped: () => boolean;
}

function keydown(
  key: string,
  options: { ctrl?: boolean; meta?: boolean; trusted?: boolean; target?: unknown } = {},
): FakeEvent {
  let prevented = false;
  let stopped = false;
  return {
    type: 'keydown',
    key,
    ctrlKey: options.ctrl ?? !options.meta,
    metaKey: options.meta ?? false,
    shiftKey: false,
    altKey: false,
    isTrusted: options.trusted ?? true,
    target: options.target ?? null,
    get defaultPrevented() {
      return prevented;
    },
    preventDefault: () => {
      prevented = true;
    },
    stopPropagation: () => {
      stopped = true;
    },
    prevented: () => prevented,
    stopped: () => stopped,
  } as unknown as FakeEvent;
}

const keymap = {
  palette: { chord: 'Mod+K', phase: 'capture', priority: true },
  yielding: { chord: 'Mod+N', phase: 'bubble' },
  guarded: {
    chord: 'Mod+W',
    phase: 'capture',
    when: (event: KeyboardEvent) => !event.defaultPrevented,
  },
} as const satisfies Record<string, ShortcutEntry>;

function setup(isMac = false) {
  const dispatcher = createShortcutDispatcher({ keymap, isMac: () => isMac });
  const host = fakeWindow();
  dispatcher.install(host);
  const runs: string[] = [];
  return { dispatcher, host, runs };
}

test('each entry is dispatched only from its own phase', () => {
  const { dispatcher, host, runs } = setup();
  dispatcher.bind('palette', { run: () => runs.push('palette') });
  dispatcher.bind('yielding', { run: () => runs.push('yielding') });

  host.fire('bubble', keydown('k'));
  host.fire('capture', keydown('n'));
  assert.deepEqual(runs, []);

  host.fire('capture', keydown('k'));
  host.fire('bubble', keydown('n'));
  assert.deepEqual(runs, ['palette', 'yielding']);
});

test('a match claims the key; only a priority entry also stops it', () => {
  const { dispatcher, host } = setup();
  dispatcher.bind('palette', { run: () => {} });
  dispatcher.bind('yielding', { run: () => {} });
  dispatcher.bind('guarded', { run: () => {} });

  const palette = keydown('k');
  host.fire('capture', palette);
  assert.equal(palette.prevented(), true);
  assert.equal(palette.stopped(), true);

  const yielding = keydown('n');
  host.fire('bubble', yielding);
  assert.equal(yielding.prevented(), true);
  assert.equal(yielding.stopped(), false);

  const capturedNonPriority = keydown('w');
  host.fire('capture', capturedNonPriority);
  assert.equal(capturedNonPriority.prevented(), true);
  assert.equal(capturedNonPriority.stopped(), false);
});

test('Mod follows the platform', () => {
  const mac = setup(true);
  mac.dispatcher.bind('palette', { run: () => mac.runs.push('palette') });
  mac.host.fire('capture', keydown('k', { ctrl: true }));
  assert.deepEqual(mac.runs, []);
  mac.host.fire('capture', keydown('k', { ctrl: false, meta: true }));
  assert.deepEqual(mac.runs, ['palette']);
});

test("a keymap guard that says no leaves the key alone, as does the binding's own", () => {
  const { dispatcher, host, runs } = setup();
  let enabled = false;
  dispatcher.bind('guarded', { enabled: () => enabled, run: () => runs.push('guarded') });

  const claimed = keydown('w');
  claimed.preventDefault();
  enabled = true;
  host.fire('capture', claimed);
  assert.deepEqual(runs, []);

  enabled = false;
  const disabled = keydown('w');
  host.fire('capture', disabled);
  assert.equal(disabled.prevented(), false);
  assert.deepEqual(runs, []);

  enabled = true;
  host.fire('capture', keydown('w'));
  assert.deepEqual(runs, ['guarded']);
});

test('an unbound entry leaves the key alone', () => {
  const { host } = setup();
  const event = keydown('k');
  host.fire('capture', event);
  assert.equal(event.prevented(), false);
  assert.equal(event.stopped(), false);
});

test('the latest binding runs, and unbinding returns to the previous one', () => {
  const { dispatcher, host, runs } = setup();
  dispatcher.bind('palette', { run: () => runs.push('first') });
  const unbind = dispatcher.bind('palette', { run: () => runs.push('second') });
  host.fire('capture', keydown('k'));
  unbind();
  host.fire('capture', keydown('k'));
  assert.deepEqual(runs, ['second', 'first']);
});

test('an embedded source dispatches trusted priority entries only', () => {
  const { dispatcher, runs } = setup();
  dispatcher.bind('palette', { run: () => runs.push('palette') });
  dispatcher.bind('yielding', { run: () => runs.push('yielding') });
  dispatcher.bind('guarded', { run: () => runs.push('guarded') });
  const frame = fakeWindow();
  dispatcher.attachSource(frame);
  // A source listens in the capture phase only.
  assert.equal(frame.listenerCount(), 1);

  const synthetic = keydown('k', { trusted: false });
  frame.fire('capture', synthetic);
  assert.equal(synthetic.prevented(), false);
  frame.fire('capture', keydown('w'));
  frame.fire('capture', keydown('n'));
  assert.deepEqual(runs, []);

  const trusted = keydown('k');
  frame.fire('capture', trusted);
  assert.deepEqual(runs, ['palette']);
  assert.equal(trusted.stopped(), true);
});

test('the host window accepts synthetic events, as page listeners always have', () => {
  const { dispatcher, host, runs } = setup();
  dispatcher.bind('palette', { run: () => runs.push('palette') });
  host.fire('capture', keydown('k', { trusted: false }));
  assert.deepEqual(runs, ['palette']);
});

test('detaching removes every listener it added', () => {
  const { dispatcher } = setup();
  const frame = fakeWindow();
  const detachSource = dispatcher.attachSource(frame);
  detachSource();
  assert.equal(frame.listenerCount(), 0);

  const other = fakeWindow();
  const uninstall = dispatcher.install(other);
  assert.equal(other.listenerCount(), 2);
  uninstall();
  assert.equal(other.listenerCount(), 0);
});

test('only the palette takes priority in the app keymap; Mod+W yields to editable targets', () => {
  const priorities = Object.entries(appKeymap)
    .filter(([, entry]) => entry.phase === 'capture' && 'priority' in entry && entry.priority)
    .map(([id]) => id);
  assert.deepEqual(priorities, ['toggle-palette']);

  const deletePane = appKeymap['delete-active-pane'];
  const textarea = { tagName: 'TEXTAREA', isContentEditable: false, closest: () => null };
  const chrome = { tagName: 'DIV', isContentEditable: false, closest: () => null };
  assert.equal(deletePane.when(keydown('w', { target: textarea })), false);
  assert.equal(deletePane.when(keydown('w', { target: chrome })), true);
});

test('a priority entry must be capture-phase, by type', () => {
  // @ts-expect-error A bubble-phase entry runs after focused surfaces, so it cannot take priority.
  const invalid: ShortcutEntry = { chord: 'Mod+X', phase: 'bubble', priority: true };
  assert.equal(invalid.phase, 'bubble');
});
