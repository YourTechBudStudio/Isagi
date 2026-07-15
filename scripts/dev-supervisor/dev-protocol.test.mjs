import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  developmentControlPrefix,
  developmentEnvironmentKeys,
  developmentPaths,
  developmentProtocolVersion,
  formatDevelopmentControl,
  formatRuntimeLogRecord,
  formatWebReadiness,
  parseDevelopmentControl,
  privateRuntimeEnvironmentKeys,
  runtimeLogPrefix,
  webReadinessPrefix,
} from './dev-protocol.mjs';

const declaration = readFileSync(
  fileURLToPath(new URL('./dev-protocol.d.mts', import.meta.url)),
  'utf8',
);

test('private development protocol values agree with their TypeScript declaration', () => {
  const literalExports = {
    developmentProtocolVersion,
    developmentControlPrefix,
    runtimeLogPrefix,
    webReadinessPrefix,
  };
  for (const [name, value] of Object.entries(literalExports)) {
    const literal = typeof value === 'string' ? `'${value}'` : String(value);
    assert.ok(declaration.includes(`export const ${name}: ${literal};`), name);
  }

  for (const [name, value] of Object.entries(developmentEnvironmentKeys)) {
    assert.ok(declaration.includes(`${name}: '${value}';`), name);
  }
  assert.deepEqual(privateRuntimeEnvironmentKeys, Object.values(developmentEnvironmentKeys));
});

test('private development paths and record helpers retain the declared shape', () => {
  const paths = developmentPaths('/checkout');
  assert.deepEqual(Object.keys(paths), [
    'root',
    'dataRoot',
    'userData',
    'lock',
    'desktopRoot',
    'runtimeStage',
  ]);
  for (const field of Object.keys(paths)) {
    assert.match(declaration, new RegExp(`readonly ${field}: string;`));
  }

  const control = formatDevelopmentControl({ runtimeStage: 'ready', protocolVersion: 99 });
  assert.deepEqual(parseDevelopmentControl(control), {
    runtimeStage: 'ready',
    protocolVersion: developmentProtocolVersion,
  });
  assert.match(
    formatRuntimeLogRecord({ stream: 'stderr', payload: '\u001b[31mfailed\u001b[0m\n' }),
    new RegExp(`^${runtimeLogPrefix}`),
  );
  assert.match(
    formatWebReadiness({ mode: 'dev', url: 'http://127.0.0.1:5173/' }),
    new RegExp(`^${webReadinessPrefix}`),
  );
});
