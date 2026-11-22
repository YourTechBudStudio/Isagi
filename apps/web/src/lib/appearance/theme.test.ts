import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ensureDocumentTheme, readDocumentTheme } from './theme.js';

function root(theme?: string) {
  return { dataset: theme === undefined ? {} : { theme } } as unknown as HTMLElement;
}

describe('document theme', () => {
  it('reads the served theme', () => {
    assert.equal(readDocumentTheme(root('dark')), 'dark');
    assert.equal(readDocumentTheme(root('light')), 'light');
    assert.equal(readDocumentTheme(root('system')), undefined);
    assert.equal(readDocumentTheme(root()), undefined);
  });

  it('keeps the served theme and paints the default only when there is none', () => {
    const served = root('dark');
    ensureDocumentTheme(served);
    assert.equal(served.dataset.theme, 'dark');
    const bare = root();
    ensureDocumentTheme(bare);
    assert.equal(bare.dataset.theme, 'light');
    const invalid = root('system');
    ensureDocumentTheme(invalid);
    assert.equal(invalid.dataset.theme, 'light');
  });

  it('never touches browser storage', () => {
    const storage = new Proxy({}, { get: () => assert.fail('localStorage was accessed') });
    Object.assign(globalThis, { window: { localStorage: storage }, localStorage: storage });
    try {
      ensureDocumentTheme(root());
      readDocumentTheme(root('dark'));
    } finally {
      Reflect.deleteProperty(globalThis, 'window');
      Reflect.deleteProperty(globalThis, 'localStorage');
    }
  });
});
