import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join, normalize, resolve } from 'node:path';
import test from 'node:test';

import { Schema } from 'effect';

import {
  clientSettingsOutputSchema,
  terminalSettingsBounds,
  terminalSettingsDefaults,
} from '@isagi/contracts';

import {
  defaultRuntimeConfig,
  disabledHarnessPolicy,
  parseRuntimeConfig,
} from './runtime-config.policy.js';

test('harness policy distinguishes missing onboarding from an explicitly empty policy', () => {
  const missing = parseRuntimeConfig({ pty: { backend: 'node-pty' } }).harnesses;
  const empty = parseRuntimeConfig({ harnesses: {} }).harnesses;
  assert.equal(missing.status, 'missing');
  assert.equal(missing.onboardingComplete, false);
  assert.equal(empty.status, 'valid');
  assert.equal(empty.onboardingComplete, true);
  assert.notEqual(missing.revision, empty.revision);
  assert.deepEqual(empty.policy, disabledHarnessPolicy);
});
test('harness policy defaults partial fields false and ignores Docs intent for a disabled harness', () => {
  const state = parseRuntimeConfig({
    harnesses: { pi: { installIsagiDocs: true }, codex: { enabled: true } },
  }).harnesses;
  assert.deepEqual(state.policy.pi, { enabled: false, installIsagiDocs: false });
  assert.deepEqual(state.policy.codex, { enabled: true, installIsagiDocs: false });
});
test('invalid harness values fail closed without becoming onboarding defaults', () => {
  const state = parseRuntimeConfig({ harnesses: { pi: { enabled: 'yes' } } }).harnesses;
  assert.equal(state.status, 'invalid');
  assert.equal(state.onboardingComplete, false);
  assert.match(state.diagnostic ?? '', /boolean/i);
});

test('workflow directories default empty and normalize absolute and current-home paths', () => {
  const absolute = resolve('/tmp', 'isagi workflows', '..', 'shared ');
  const config = parseRuntimeConfig({
    workflows: { additionalDirectories: [absolute, '~', '~/isagi workflows'] },
  });
  assert.deepEqual(config.workflows.additionalDirectories, [
    normalize(absolute),
    normalize(homedir()),
    resolve(homedir(), 'isagi workflows'),
  ]);
  assert.deepEqual(parseRuntimeConfig({}).workflows.additionalDirectories, []);
  assert.deepEqual(
    parseRuntimeConfig({ workflows: { additionalDirectories: [] } }).workflows
      .additionalDirectories,
    [],
  );
});

test('workflow directories reject malformed shapes and non-absolute path policies', () => {
  for (const workflows of [
    [],
    { additionalDirectories: 'not-an-array' },
    { additionalDirectories: [42] },
    { additionalDirectories: [''] },
    { additionalDirectories: ['   '] },
    { additionalDirectories: ['relative/path'] },
    { additionalDirectories: ['~otheruser/workflows'] },
  ]) {
    assert.throws(() => parseRuntimeConfig({ workflows }));
  }
});

test('workflow directory normalization preserves duplicates for ordered source deduplication', () => {
  const root = resolve('/tmp', 'workflow-source');
  const config = parseRuntimeConfig({
    workflows: { additionalDirectories: [join(root, 'nested', '..'), root] },
  });
  assert.deepEqual(config.workflows.additionalDirectories, [root, root]);
});

test('terminal settings normalize missing, empty, partial, and unknown-property input', () => {
  assert.deepEqual(defaultRuntimeConfig.terminal, terminalSettingsDefaults);
  assert.deepEqual(parseRuntimeConfig({}).terminal, terminalSettingsDefaults);
  assert.deepEqual(parseRuntimeConfig({ terminal: {} }).terminal, terminalSettingsDefaults);
  assert.deepEqual(
    parseRuntimeConfig({ terminal: { cache: {} } }).terminal,
    terminalSettingsDefaults,
  );
  assert.deepEqual(
    parseRuntimeConfig({
      terminal: {
        scrollbackLines: 12_000,
        cache: { maxHiddenSessions: 9, unknown: 'ignored' },
        unknown: 'ignored',
      },
    }).terminal,
    {
      scrollbackLines: 12_000,
      cache: {
        idleTtlMinutes: 180,
        maxHiddenSessions: 9,
        maxEstimatedBufferMiB: 64,
      },
    },
  );
});

