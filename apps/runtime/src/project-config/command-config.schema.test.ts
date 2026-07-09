import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeCommandCatalogConfig } from './project-config.normalize.js';

const root = '/repo/isagi';

test('command catalog treats missing commands as an empty catalog', () => {
  assert.deepEqual(normalizeCommandCatalogConfig({ worktrees: {} }, { worktreeRootPath: root }), {
    commands: [],
  });
});

test('command catalog accepts a valid command with all phase-one fields', () => {
  const config = normalizeCommandCatalogConfig(
    {
      commands: [
        {
          name: 'dev server',
          command: 'pnpm dev',
          cwd: 'apps/web',
          ports: [5173],
          envFiles: ['.env', '.env.local'],
          env: { PORT: '5173' },
          lifecycle: {
            postCreate: { start: true },
            activate: { start: false },
            deactivate: { stop: true },
            preDelete: { stop: true },
          },
        },
      ],
    },
    { worktreeRootPath: root },
  );

  assert.deepEqual(config.commands[0], {
    name: 'dev server',
    command: 'pnpm dev',
    cwd: 'apps/web',
    ports: [5173],
    envFiles: ['.env', '.env.local'],
    env: { PORT: '5173' },
    lifecycle: {
      postCreate: { start: true },
      activate: { start: false },
      deactivate: { stop: true },
      preDelete: { stop: true },
    },
  });
});

test('command catalog applies lifecycle defaults', () => {
  const config = normalizeCommandCatalogConfig(
    { commands: [{ name: 'dev', command: 'pnpm dev' }] },
    { worktreeRootPath: root },
  );

  assert.deepEqual(config.commands[0]?.lifecycle, {
    postCreate: { start: false },
    activate: { start: false },
    deactivate: { stop: true },
    preDelete: { stop: true },
  });
});

test('command catalog rejects duplicate names case-sensitively by exact identity', () => {
  assert.throws(
    () =>
      normalizeCommandCatalogConfig(
        {
          commands: [
            { name: 'dev', command: 'pnpm dev' },
            { name: 'dev', command: 'pnpm dev:again' },
          ],
        },
        { worktreeRootPath: root },
      ),
    /Duplicate command name: dev/,
  );

  assert.equal(
    normalizeCommandCatalogConfig(
      {
        commands: [
          { name: 'dev', command: 'pnpm dev' },
          { name: 'Dev', command: 'pnpm dev:again' },
        ],
      },
      { worktreeRootPath: root },
    ).commands.length,
    2,
  );
});

test('command catalog rejects malformed command shape', () => {
  assert.throws(
    () =>
      normalizeCommandCatalogConfig(
        { commands: [{ name: 'dev', command: 'pnpm dev', run: 'pnpm dev' }] },
        { worktreeRootPath: root },
      ),
    /run is not a supported field/,
  );
  assert.throws(
    () =>
      normalizeCommandCatalogConfig(
        { commands: [{ name: ' dev ', command: 'pnpm dev' }] },
        { worktreeRootPath: root },
      ),
    /leading or trailing whitespace/,
  );
  assert.throws(
    () =>
      normalizeCommandCatalogConfig(
        { commands: [{ name: 'dev', command: '' }] },
        { worktreeRootPath: root },
      ),
    /commands\[0\]\.command/,
  );
  assert.throws(
    () =>
      normalizeCommandCatalogConfig(
        { commands: [{ name: 'dev', command: '   ' }] },
        { worktreeRootPath: root },
      ),
    /commands\[0\]\.command/,
  );
});

test('command catalog rejects invalid lifecycle fields and nulls', () => {
  assert.throws(
    () =>
      normalizeCommandCatalogConfig(
        { commands: [{ name: 'dev', command: 'pnpm dev', lifecycle: null }] },
        { worktreeRootPath: root },
      ),
    /commands\[0\]\.lifecycle/,
  );
  assert.throws(
    () =>
      normalizeCommandCatalogConfig(
        { commands: [{ name: 'dev', command: 'pnpm dev', lifecycle: { restart: {} } }] },
        { worktreeRootPath: root },
      ),
    /restart is not a supported field/,
  );
  assert.throws(
    () =>
      normalizeCommandCatalogConfig(
        {
          commands: [{ name: 'dev', command: 'pnpm dev', lifecycle: { activate: { stop: true } } }],
        },
        { worktreeRootPath: root },
      ),
    /activate.stop is not a supported field/,
  );
});

test('command catalog validates ports and env shape', () => {
  assert.throws(
    () =>
      normalizeCommandCatalogConfig(
        { commands: [{ name: 'dev', command: 'pnpm dev', ports: [0] }] },
        { worktreeRootPath: root },
      ),
    /commands\[0\]\.ports\[0\]/,
  );
  assert.throws(
    () =>
      normalizeCommandCatalogConfig(
        { commands: [{ name: 'dev', command: 'pnpm dev', env: { PORT: 5173 } }] },
        { worktreeRootPath: root },
      ),
    /commands\[0\]\.env\.PORT/,
  );
  assert.throws(
    () =>
      normalizeCommandCatalogConfig(
        { commands: [{ name: 'dev', command: 'pnpm dev', env: { '': 'value' } }] },
        { worktreeRootPath: root },
      ),
    /env keys must be non-empty strings/,
  );
});

test('command catalog validates path syntax and worktree boundary only', () => {
  assert.throws(
    () =>
      normalizeCommandCatalogConfig(
        { commands: [{ name: 'dev', command: 'pnpm dev', cwd: '' }] },
        { worktreeRootPath: root },
      ),
    /commands\[0\]\.cwd/,
  );
  assert.throws(
    () =>
      normalizeCommandCatalogConfig(
        { commands: [{ name: 'dev', command: 'pnpm dev', cwd: '   ' }] },
        { worktreeRootPath: root },
      ),
    /commands\[0\]\.cwd/,
  );
  assert.throws(
    () =>
      normalizeCommandCatalogConfig(
        { commands: [{ name: 'dev', command: 'pnpm dev', cwd: '/tmp' }] },
        { worktreeRootPath: root },
      ),
    /cwd must be relative/,
  );
  assert.throws(
    () =>
      normalizeCommandCatalogConfig(
        { commands: [{ name: 'dev', command: 'pnpm dev', envFiles: ['../shared/.env'] }] },
        { worktreeRootPath: root },
      ),
    /envFiles\[0\] must stay inside the worktree root/,
  );
  assert.throws(
    () =>
      normalizeCommandCatalogConfig(
        { commands: [{ name: 'dev', command: 'pnpm dev', envFiles: ['   '] }] },
        { worktreeRootPath: root },
      ),
    /commands\[0\]\.envFiles\[0\]/,
  );

  assert.deepEqual(
    normalizeCommandCatalogConfig(
      {
        commands: [
          { name: 'dev', command: 'pnpm dev', cwd: 'missing-dir', envFiles: ['.env', '..env'] },
        ],
      },
      { worktreeRootPath: root },
    ).commands[0]?.envFiles,
    ['.env', '..env'],
  );
});
