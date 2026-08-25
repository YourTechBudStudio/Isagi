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
          ports: [
            {
              port: 5173,
              paths: [
                { label: 'app', path: '/' },
                { label: 'docs', path: '/docs' },
              ],
            },
            { envVar: 'API_PORT', paths: [{ label: 'api', path: '/api' }] },
            { port: 9229 },
          ],
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
    ports: [
      {
        kind: 'fixed',
        port: 5173,
        paths: [
          { label: 'app', path: '/' },
          { label: 'docs', path: '/docs' },
        ],
      },
      { kind: 'allocated', envVar: 'API_PORT', paths: [{ label: 'api', path: '/api' }] },
      { kind: 'fixed', port: 9229, paths: [] },
    ],
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

test('command catalog validates env shape', () => {
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

/**
 * The structured `ports` rules, one assertion per rule.
 *
 * `ports` is a strict corner of a strict corner: the runtime, not the user,
 * writes an allocated value into a process environment, so every ambiguity is
 * rejected loudly and path-precisely rather than resolved silently.
 */

test('command catalog rejects the legacy numeric ports array', () => {
  // The intentional break. A numeric entry must fail at its own path rather
  // than be converted into a fixed entry behind the user's back.
  assert.throws(
    () =>
      normalizeCommandCatalogConfig(
        { commands: [{ name: 'dev', command: 'pnpm dev', ports: [5173] }] },
        { worktreeRootPath: root },
      ),
    /commands\[0\]\.ports\[0\] must be an object\./,
  );
});

test('command catalog rejects non-object port and path entries', () => {
  for (const entry of ['5173', null, [5173], true]) {
    assert.throws(
      () =>
        normalizeCommandCatalogConfig(
          { commands: [{ name: 'dev', command: 'pnpm dev', ports: [entry] }] },
          { worktreeRootPath: root },
        ),
      /commands\[0\]\.ports\[0\] must be an object\./,
    );
  }
  assert.throws(
    () =>
      normalizeCommandCatalogConfig(
        { commands: [{ name: 'dev', command: 'pnpm dev', ports: [{ port: 5173, paths: ['/'] }] }] },
        { worktreeRootPath: root },
      ),
    /commands\[0\]\.ports\[0\]\.paths\[0\] must be an object\./,
  );
});

test('command catalog rejects unknown port and path fields', () => {
  assert.throws(
    () =>
      normalizeCommandCatalogConfig(
        {
          commands: [{ name: 'dev', command: 'pnpm dev', ports: [{ port: 5173, type: 'fixed' }] }],
        },
        { worktreeRootPath: root },
      ),
    /commands\[0\]\.ports\[0\]\.type is not a supported field\./,
  );
  assert.throws(
    () =>
      normalizeCommandCatalogConfig(
        {
          commands: [
            {
              name: 'dev',
              command: 'pnpm dev',
              ports: [{ port: 5173, paths: [{ label: 'app', path: '/', title: 'App' }] }],
            },
          ],
        },
        { worktreeRootPath: root },
      ),
    /commands\[0\]\.ports\[0\]\.paths\[0\]\.title is not a supported field\./,
  );
});

test('command catalog requires exactly one of port or envVar', () => {
  assert.throws(
    () =>
      normalizeCommandCatalogConfig(
        {
          commands: [
            { name: 'dev', command: 'pnpm dev', ports: [{ port: 5173, envVar: 'API_PORT' }] },
          ],
        },
        { worktreeRootPath: root },
      ),
    /commands\[0\]\.ports\[0\] must declare exactly one of port or envVar\./,
  );
  assert.throws(
    () =>
      normalizeCommandCatalogConfig(
        { commands: [{ name: 'dev', command: 'pnpm dev', ports: [{ paths: [] }] }] },
        { worktreeRootPath: root },
      ),
    /commands\[0\]\.ports\[0\] must declare exactly one of port or envVar\./,
  );
});

test('command catalog enforces the allocated env-var name grammar', () => {
  for (const envVar of ['1PORT', 'API-PORT', 'API PORT', 'API.PORT']) {
    assert.throws(
      () =>
        normalizeCommandCatalogConfig(
          { commands: [{ name: 'dev', command: 'pnpm dev', ports: [{ envVar }] }] },
          { worktreeRootPath: root },
        ),
      /commands\[0\]\.ports\[0\]\.envVar/,
    );
  }
});

test('command catalog rejects duplicate fixed ports and duplicate env vars', () => {
  assert.throws(
    () =>
      normalizeCommandCatalogConfig(
        {
          commands: [{ name: 'dev', command: 'pnpm dev', ports: [{ port: 5173 }, { port: 5173 }] }],
        },
        { worktreeRootPath: root },
      ),
    /commands\[0\]\.ports\[1\]\.port 5173 is declared more than once\./,
  );
  assert.throws(
    () =>
      normalizeCommandCatalogConfig(
        {
          commands: [
            {
              name: 'dev',
              command: 'pnpm dev',
              ports: [{ envVar: 'API_PORT' }, { envVar: 'API_PORT' }],
            },
          ],
        },
        { worktreeRootPath: root },
      ),
    /commands\[0\]\.ports\[1\]\.envVar API_PORT is declared more than once\./,
  );
});

test('command catalog rejects an allocated env var that collides with explicit env', () => {
  // Contradictory intent: the allocated value would silently win over the
  // author's own `env` entry, so the config is rejected instead.
  assert.throws(
    () =>
      normalizeCommandCatalogConfig(
        {
          commands: [
            {
              name: 'dev',
              command: 'pnpm dev',
              env: { API_PORT: '8080' },
              ports: [{ envVar: 'API_PORT' }],
            },
          ],
        },
        { worktreeRootPath: root },
      ),
    /commands\[0\]\.ports\[0\]\.envVar collides with env\.API_PORT; remove one\./,
  );
});

test('command catalog enforces label shape and uniqueness across the whole command', () => {
  assert.throws(
    () =>
      normalizeCommandCatalogConfig(
        {
          commands: [
            {
              name: 'dev',
              command: 'pnpm dev',
              ports: [{ port: 5173, paths: [{ label: ' app ', path: '/' }] }],
            },
          ],
        },
        { worktreeRootPath: root },
      ),
    /commands\[0\]\.ports\[0\]\.paths\[0\]\.label must not have leading or trailing whitespace\./,
  );
  // Uniqueness spans every entry, not just one port: two identical badges on
  // one command would be indistinguishable wherever they render.
  assert.throws(
    () =>
      normalizeCommandCatalogConfig(
        {
          commands: [
            {
              name: 'dev',
              command: 'pnpm dev',
              ports: [
                { port: 5173, paths: [{ label: 'app', path: '/' }] },
                { envVar: 'API_PORT', paths: [{ label: 'app', path: '/api' }] },
              ],
            },
          ],
        },
        { worktreeRootPath: root },
      ),
    /commands\[0\]\.ports\[1\]\.paths\[0\]\.label app is declared more than once\./,
  );
});

test('command catalog enforces path shape', () => {
  for (const path of ['app', '/app?x=1', '/app#top', '/app x', '']) {
    assert.throws(
      () =>
        normalizeCommandCatalogConfig(
          {
            commands: [
              {
                name: 'dev',
                command: 'pnpm dev',
                ports: [{ port: 5173, paths: [{ label: 'app', path }] }],
              },
            ],
          },
          { worktreeRootPath: root },
        ),
      /commands\[0\]\.ports\[0\]\.paths\[0\]\.path/,
    );
  }
});

test('command catalog rejects out-of-range fixed ports', () => {
  assert.throws(
    () =>
      normalizeCommandCatalogConfig(
        { commands: [{ name: 'dev', command: 'pnpm dev', ports: [{ port: 0 }] }] },
        { worktreeRootPath: root },
      ),
    /commands\[0\]\.ports\[0\]\.port/,
  );
});

test('command catalog defaults ports and paths to empty lists', () => {
  const config = normalizeCommandCatalogConfig(
    { commands: [{ name: 'dev', command: 'pnpm dev', ports: [{ envVar: 'API_PORT' }] }] },
    { worktreeRootPath: root },
  );

  assert.deepEqual(config.commands[0]?.ports, [
    { kind: 'allocated', envVar: 'API_PORT', paths: [] },
  ]);
  assert.deepEqual(
    normalizeCommandCatalogConfig(
      { commands: [{ name: 'dev', command: 'pnpm dev' }] },
      { worktreeRootPath: root },
    ).commands[0]?.ports,
    [],
  );
});
