import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ALLOWLIST_PATH, checkEffectRunSites } from './effect-run-sites.mjs';
import { importsOf, isTestFile, stripComments } from './source-files.mjs';

const scriptPath = fileURLToPath(new URL('./effect-run-sites.mjs', import.meta.url));
const repoRoot = join(dirname(scriptPath), '../..');

/**
 * A throwaway repo with `files` (repo-relative path -> text) and, unless `allowlist` is null, an allowlist file.
 * @param {Record<string, string>} files
 * @param {Record<string, unknown> | null} [allowlist]
 */
const fixture = (files, allowlist = {}) => {
  const repo = mkdtempSync(join(tmpdir(), 'isagi-run-sites-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  if (allowlist !== null) {
    mkdirSync(dirname(join(repo, ALLOWLIST_PATH)), { recursive: true });
    writeFileSync(join(repo, ALLOWLIST_PATH), JSON.stringify(allowlist));
  }
  return {
    repo,
    run: () => checkEffectRunSites(repo),
    [Symbol.dispose]: () => rmSync(repo, { recursive: true, force: true }),
  };
};

describe('effect-run-sites', () => {
  test('run sites in allowlisted files pass', () => {
    using f = fixture(
      {
        'apps/cli/src/main.ts': 'const exit = await Effect.runPromiseExit(program);',
        'scripts/tool.mjs': 'await Effect.runPromise(main);',
        'apps/runtime/src/pure.ts': 'export const add = (a: number, b: number) => a + b;',
      },
      { 'apps/cli/src/main.ts': 'CLI process entry.', 'scripts/tool.mjs': 'Script entry.' },
    );
    assert.deepEqual(f.run(), []);
  });

  test('a run site in an unlisted production file is reported with its line', () => {
    using f = fixture({
      'apps/runtime/src/deep/service.ts':
        "import { Effect } from 'effect';\n\nconst timer = setInterval(() => {\n  void Effect.runPromise(tick);\n});",
    });
    const errors = f.run();
    assert.equal(errors.length, 1);
    assert.match(
      errors[0],
      /^apps\/runtime\/src\/deep\/service\.ts:4: Effect\.runPromise runs an Effect outside a sanctioned boundary/,
    );
  });

  test('every run-site spelling is detected, v3 and v4', () => {
    const spellings = [
      'Effect.runPromise(e)',
      'Effect.runPromiseExit(e)',
      'Effect.runSync(e)',
      'Effect.runSyncExit(e)',
      'Effect.runFork(e)',
      'Effect.runCallback(e)',
      'Effect.runPromiseWith(services)(e)',
      'Effect.runForkWith(services)(e)',
      'Effect.runPromiseExitWith(services)(e)',
      'Effect.runSyncExitWith(services)(e)',
      'runtime.runPromise(e)',
      'this.runtime.runFork(e)',
      'managedRuntime.runPromiseExit(e)',
      'rt.runSync(e)',
      'ManagedRuntime.make(layer)',
    ];
    using f = fixture(
      Object.fromEntries(
        spellings.map((code, index) => [`apps/web/src/site-${index}.ts`, `${code};\n`]),
      ),
    );
    const reported = f
      .run()
      .map((error) => error.split(':')[0])
      .sort();
    assert.deepEqual(reported, spellings.map((_, index) => `apps/web/src/site-${index}.ts`).sort());
  });

  test('look-alikes are not run sites', () => {
    using f = fixture({
      'apps/runtime/src/a.ts': [
        'const fiber = yield* FiberSet.run(set, effect);',
        'const r = yield* Effect.runtime<never>();',
        'const flags = rt.runtimeFlags;',
        'export const runPromiseLater = () => undefined;',
      ].join('\n'),
    });
    assert.deepEqual(f.run(), []);
  });

  test('comments, test files, test support, unscanned directories and build output are ignored', () => {
    using f = fixture({
      'apps/runtime/src/doc.ts':
        '// Effect.runPromise(old) used to live here\n/* ManagedRuntime.make(x) */\nexport {};',
      'apps/runtime/src/a.test.ts': 'await Effect.runPromise(e);',
      'apps/web/src/b.test.tsx': 'Effect.runSync(e);',
      'apps/runtime/src/area/test-support.ts': 'Effect.runSync(e);',
      'apps/runtime/src/area/process-tree-test-support.ts': 'Effect.runSync(e);',
      'apps/runtime/src/area/testing.ts': 'Effect.runSync(e);',
      'apps/runtime/src/area/tests/helpers.ts': 'Effect.runSync(e);',
      'apps/runtime/src/area/types.d.ts': 'declare const x: typeof Effect.runSync;',
      'apps/desktop/scripts/stage.mjs': 'await Effect.runPromise(main);',
      'apps/runtime/dist/index.js': 'Effect.runPromise(e);',
      'apps/runtime/src/node_modules/pkg/index.mjs': 'Effect.runPromise(e);',
      'scripts/architecture/fixture.mjs': 'Effect.runPromise(e);',
    });
    assert.deepEqual(f.run(), []);
  });

  test('a stale allowlist entry fails so the ratchet only tightens', () => {
    using f = fixture(
      { 'apps/runtime/src/pty/gc.ts': 'export const tick = Effect.void;' },
      {
        'apps/runtime/src/pty/gc.ts': 'Deep run, removed by phase 3.',
        'apps/runtime/src/gone.ts': 'File was deleted.',
      },
    );
    assert.deepEqual(f.run().sort(), [
      `apps/runtime/src/gone.ts: allowlisted in ${ALLOWLIST_PATH} but has no Effect run site; delete the stale entry`,
      `apps/runtime/src/pty/gc.ts: allowlisted in ${ALLOWLIST_PATH} but has no Effect run site; delete the stale entry`,
    ]);
  });

  test('every allowlist entry needs a reason', () => {
    using f = fixture(
      { 'apps/cli/src/main.ts': 'Effect.runPromise(e);' },
      { 'apps/cli/src/main.ts': '  ' },
    );
    assert.deepEqual(f.run(), [
      `apps/cli/src/main.ts: allowlist entry needs a reason (why this file is a run-site boundary)`,
    ]);
  });

  test('a missing or malformed allowlist is an error, not an empty list', () => {
    using missing = fixture({}, null);
    assert.throws(() => missing.run(), /does not exist/);
    using malformed = fixture({}, null);
    mkdirSync(dirname(join(malformed.repo, ALLOWLIST_PATH)), { recursive: true });
    writeFileSync(join(malformed.repo, ALLOWLIST_PATH), '["apps/cli/src/main.ts"]');
    assert.throws(() => malformed.run(), /must be a JSON object/);
  });

  test('the CLI exits 1 and prints violations for a failing tree, 0 for a clean one', () => {
    using failing = fixture({ 'apps/runtime/src/a.ts': 'Effect.runSync(e);' });
    const failed = spawnSync(process.execPath, [scriptPath, failing.repo], { encoding: 'utf8' });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /apps\/runtime\/src\/a\.ts:1: Effect\.runSync/);
    assert.match(failed.stderr, /effect-run-sites: 1 violation\(s\)/);
    using clean = fixture({ 'apps/runtime/src/a.ts': 'export {};' });
    assert.equal(
      spawnSync(process.execPath, [scriptPath, clean.repo], { encoding: 'utf8' }).status,
      0,
    );
  });

  test('the committed allowlist gives every entry a reason', () => {
    const allowlist = JSON.parse(readFileSync(join(repoRoot, ALLOWLIST_PATH), 'utf8'));
    for (const [file, reason] of Object.entries(allowlist)) {
      assert.equal(typeof reason, 'string', file);
      assert.ok(reason.trim().length > 0, file);
    }
  });
});

