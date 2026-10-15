// Config failures must never render config text: `config.yaml` can hold inline API keys. Every case
// writes a sentinel key into the file and checks each surface a failure reaches: the error's own
// message, the safe-diagnostic walk, startup output and the harnesses diagnostic.
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Cause, Effect, Exit, Redacted } from 'effect';

import { formatStartupFailure } from '../app/startup-diagnostics.js';
import { describeOperationalCause } from '../platform/diagnostics/index.js';
import { DataDirectory } from '../platform/persistence/index.js';
import { makeTestDataDirectory } from '../platform/persistence/testing.js';
import { parseRuntimeConfig } from './policy.js';
import { RuntimeConfig, type RuntimeConfigError } from './service.js';

const sentinel = 'sk-isagi-SENTINEL-7f3a9c';

const fluidcastSection = (apiKey: string) =>
  [
    'fluidcast:',
    '  enabled: true',
    '  languageModel:',
    '    provider: openai',
    `    apiKey: ${apiKey}`,
    '    model: gpt-test',
    '  speech:',
    '    model: tts-test',
    `    apiKey: ${apiKey}`,
    '  preset:',
    '    voice:',
    '      name: alloy',
    '',
  ].join('\n');

/** Builds the config service over `bytes`, returning the startup exit. */
async function start(bytes: string, prepare?: (path: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'isagi-config-secrets-'));
  const path = join(root, 'config.yaml');
  try {
    writeFileSync(path, bytes, 'utf8');
    prepare?.(path);
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        return yield* (yield* RuntimeConfig).get;
      }).pipe(
        Effect.provide(RuntimeConfig.layer),
        Effect.provideService(DataDirectory, makeTestDataDirectory(root)),
      ),
    );
    return { exit, path };
  } finally {
    chmodSync(root, 0o700);
    try {
      chmodSync(path, 0o600);
    } catch {}
    rmSync(root, { recursive: true, force: true });
  }
}

function failureOf(exit: Exit.Exit<unknown, RuntimeConfigError>): RuntimeConfigError {
  assert.ok(Exit.isFailure(exit), 'expected startup to fail');
  const error = Cause.findErrorOption(exit.cause);
  assert.ok(error._tag === 'Some', 'expected a typed RuntimeConfigError');
  return error.value;
}

/** Every rendered surface of a startup failure, with the sentinel absent from each. */
function assertNoSentinel(error: RuntimeConfigError) {
  const surfaces = {
    message: error.message,
    string: String(error),
    safeDiagnostic: describeOperationalCause(error),
    startup: formatStartupFailure(Cause.fail(error)),
    json: JSON.stringify(error),
  };
  for (const [surface, text] of Object.entries(surfaces)) {
    assert.equal(text.includes(sentinel), false, `${surface} leaked the sentinel: ${text}`);
  }
  return surfaces;
}

test('a YAML syntax error next to an inline key names its code and position, never the source', async () => {
  const { exit, path } = await start(`${fluidcastSection(sentinel)}  bad: [${sentinel}\n`);
  const error = failureOf(exit);
  assert.equal(error.failure.reason, 'yaml_syntax');
  const { startup, safeDiagnostic } = assertNoSentinel(error);
  assert.match(startup, /config\.yaml is not valid YAML \([A-Z_]+ at \d+:\d+\)/);
  assert.ok(startup.includes(path), 'startup output names the config path');
  assert.equal(safeDiagnostic, error.message);
});

test('a schema error in terminal names its issue path, never the value', async () => {
  const { exit } = await start(
    `${fluidcastSection(sentinel)}terminal:\n  scrollbackLines: ${sentinel}\n`,
  );
  const error = failureOf(exit);
  assert.deepEqual(error.failure, {
    reason: 'schema_invalid',
    issuePaths: ['terminal.scrollbackLines'],
  });
  const { startup } = assertNoSentinel(error);
  assert.match(startup, /config\.yaml is invalid at terminal\.scrollbackLines/);
});

