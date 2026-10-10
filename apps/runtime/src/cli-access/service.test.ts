import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';

import { Effect } from 'effect';

import { CliShimError, cliShimPath, makeCliAccess, renderCliShim, writeCliShim } from './index.js';

function scratch() {
  return mkdtempSync(join(tmpdir(), 'isagi-cli-access-'));
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
  const shimPath = cliShimPath(root, '1.0.0');

  const failure = await Effect.runPromise(
    Effect.flip(makeCliAccess({ shimPath, execPath: process.execPath, entryPath: '/x.mjs' })),
  );
  assert.ok(failure instanceof CliShimError);
  assert.equal(failure.path, shimPath);
  assert.match(failure.message, /Could not write the isagi CLI shim/);
});

test('the launch environment puts the shim first on PATH and adds the URL only once published', async () => {
  const shimPath = join(scratch(), 'tools', 'isagi-cli', '1.0.0', 'bin', 'isagi');
  const binDirectory = join(shimPath, '..');

  await Effect.runPromise(
    Effect.gen(function* () {
      const access = yield* makeCliAccess({
        shimPath,
        execPath: process.execPath,
        entryPath: '/x.mjs',
      });

      const before = yield* access.launchEnvironment(`/usr/bin${delimiter}/bin`);
      assert.deepEqual(before, { PATH: `${binDirectory}${delimiter}/usr/bin${delimiter}/bin` });

      yield* access.publishRuntimeUrl('http://127.0.0.1:4100');
      const after = yield* access.launchEnvironment(undefined);
      assert.deepEqual(after, { PATH: binDirectory, ISAGI_RUNTIME_URL: 'http://127.0.0.1:4100' });
    }),
  );
});
