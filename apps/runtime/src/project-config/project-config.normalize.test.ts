import assert from 'node:assert/strict';
import test from 'node:test';

import { hashWorktreeHooks } from './project-config.hash.js';
import { normalizeWorktreeHooksConfig } from './project-config.normalize.js';

test('worktree hooks treat missing hook config as not configured', () => {
  assert.equal(normalizeWorktreeHooksConfig({}), null);
  assert.equal(normalizeWorktreeHooksConfig({ worktrees: {} }), null);
  assert.equal(normalizeWorktreeHooksConfig({ worktrees: { hooks: {} } }), null);
});

test('worktree hooks preserve normalized defaults for all hook types', () => {
  const config = normalizeWorktreeHooksConfig({
    worktrees: {
      hooks: {
        postCreate: [
          { type: 'copy', src: '.env.example', dest: '.env' },
          { type: 'symlink', src: 'scripts', dest: 'scripts', overwrite: false },
          { type: 'command', run: 'pnpm install', env: { CI: '1' } },
        ],
      },
    },
  });

  assert.deepEqual(config, {
    postCreate: [
      {
        type: 'copy',
        src: '.env.example',
        dest: '.env',
        include: ['**/*'],
        exclude: [],
        overwrite: true,
      },
      { type: 'symlink', src: 'scripts', dest: 'scripts', overwrite: false },
      { type: 'command', run: 'pnpm install', cwd: '.', timeout: '10m', env: { CI: '1' } },
    ],
  });
});

test('worktree hook trust hash stays stable for unchanged normalized config', () => {
  const config = normalizeWorktreeHooksConfig({
    worktrees: {
      hooks: {
        postCreate: [
          { type: 'copy', src: '.env.example', dest: '.env' },
          { type: 'symlink', src: 'scripts', dest: 'scripts', overwrite: false },
          { type: 'command', run: 'pnpm install', env: { CI: '1' } },
        ],
      },
    },
  });

  assert.ok(config);
  assert.equal(
    hashWorktreeHooks(config),
    'd8a3e150518719cd2f3bd814ef54766e0a8750cdde77e48a8f83a29d74572a76',
  );
});

test('worktree hooks reject malformed hook shapes while naming the field', () => {
  assert.throws(
    () =>
      normalizeWorktreeHooksConfig({
        worktrees: { hooks: { postCreate: { type: 'copy' } } },
      }),
    /worktrees\.hooks\.postCreate/,
  );

  assert.throws(
    () =>
      normalizeWorktreeHooksConfig({
        worktrees: { hooks: { postCreate: [{ type: 'copy', src: '', dest: '.env' }] } },
      }),
    /worktrees\.hooks\.postCreate\[0\]\.src/,
  );

  assert.throws(
    () =>
      normalizeWorktreeHooksConfig({
        worktrees: {
          hooks: { postCreate: [{ type: 'command', run: 'pnpm install', env: { CI: 1 } }] },
        },
      }),
    /worktrees\.hooks\.postCreate\[0\]\.env\.CI/,
  );

  assert.throws(
    () =>
      normalizeWorktreeHooksConfig({
        worktrees: { hooks: { postCreate: [{ type: 'command', run: '   ' }] } },
      }),
    /worktrees\.hooks\.postCreate\[0\]\.run/,
  );

  assert.throws(
    () =>
      normalizeWorktreeHooksConfig({
        worktrees: {
          hooks: { postCreate: [{ type: 'command', run: 'pnpm install', cwd: '   ' }] },
        },
      }),
    /worktrees\.hooks\.postCreate\[0\]\.cwd/,
  );

  assert.throws(
    () =>
      normalizeWorktreeHooksConfig({
        worktrees: {
          hooks: {
            postCreate: [{ type: 'copy', src: '.env.example', dest: '.env', include: ['   '] }],
          },
        },
      }),
    /worktrees\.hooks\.postCreate\[0\]\.include\[0\]/,
  );

  assert.throws(
    () =>
      normalizeWorktreeHooksConfig({
        worktrees: {
          hooks: {
            postCreate: [{ type: 'copy', src: '.env.example', dest: '.env', exclude: ['   '] }],
          },
        },
      }),
    /worktrees\.hooks\.postCreate\[0\]\.exclude\[0\]/,
  );
});

test('worktree hooks preserve loose parse behavior for hook paths and timeout grammar', () => {
  const config = normalizeWorktreeHooksConfig({
    worktrees: {
      hooks: {
        postCreate: [
          { type: 'copy', src: '/tmp/source', dest: '../outside' },
          { type: 'command', run: 'pnpm install', cwd: '/tmp', timeout: 'banana' },
        ],
      },
    },
  });

  assert.deepEqual(config?.postCreate, [
    {
      type: 'copy',
      src: '/tmp/source',
      dest: '../outside',
      include: ['**/*'],
      exclude: [],
      overwrite: true,
    },
    { type: 'command', run: 'pnpm install', cwd: '/tmp', timeout: 'banana', env: {} },
  ]);
});