test('terminal settings accept defaults, zero, and inclusive upper bounds', () => {
  const cases = [
    ['scrollbackLines', terminalSettingsDefaults.scrollbackLines, { scrollbackLines: 5_000 }],
    ['scrollbackLines zero', 0, { scrollbackLines: 0 }],
    [
      'scrollbackLines upper bound',
      terminalSettingsBounds.scrollbackLines.maximum,
      { scrollbackLines: terminalSettingsBounds.scrollbackLines.maximum },
    ],
    ['idleTtlMinutes zero', 0, { cache: { idleTtlMinutes: 0 } }],
    [
      'idleTtlMinutes upper bound',
      terminalSettingsBounds.cache.idleTtlMinutes.maximum,
      { cache: { idleTtlMinutes: terminalSettingsBounds.cache.idleTtlMinutes.maximum } },
    ],
    ['maxHiddenSessions zero', 0, { cache: { maxHiddenSessions: 0 } }],
    [
      'maxHiddenSessions upper bound',
      terminalSettingsBounds.cache.maxHiddenSessions.maximum,
      { cache: { maxHiddenSessions: terminalSettingsBounds.cache.maxHiddenSessions.maximum } },
    ],
    ['maxEstimatedBufferMiB zero', 0, { cache: { maxEstimatedBufferMiB: 0 } }],
    [
      'maxEstimatedBufferMiB upper bound',
      terminalSettingsBounds.cache.maxEstimatedBufferMiB.maximum,
      {
        cache: {
          maxEstimatedBufferMiB: terminalSettingsBounds.cache.maxEstimatedBufferMiB.maximum,
        },
      },
    ],
  ] as const;

  for (const [label, expected, terminal] of cases) {
    const parsed = parseRuntimeConfig({ terminal }).terminal;
    const actual =
      'scrollbackLines' in terminal
        ? parsed.scrollbackLines
        : parsed.cache[Object.keys(terminal.cache)[0] as keyof typeof parsed.cache];
    assert.equal(actual, expected, label);
  }
});

test('terminal settings reject malformed values at the user-input boundary', () => {
  const invalidCases = [
    null,
    [],
    { scrollbackLines: null },
    { scrollbackLines: -1 },
    { scrollbackLines: 100_001 },
    { scrollbackLines: 1.5 },
    { scrollbackLines: '5000' },
    { cache: null },
    { cache: { idleTtlMinutes: -1 } },
    { cache: { idleTtlMinutes: 10_081 } },
    { cache: { idleTtlMinutes: 1.5 } },
    { cache: { idleTtlMinutes: '180' } },
    { cache: { maxHiddenSessions: -1 } },
    { cache: { maxHiddenSessions: 33 } },
    { cache: { maxHiddenSessions: 1.5 } },
    { cache: { maxHiddenSessions: '4' } },
    { cache: { maxEstimatedBufferMiB: -1 } },
    { cache: { maxEstimatedBufferMiB: 2_049 } },
    { cache: { maxEstimatedBufferMiB: 1.5 } },
    { cache: { maxEstimatedBufferMiB: '64' } },
  ];
  for (const terminal of invalidCases) {
    assert.throws(() => parseRuntimeConfig({ terminal }), JSON.stringify(terminal));
  }
});

test('client settings wire schema requires normalized fields and enforces canonical bounds', () => {
  const decode = Schema.decodeUnknownSync(clientSettingsOutputSchema);
  assert.deepEqual(decode({ terminal: terminalSettingsDefaults }), {
    terminal: terminalSettingsDefaults,
  });
  assert.throws(() => decode({ terminal: {} }));
  const cases = [
    {
      key: 'scrollbackLines',
      maximum: terminalSettingsBounds.scrollbackLines.maximum,
      withValue: (value: unknown) => ({
        ...terminalSettingsDefaults,
        scrollbackLines: value,
      }),
    },
    {
      key: 'idleTtlMinutes',
      maximum: terminalSettingsBounds.cache.idleTtlMinutes.maximum,
      withValue: (value: unknown) => ({
        ...terminalSettingsDefaults,
        cache: { ...terminalSettingsDefaults.cache, idleTtlMinutes: value },
      }),
    },
    {
      key: 'maxHiddenSessions',
      maximum: terminalSettingsBounds.cache.maxHiddenSessions.maximum,
      withValue: (value: unknown) => ({
        ...terminalSettingsDefaults,
        cache: { ...terminalSettingsDefaults.cache, maxHiddenSessions: value },
      }),
    },
    {
      key: 'maxEstimatedBufferMiB',
      maximum: terminalSettingsBounds.cache.maxEstimatedBufferMiB.maximum,
      withValue: (value: unknown) => ({
        ...terminalSettingsDefaults,
        cache: { ...terminalSettingsDefaults.cache, maxEstimatedBufferMiB: value },
      }),
    },
  ];
  for (const entry of cases) {
    assert.doesNotThrow(() => decode({ terminal: entry.withValue(0) }), `${entry.key} zero`);
    assert.doesNotThrow(
      () => decode({ terminal: entry.withValue(entry.maximum) }),
      `${entry.key} upper bound`,
    );
    for (const invalid of [-1, entry.maximum + 1, 1.5, '1', null]) {
      assert.throws(
        () => decode({ terminal: entry.withValue(invalid) }),
        `${entry.key} accepted ${JSON.stringify(invalid)}`,
      );
    }
  }
});
