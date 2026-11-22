import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { installTerminalSelectionCopy } from './copy-selection.js';

const mac = /mac/i.test(navigator.platform);
const shortcut = mac
  ? { key: 'c', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false }
  : { key: 'C', metaKey: false, ctrlKey: true, shiftKey: true, altKey: false };

function fakeHost() {
  const listeners = new Map<string, { listener: (event: unknown) => void; capture: boolean }>();
  return {
    listeners,
    addEventListener: (type: string, listener: (event: unknown) => void, capture?: boolean) =>
      listeners.set(type, { listener, capture: capture === true }),
    removeEventListener: (type: string) => listeners.delete(type),
    dispatch(type: string, event: Record<string, unknown>) {
      const flags = { prevented: false, stopped: false };
      listeners.get(type)?.listener({
        type,
        ...event,
        preventDefault: () => (flags.prevented = true),
        stopPropagation: () => (flags.stopped = true),
      });
      return flags;
    },
  };
}

function install(selection: string, writeText = (_text: string) => Promise.resolve()) {
  const host = fakeHost();
  const keys: string[] = [];
  const failures = { count: 0 };
  const writes: string[] = [];
  const uninstall = installTerminalSelectionCopy({
    host: host as unknown as HTMLElement,
    terminal: { getSelection: () => selection },
    writeText: (text) => {
      writes.push(text);
      return writeText(text);
    },
    onWriteFailed: () => (failures.count += 1),
    onKeyDown: (event) => keys.push(event.key),
  });
  return { host, keys, failures, writes, uninstall };
}

describe('terminal selection copy', () => {
  it('copies the selection on the platform shortcut, in the capture phase', () => {
    const { host, keys, writes } = install('picked');
    assert.equal(host.listeners.get('keydown')?.capture, true);
    assert.deepEqual(host.dispatch('keydown', shortcut), { prevented: true, stopped: true });
    assert.deepEqual(writes, ['picked']);
    assert.deepEqual(keys, []);
  });

  it('passes the shortcut through without a selection, and other keys always', () => {
    const { host, keys, writes } = install('');
    host.dispatch('keydown', shortcut);
    host.dispatch('keydown', { key: 'x', metaKey: false, ctrlKey: false, shiftKey: false });
    assert.deepEqual(writes, []);
    assert.deepEqual(keys, [shortcut.key, 'x']);
  });

  it('reports a rejected shortcut write once', async () => {
    const { host, failures } = install('picked', () => Promise.reject(new Error('no')));
    host.dispatch('keydown', shortcut);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(failures.count, 1);
  });

  it('serves the copy event from the selection', () => {
    const data = new Map<string, string>();
    const { host } = install('picked');
    const flags = host.dispatch('copy', {
      clipboardData: { setData: (type: string, value: string) => data.set(type, value) },
    });
    assert.equal(flags.prevented, true);
    assert.equal(data.get('text/plain'), 'picked');
  });

  it('removes both listeners on uninstall', () => {
    const { host, uninstall } = install('picked');
    uninstall();
    assert.equal(host.listeners.size, 0);
  });
});