describe('source scanner', () => {
  test('comments become spaces and offsets/lines are unchanged', () => {
    const source = "const a = 1; // trailing\n/* block\n   comment */ const b = '//kept';\n";
    const stripped = stripComments(source);
    assert.equal(stripped.length, source.length);
    assert.equal(
      stripped,
      "const a = 1;            \n        \n              const b = '//kept';\n",
    );
  });

  test('comment markers inside strings, templates and regex literals are not comments', () => {
    const cases = [
      "const globs = ['apps/**', 'packages/*'];\nEffect.runSync(a);\nconst end = '*/';",
      'const url = "http://localhost"; Effect.runSync(a);',
      'const t = `a/*${`b`}*/c`; Effect.runSync(a);',
      'const t = `x ${ { y: `/*` }.y } z`; Effect.runSync(a);',
      'const re = /[\'"`]\\/*/g; Effect.runSync(a);',
      'if (x) return /[/*]/.test(s); Effect.runSync(a);',
    ];
    for (const source of cases) assert.equal(stripComments(source), source, source);
  });

  test('division is not mistaken for a regex literal', () => {
    const source = 'const half = total / 2; // gone\nconst r = (a) / (b); /* gone */';
    assert.equal(
      stripComments(source),
      'const half = total / 2;        \nconst r = (a) / (b);           ',
    );
  });

  test('import specifiers are found with lines and type-only flags', () => {
    const dir = mkdtempSync(join(tmpdir(), 'isagi-imports-'));
    try {
      const file = join(dir, 'a.ts');
      writeFileSync(
        file,
        [
          "import { a } from './a.js';",
          "import type { B } from '../b/index.js';",
          "export * from './c.js';",
          "import './side-effect.js';",
          "// import { gone } from './gone.js';",
          "const lazy = await import('./lazy.js');",
          'import {',
          '  $d,',
          '  e,',
          "} from 'pkg';",
        ].join('\n'),
      );
      assert.deepEqual(importsOf(file), [
        { specifier: './a.js', line: 1, typeOnly: false },
        { specifier: '../b/index.js', line: 2, typeOnly: true },
        { specifier: './c.js', line: 3, typeOnly: false },
        { specifier: './side-effect.js', line: 4, typeOnly: false },
        { specifier: './lazy.js', line: 6, typeOnly: false },
        { specifier: 'pkg', line: 7, typeOnly: false },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('test files are recognized from repo-relative paths', () => {
    for (const path of [
      'a/b.test.ts',
      'a/b.spec.tsx',
      'a/b.test.mjs',
      'a/test-support.ts',
      'a/process-tree-test-support.ts',
      'a/testing.ts',
      'testing.ts',
      'a/tests/x.ts',
      'tests/x.ts',
    ]) {
      assert.ok(isTestFile(path), path);
    }
    for (const path of [
      'a/b.ts',
      'a/latest.ts',
      'a/contests/x.ts',
      'a/attesting.ts',
      'a/testing-utils.ts',
      'a/testing/x.ts',
    ])
      assert.ok(!isTestFile(path), path);
  });
});
