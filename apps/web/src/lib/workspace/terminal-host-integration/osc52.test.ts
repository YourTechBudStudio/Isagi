import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { browserClipboardWriter, type TerminalClipboardWriter } from './clipboard.js';
import {
  createOsc52Handler,
  decodeOsc52Write,
  installOsc52Clipboard,
  OSC52_MAX_PAYLOAD_LENGTH,
} from './osc52.js';

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function harness(options: { canWrite?: () => boolean; writeText?: TerminalClipboardWriter } = {}) {
  const writes: string[] = [];
  const failures = { count: 0 };
  const handler = createOsc52Handler({
    canWrite: options.canWrite ?? (() => true),
    writeText:
      options.writeText ??
      ((text) => {
        writes.push(text);
        return Promise.resolve();
      }),
    onWriteFailed: () => {
      failures.count += 1;
    },
  });
  return { handler, writes, failures };
}

describe('OSC 52 decoding', () => {
  it('decodes UTF-8 text, not one char per byte', () => {
    assert.equal(decodeOsc52Write(`c;${b64('héllo, 世界 🚀')}`), 'héllo, 世界 🚀');
  });

  it('accepts an empty selection and any target naming c or s', () => {
    for (const selection of ['', 'c', 's', 'pc', 'cs']) {
      assert.equal(decodeOsc52Write(`${selection};${b64('x')}`), 'x', selection);
    }
  });

  it('ignores targets with no browser equivalent', () => {
    for (const selection of ['p', 'q', '0', '7']) {
      assert.equal(decodeOsc52Write(`${selection};${b64('x')}`), null, selection);
    }
  });

  it('ignores reads, empty payloads, invalid base64 and a missing separator', () => {
    assert.equal(decodeOsc52Write('c;?'), null);
    assert.equal(decodeOsc52Write('c;'), null);
    assert.equal(decodeOsc52Write('c;not base64!'), null);
    assert.equal(decodeOsc52Write(b64('x')), null);
  });

  it('ignores payloads over the cap and accepts one at it', () => {
    const atCap = 'A'.repeat(OSC52_MAX_PAYLOAD_LENGTH);
    assert.notEqual(decodeOsc52Write(`c;${atCap}`), null);
    assert.equal(decodeOsc52Write(`c;${atCap}AAAA`), null);
  });
});

describe('OSC 52 handler', () => {
  it('always consumes the sequence synchronously and writes without waiting', () => {
    const pending: Array<() => void> = [];
    const { handler } = harness({
      writeText: () => new Promise<void>((resolve) => pending.push(resolve)),
    });
    assert.equal(handler(`c;${b64('x')}`), true);
    assert.equal(handler('c;?'), true);
    assert.equal(handler('garbage'), true);
    assert.equal(pending.length, 1, 'only the valid write reached the clipboard');
  });

  it('never writes or replies for a read request', () => {
    const { handler, writes, failures } = harness();
    handler('c;?');
    assert.deepEqual(writes, []);
    assert.equal(failures.count, 0);
  });

  it('writes nothing for invalid or oversized payloads', () => {
    const { handler, writes } = harness();
    handler('c;%%%');
    handler(`c;${'A'.repeat(OSC52_MAX_PAYLOAD_LENGTH + 4)}`);
    assert.deepEqual(writes, []);
  });

  it('asks the policy on every request, and a refusal means no write', () => {
    let allowed = false;
    let asked = 0;
    const { handler, writes } = harness({
      canWrite: () => {
        asked += 1;
        return allowed;
      },
    });
    handler(`c;${b64('refused')}`);
    allowed = true;
    handler(`c;${b64('allowed')}`);
    assert.equal(asked, 2);
    assert.deepEqual(writes, ['allowed']);
  });

  it('reports a rejected write once', async () => {
    const { handler, failures } = harness({ writeText: () => Promise.reject(new Error('no')) });
    handler(`c;${b64('x')}`);
    await settle();
    assert.equal(failures.count, 1);
  });

  it('reports a writer that throws synchronously once', () => {
    const { handler, failures } = harness({
      writeText: () => {
        throw new Error('no');
      },
    });
    handler(`c;${b64('x')}`);
    assert.equal(failures.count, 1);
  });

  it('installs on the parser as OSC 52 and disposes', () => {
    let registered: { ident: number; disposed: boolean } | null = null;
    const disposable = installOsc52Clipboard(
      {
        parser: {
          registerOscHandler: (ident: number) => {
            const entry = { ident, disposed: false };
            registered = entry;
            return { dispose: () => (entry.disposed = true) };
          },
        } as never,
      },
      { canWrite: () => true, writeText: () => Promise.resolve(), onWriteFailed: () => undefined },
    );
    assert.deepEqual(registered, { ident: 52, disposed: false });
    disposable.dispose();
    assert.deepEqual(registered, { ident: 52, disposed: true });
  });
});

describe('browser clipboard writer', () => {
  const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  const setClipboard = (value: unknown) =>
    Object.defineProperty(navigator, 'clipboard', { value, configurable: true });
  afterEach(() => {
    if (original) Object.defineProperty(navigator, 'clipboard', original);
    else delete (navigator as { clipboard?: unknown }).clipboard;
  });

  it('rejects when the API is missing, so the failure is reported once', async () => {
    setClipboard(undefined);
    const { handler, failures } = harness({ writeText: browserClipboardWriter });
    handler(`c;${b64('x')}`);
    await settle();
    assert.equal(failures.count, 1);
  });

  it('reads the clipboard at write time, not at install time', async () => {
    setClipboard(undefined);
    const { handler, failures } = harness({ writeText: browserClipboardWriter });
    const written: string[] = [];
    setClipboard({
      writeText: (text: string) => {
        written.push(text);
        return Promise.resolve();
      },
    });
    handler(`c;${b64('late')}`);
    await settle();
    assert.deepEqual(written, ['late']);
    assert.equal(failures.count, 0);
  });
});
