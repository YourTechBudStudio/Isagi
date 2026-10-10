import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkEffectV3Apis } from './effect-v3-apis.mjs';

const scriptPath = fileURLToPath(new URL('./effect-v3-apis.mjs', import.meta.url));

/** A throwaway repo with `files` (repo-relative path -> text). @param {Record<string, string>} files */
const fixture = (files) => {
  const repo = mkdtempSync(join(tmpdir(), 'isagi-effect-v3-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  return {
    repo,
    run: () => checkEffectV3Apis(repo),
    [Symbol.dispose]: () => rmSync(repo, { recursive: true, force: true }),
  };
};

describe('effect-v3-apis', () => {
  test('every v3-only name is reported with its file and line', () => {
    const v3 = [
      'Effect.catchAll(f)',
      'Effect.catchAllCause(f)',
      'Effect.catchAllDefect(f)',
      'Effect.either(e)',
      'Effect.zipRight(a, b)',
      'Effect.zipLeft(a, b)',
      'Effect.async((resume) => {})',
      'Effect.fork(e)',
      'Effect.forkDaemon(e)',
      'Effect.tapErrorCause(f)',
      'Effect.orElse(f)',
      'class X extends Effect.Tag("x")<X, {}>() {}',
      'class Y extends Effect.Service<Y>()("y", {}) {}',
      'Effect.runtime<never>()',
      'Effect.locally(ref, 1)',
      'Effect.makeSemaphore(1)',
      'Effect.unsafeMakeSemaphore(1)',
      'Context.GenericTag<S>("s")',
      'type T = Context.Tag<A, B>',
      'Context.unsafeMap(context)',
      'Layer.scoped(T, make)',
      'Layer.scopedDiscard(e)',
      'Layer.unwrapEffect(e)',
      'Stream.async((emit) => {})',
      'Stream.asyncScoped((emit) => {})',
      'Stream.asyncPush((emit) => {})',
      'Runtime.runPromise(runtime)(e)',
      'Runtime.runSyncExit(runtime)(e)',
    ];
    using f = fixture({ 'scripts/tool.mjs': v3.map((code) => `${code};`).join('\n') });
    const errors = f.run();
    assert.equal(errors.length, v3.length, errors.join('\n'));
    assert.match(
      errors[0],
      /^scripts\/tool\.mjs:1: Effect\.catchAll is an Effect v3 API \(see the v3-to-v4 cookbook/,
    );
    assert.deepEqual(
      errors.map((error) => Number(error.split(':')[1])),
      v3.map((_, index) => index + 1),
    );
  });

  test('v3-era packages and effect/unstable subpaths are reported in every import form', () => {
    using f = fixture({
      'apps/desktop/scripts/stage.mjs': [
        "import { Schema } from '@effect/schema';",
        "import * as S from '@effect/schema/Schema';",
        "import { HttpClient } from '@effect/platform';",
        'import "@effect/platform/HttpClient";',
        "export { Atom } from 'effect/unstable/reactivity';",
        "const m = await import('effect/unstable/http');",
      ].join('\n'),
    });
    assert.deepEqual(
      f.run().map((error) => error.split(' is an')[0]),
      [
        "apps/desktop/scripts/stage.mjs:1: from '@effect/schema'",
        "apps/desktop/scripts/stage.mjs:2: from '@effect/schema/Schema'",
        "apps/desktop/scripts/stage.mjs:3: from '@effect/platform'",
        'apps/desktop/scripts/stage.mjs:4: import "@effect/platform/HttpClient"',
        "apps/desktop/scripts/stage.mjs:5: from 'effect/unstable/reactivity'",
        "apps/desktop/scripts/stage.mjs:6: import('effect/unstable/http'",
      ],
    );
  });

  test('v4 names and look-alikes are not reported', () => {
    using f = fixture({
      'apps/runtime/src/service.ts': [
        "import { Context, Effect, Layer, Stream } from 'effect';",
        "import { Atom } from 'effect/reactivity';",
        "import { NodeRuntime } from '@effect/platform-node';",
        "import { useAtomValue } from '@effect/atom-react';",
        'class S extends Context.Service<S, {}>()("isagi/runtime/s/S") {}',
        'const a = Effect.forkChild(e).pipe(Effect.catch(f), Effect.catchCause(g));',
        'const b = Effect.callback<void>((resume) => resume(Effect.void));',
        'const c = Effect.forkDetach(e).pipe(Effect.result, Effect.forkScoped);',
        'type R = Effect.Services<typeof e>;',
        'const d = Layer.effect(S, make).pipe(Layer.unwrap, Layer.effectDiscard);',
        'const e2 = Stream.callback((queue) => Effect.void);',
        'const f2 = Effect.catchTag("X", h);',
        'const g = Effect.asVoid(e);',
        'const h = myEffect.fork(e);',
        "const text = 'effect/unstable/x is gone';",
      ].join('\n'),
    });
    assert.deepEqual(f.run(), []);
  });

  test('comments, the checks themselves and build output are ignored; tests are scanned', () => {
    using f = fixture({
      'apps/runtime/src/doc.ts':
        '// Effect.catchAll used to live here\n/* Layer.scoped(x) */\nexport {};',
      'scripts/architecture/fixture.test.mjs': 'Effect.catchAll(f);',
      'apps/runtime/dist/index.js': 'Effect.catchAll(f);',
      'apps/runtime/node_modules/pkg/index.mjs': 'Effect.catchAll(f);',
      'packages/contracts/src/a.test.ts': 'Effect.either(e);',
    });
    assert.deepEqual(f.run(), [
      'packages/contracts/src/a.test.ts:1: Effect.either is an Effect v3 API (see the v3-to-v4 cookbook for its v4 name)',
    ]);
  });

  test('the CLI exits 1 and prints violations for a failing tree, 0 for a clean one', () => {
    using failing = fixture({ 'scripts/a.mjs': 'Effect.zipRight(a, b);' });
    const failed = spawnSync(process.execPath, [scriptPath, failing.repo], { encoding: 'utf8' });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /scripts\/a\.mjs:1: Effect\.zipRight is an Effect v3 API/);
    assert.match(failed.stderr, /effect-v3-apis: 1 violation\(s\)/);
    using clean = fixture({ 'scripts/a.mjs': 'Effect.andThen(a, b);' });
    assert.equal(
      spawnSync(process.execPath, [scriptPath, clean.repo], { encoding: 'utf8' }).status,
      0,
    );
  });
});