test('a non-absolute workflow directory names its index, never the configured path', async () => {
  const { exit } = await start(`workflows:\n  additionalDirectories:\n    - ${sentinel}/dir\n`);
  const error = failureOf(exit);
  assert.deepEqual(error.failure, {
    reason: 'schema_invalid',
    issuePaths: ['workflows.additionalDirectories.0'],
  });
  assertNoSentinel(error);
});

test('an unreadable config file names the system error code, never the contents', async () => {
  const { exit } = await start(fluidcastSection(sentinel), (path) => chmodSync(path, 0o000));
  const error = failureOf(exit);
  assert.deepEqual(error.failure, { reason: 'read_failed', errno: 'EACCES' });
  const { startup } = assertNoSentinel(error);
  assert.match(startup, /config\.yaml could not be read \(EACCES\)/);
});

test('an invalid fluidcast section does not fail startup and keeps only issue paths', async () => {
  const invalid = fluidcastSection(sentinel).replace('model: gpt-test', `model: 42`);
  const { exit } = await start(`harnesses: {}\n${invalid}`);
  assert.ok(Exit.isSuccess(exit));
  assert.deepEqual(exit.value.fluidcast, {
    status: 'invalid',
    issuePaths: ['fluidcast.languageModel.model'],
  });
  assert.equal(exit.value.harnesses.status, 'valid');
  assert.equal(JSON.stringify(exit.value).includes(sentinel), false);
});

test('a ready fluidcast section keeps keys redacted when rendered', async () => {
  const { exit } = await start(fluidcastSection(sentinel));
  assert.ok(Exit.isSuccess(exit));
  const state = exit.value.fluidcast;
  assert.ok(state.status === 'ready');
  assert.equal(Redacted.value(state.config.speech.apiKey), sentinel);
  for (const text of [JSON.stringify(state), String(state.config.speech.apiKey)]) {
    assert.equal(text.includes(sentinel), false, `rendered the key: ${text}`);
  }
});

test('the harnesses diagnostic names issue paths, never the invalid value', () => {
  const state = parseRuntimeConfig({ harnesses: { claude: { enabled: sentinel } } }).harnesses;
  assert.equal(state.status, 'invalid');
  assert.equal(state.diagnostic, 'invalid harness policy at claude.enabled');
});

test('a YAML conversion failure after a clean parse names no source text, at startup', async () => {
  // Parses cleanly, then fails converting the unresolved alias, whose error quotes its name.
  const { exit } = await start(`fluidcast:\n  speech:\n    apiKey: *${sentinel}\n`);
  const error = failureOf(exit);
  assert.deepEqual(error.failure, {
    reason: 'yaml_syntax',
    yamlCode: 'YAML_CONVERSION_FAILED',
    line: null,
    column: null,
  });
  const { startup } = assertNoSentinel(error);
  assert.match(startup, /config\.yaml is not valid YAML \(YAML_CONVERSION_FAILED\)/);
});

test('a YAML conversion failure during a harness-policy write names no source text', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-config-secrets-mutation-'));
  const path = join(root, 'config.yaml');
  try {
    writeFileSync(path, 'harnesses: {}\n', 'utf8');
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const config = yield* RuntimeConfig;
        const before = yield* config.get;
        writeFileSync(path, `harnesses: {}\nfluidcast:\n  speech:\n    apiKey: *${sentinel}\n`);
        return yield* config.acceptHarnessPolicy({
          expectedPolicyRevision: before.harnesses.revision,
          policy: before.harnesses.policy,
        });
      }).pipe(
        Effect.provide(RuntimeConfig.layer),
        Effect.provideService(DataDirectory, makeTestDataDirectory(root)),
      ),
    );
    const error = failureOf(exit as Exit.Exit<unknown, RuntimeConfigError>);
    assert.equal(error.failure.reason, 'yaml_syntax');
    assertNoSentinel(error);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
