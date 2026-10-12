import assert from 'node:assert/strict';
import test from 'node:test';

import { hashWorktreeHooks } from './hash.js';
import { normalizeWorktreeHooksConfig } from './normalize.js';

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
    'c68dc78aa0e6193db08e15e1b201637e9ae2e4d984a40e6933b2fffc5db17f48',
  );
});

test('worktree hook trust hash changes when copy filters are configured', () => {
  const hashFor = (copy: Record<string, unknown>) => {
    const config = normalizeWorktreeHooksConfig({
      worktrees: {
        hooks: { postCreate: [{ type: 'copy', src: 'config', dest: 'config', ...copy }] },
      },
    });
    assert.ok(config);
    return hashWorktreeHooks(config);
  };

  const unfiltered = hashFor({});
  assert.notEqual(hashFor({ include: ['**/*'] }), unfiltered);
  assert.notEqual(hashFor({ exclude: ['**/*.example'] }), unfiltered);
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
      overwrite: true,
    },
    { type: 'command', run: 'pnpm install', cwd: '/tmp', timeout: 'banana', env: {} },
  ]);
});

test('worktree hook decode errors name the field, the expectation and the offending value', () => {
  const failureFor = (hook: unknown) => {
    try {
      normalizeWorktreeHooksConfig({ worktrees: { hooks: { postCreate: [hook] } } });
    } catch (error) {
      return (error as Error).message;
    }
    return assert.fail('expected the hook config to be rejected');
  };

  assert.equal(
    failureFor(null),
    'worktrees.hooks.postCreate[0] Expected a hook object with type copy, symlink, or command, got null',
  );
  assert.equal(
    failureFor({ type: 'command', run: 'pnpm install', env: { CI: 1 } }),
    'worktrees.hooks.postCreate[0].env.CI Expected string, got 1',
  );
  assert.equal(
    failureFor({ type: 'symlink', src: 'shared' }),
    'worktrees.hooks.postCreate[0].dest is required.',
  );
});
