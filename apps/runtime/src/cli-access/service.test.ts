import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';

import { Context, Effect, Layer } from 'effect';

import { ProcessTokens } from '../access/index.js';
import { runtimePackageVersion } from '../platform/assets/index.js';
import { DataDirectory } from '../platform/persistence/index.js';
import { makeTestDataDirectory } from '../platform/persistence/testing.js';
import { CliAccess, CliEntry, CliShimError } from './index.js';
import { cliShimPath, renderCliShim, writeCliShim } from './shim.js';

function scratch() {
  return mkdtempSync(join(tmpdir(), 'isagi-cli-access-'));
}

/** Builds the production layer over a data root whose tools directory is `toolsPath`. */
function cliAccessAt(toolsPath: string, entryPath = '/opt/isagi/isagi.mjs') {
  return Effect.gen(function* () {
    return yield* CliAccess;
  }).pipe(
    Effect.provide(CliAccess.layer),
    Effect.provideService(DataDirectory, makeTestDataDirectory(scratch(), { toolsPath })),
    Effect.provideService(CliEntry, { path: entryPath }),
  );
}

test('the shim path is versioned under the tools directory', () => {
  assert.equal(
    cliShimPath('/data/tools', '1.2.3'),
    join('/data/tools', 'isagi-cli', '1.2.3', 'bin', 'isagi'),
  );
});

test('the shim runs the entry with the given executable as Node, passing every argument', () => {
  // A directory with a space and a single quote: both must survive the shell quoting.
  const root = join(scratch(), "it's a dir");
  mkdirSync(root, { recursive: true });
  const entryPath = join(root, 'entry.mjs');
  writeFileSync(
    entryPath,
    'process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), electron: process.env.ELECTRON_RUN_AS_NODE }));',
  );
  const shimPath = join(root, 'bin', 'isagi');
  const content = renderCliShim({ execPath: process.execPath, entryPath });
  assert.ok(content.startsWith('#!/bin/sh\n'));
  assert.ok(content.includes(`'\\''`));

  return writeCliShim(shimPath, content).then(() => {
    const output = execFileSync(shimPath, ['runs', 'list', 'two words', "o'clock"], {
      encoding: 'utf8',
    });
    assert.deepEqual(JSON.parse(output), {
      argv: ['runs', 'list', 'two words', "o'clock"],
      electron: '1',
    });
  });
});

test('the shim is written atomically with mode 0o755 and replaces an older one', async () => {
  const shimPath = join(scratch(), 'tools', 'isagi-cli', '1.0.0', 'bin', 'isagi');
  await writeCliShim(shimPath, '#!/bin/sh\necho old\n');
  await writeCliShim(shimPath, '#!/bin/sh\necho new\n');

  assert.equal(statSync(shimPath).mode & 0o777, 0o755);
  assert.equal(execFileSync(shimPath, { encoding: 'utf8' }), 'new\n');
  assert.deepEqual(readdirSync(join(shimPath, '..')), ['isagi']);
});

test('a shim that cannot be written fails construction with CliShimError', async () => {
  const root = scratch();
  // A file where the version directory must go: mkdir fails with ENOTDIR.
  writeFileSync(join(root, 'isagi-cli'), 'not a directory');
  const shimPath = cliShimPath(root, runtimePackageVersion);

  const failure = await Effect.runPromise(Effect.scoped(Effect.flip(cliAccessAt(root))));
  assert.ok(failure instanceof CliShimError);
  assert.equal(failure.path, shimPath);
  assert.match(failure.message, /Could not write the isagi CLI shim/);
});

test('the launch environment puts the shim first on PATH and adds the URL only once published', async () => {
  const toolsPath = join(scratch(), 'tools');
  const binDirectory = join(cliShimPath(toolsPath, runtimePackageVersion), '..');

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const access = yield* cliAccessAt(toolsPath);
        assert.equal(
          statSync(join(binDirectory, 'isagi')).mode & 0o777,
          0o755,
          "building the service writes this version's shim",
        );

        const holder = { _tag: 'pty', ptyProcessId: 1 } as const;
        const { ISAGI_RUNTIME_TOKEN: token, ...before } = yield* access.launchEnvironment(
          `/usr/bin${delimiter}/bin`,
          holder,
        );
        assert.deepEqual(before, { PATH: `${binDirectory}${delimiter}/usr/bin${delimiter}/bin` });
        assert.match(token ?? '', /^[0-9a-f]{64}$/, 'a token is issued before the URL is known');

        yield* access.publishRuntimeUrl('http://127.0.0.1:4100');
        const after = yield* access.launchEnvironment(undefined, holder);
        assert.deepEqual(after, {
          PATH: binDirectory,
          ISAGI_RUNTIME_TOKEN: token,
          ISAGI_RUNTIME_URL: 'http://127.0.0.1:4100',
        });
      }),
    ),
  );
});

test('each launched process gets its own token, issued by the ProcessTokens the access guard checks', async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        // The production wiring: `CliAccess.layer` provides `ProcessTokens.layer` by reference,
        // so building both in one build yields one `ProcessTokens`.
        const context = yield* Layer.build(Layer.merge(CliAccess.layer, ProcessTokens.layer)).pipe(
          Effect.provideService(DataDirectory, makeTestDataDirectory(scratch(), {})),
          Effect.provideService(CliEntry, { path: '/opt/isagi/isagi.mjs' }),
        );
        const access = Context.get(context, CliAccess);
        const tokens = Context.get(context, ProcessTokens);

        const first = (yield* access.launchEnvironment(undefined, { _tag: 'pty', ptyProcessId: 1 }))
          .ISAGI_RUNTIME_TOKEN;
        const second = (yield* access.launchEnvironment(undefined, {
          _tag: 'sdk',
          executionId: 'fc-1',
        })).ISAGI_RUNTIME_TOKEN;

        assert.ok(first !== undefined && second !== undefined);
        assert.notEqual(first, second, 'holders do not share a token');
        assert.equal(tokens.isLive(first), true);
        assert.equal(tokens.isLive(second), true);
        yield* tokens.release({ _tag: 'pty', ptyProcessId: 1 });
        assert.equal(tokens.isLive(first), false);
        assert.equal(tokens.isLive(second), true);
      }),
    ),
  );
});

test('the shim runs the CLI entry the runtime was served from', async () => {
  const root = scratch();
  const toolsPath = join(root, 'tools');
  const entryPath = join(root, 'served-from', 'isagi.mjs');
  mkdirSync(join(entryPath, '..'), { recursive: true });
  writeFileSync(entryPath, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');

  await Effect.runPromise(Effect.scoped(cliAccessAt(toolsPath, entryPath)));

  const output = execFileSync(cliShimPath(toolsPath, runtimePackageVersion), ['serve', '--help'], {
    encoding: 'utf8',
  });
  assert.deepEqual(JSON.parse(output), ['serve', '--help']);
});
