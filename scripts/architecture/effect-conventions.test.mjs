import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkEffectConventions, typeArguments } from './effect-conventions.mjs';

const scriptPath = fileURLToPath(new URL('./effect-conventions.mjs', import.meta.url));
const repoRoot = join(dirname(scriptPath), '../..');

/** The allowlisted `extends Error` classes, so a fixture that does not test E6 does not trip its stale-entry rule. */
const ALLOWED_ERROR_FILES = {
  'apps/runtime/src/editor/contexts/row-mapper.ts':
    'export class EditorContextRowInvariantViolation extends Error {}',
  'apps/runtime/src/workflows/state/serializable.ts':
    'export class UnserializableValueError extends Error {}',
  'apps/runtime/src/workflows/state/isolation.ts': 'export class IsolationError extends Error {}',
  'apps/runtime/src/projects/config/normalize.ts': 'class ProjectConfigInvalid extends Error {}',
};

/**
 * A throwaway repo with `files` (repo-relative path -> text) plus the allowlisted error classes.
 * @param {Record<string, string>} files
 * @param {{ withAllowedErrors?: boolean }} [options]
 */
const fixture = (files, { withAllowedErrors = true } = {}) => {
  const repo = mkdtempSync(join(tmpdir(), 'isagi-effect-conventions-'));
  const all = withAllowedErrors ? { ...ALLOWED_ERROR_FILES, ...files } : files;
  for (const [path, text] of Object.entries(all)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  return {
    repo,
    run: () => checkEffectConventions(repo),
    [Symbol.dispose]: () => rmSync(repo, { recursive: true, force: true }),
  };
};

/** @param {string[]} errors */
const rules = (errors) => errors.map((error) => error.split(' ')[0]);

describe('effect-conventions', () => {
  test('a conforming tree passes', () => {
    using f = fixture({
      'apps/runtime/src/commands/service.ts': [
        "import { Context, Effect, Layer } from 'effect';",
        'export class CommandService extends Context.Service<',
        '  CommandService,',
        '  { readonly run: (name: string) => Effect.Effect<void, CommandError, never> }',
        ">()('isagi/runtime/commands/CommandService') {",
        '  static readonly layer = Layer.succeed(CommandService, CommandService.of({ run: () => Effect.void }));',
        '}',
        "export const CommandSettings = Context.Reference<{ readonly ms: number }>('isagi/runtime/commands/CommandSettings', { defaultValue: () => ({ ms: 1 }) });",
      ].join('\n'),
      'apps/runtime/src/platform/git/service.ts':
        "export class Git extends Context.Service<Git, {}>()('isagi/runtime/platform/git/Git') {}",
      'apps/web/src/lib/runtime/client.ts':
        "export class RuntimeApi extends Context.Service<RuntimeApi, Shape>()(\n  'isagi/web/RuntimeApi',\n) {}",
      'apps/runtime/src/workflows/engine/author-bridge.ts':
        'export interface AuthorContext { readonly run: <A, E>(effect: Effect.Effect<A, unknown>) => Promise<A> }',
      'packages/contracts/src/a.ts':
        "import { Schema, SchemaTransformation } from 'effect';\nimport type { Schema as S } from 'effect';",
    });
    assert.deepEqual(f.run(), []);
  });

  test('E1 reports a function-form service', () => {
    using f = fixture({
      'apps/cli/src/context.ts':
        "export const CliContext = Context.Service<CliContextShape>('isagi/cli/CliContext');",
    });
    const errors = f.run();
    assert.deepEqual(rules(errors), ['E1']);
    assert.match(errors[0], /^E1 apps\/cli\/src\/context\.ts:1: function-form Context\.Service/);
  });

  test('E2 reports bad prefixes, wrong modules, mismatched class names and duplicates', () => {
    using f = fixture({
      'apps/runtime/src/commands/a.ts':
        "export class A extends Context.Service<A, {}>()('isagi/runtime/workspace/A') {}",
      'apps/runtime/src/commands/b.ts':
        "export class B extends Context.Service<B, {}>()('isagi/runtime/commands/NotB') {}",
      'apps/desktop/src/c.ts': "export class C extends Context.Service<C, {}>()('isagi/C') {}",
      'apps/desktop/src/d.ts':
        "export class D extends Context.Service<D, {}>()('isagi/desktop/D') {}",
      'apps/desktop/src/e.ts':
        "export const D2 = Context.Reference<number>('isagi/desktop/D', { defaultValue: () => 1 });",
      'apps/runtime/src/platform/fs/f.ts':
        "export class F extends Context.Service<F, {}>()('isagi/runtime/platform/git/F') {}",
    });
    const errors = f.run();
    assert.deepEqual(rules(errors), ['E2', 'E2', 'E2', 'E2', 'E2']);
    assert.ok(
      errors.some((e) =>
        /a\.ts:1: id "isagi\/runtime\/workspace\/A" must start with isagi\/runtime\/commands\//.test(
          e,
        ),
      ),
    );
    assert.ok(errors.some((e) => /b\.ts:1: id .* must end with \/B/.test(e)));
    assert.ok(
      errors.some((e) => /c\.ts:1: id "isagi\/C" must start with isagi\/\(runtime/.test(e)),
    );
    assert.ok(
      errors.some((e) =>
        /e\.ts:1: id "isagi\/desktop\/D" is already used at apps\/desktop\/src\/d\.ts:1/.test(e),
      ),
    );
    assert.ok(
      errors.some((e) => /f\.ts:1: id .* must start with isagi\/runtime\/platform\/fs\//.test(e)),
    );
  });

  test('E3 reports Effect.forkDetach', () => {
    using f = fixture({ 'apps/desktop/src/main/x.ts': 'yield* Effect.forkDetach(loop);' });
    assert.deepEqual(rules(f.run()), ['E3']);
  });

  test('E4 reports an unknown error channel, multi-line and in unions, outside the author bridge', () => {
    using f = fixture({
      'apps/runtime/src/a.ts': 'const a: Effect.Effect<string, unknown> = x;',
      'apps/web/src/b.ts':
        'type B = Effect.Effect<\n  Map<string, number>,\n  Error | unknown,\n  R\n>;',
      'apps/runtime/src/c.ts': [
        'const ok: Effect.Effect<(a: number) => string, DatabaseError> = x;',
        'const ok2: Effect.Effect<unknown, never> = y;',
        'const ok3: Effect.Effect<Record<string, unknown>> = z;',
      ].join('\n'),
    });
    const errors = f.run();
    assert.deepEqual(rules(errors), ['E4', 'E4']);
    assert.match(errors[0], /^E4 apps\/runtime\/src\/a\.ts:1:/);
    assert.match(errors[1], /^E4 apps\/web\/src\/b\.ts:1:/);
  });

  test('E5 reports timers in the runtime only', () => {
    using f = fixture({
      'apps/runtime/src/a.ts':
        'const t = setTimeout(() => {}, 1);\nconst i = globalThis.setInterval(tick, 5);\nconst ok = clearTimeout(t);',
      'apps/web/src/b.ts': 'setTimeout(() => {}, 1);',
      'apps/runtime/src/a.test.ts': 'setTimeout(() => {}, 1);',
    });
    const errors = f.run();
    assert.deepEqual(rules(errors), ['E5', 'E5']);
    assert.match(errors[0], /a\.ts:1: setTimeout;/);
    assert.match(errors[1], /a\.ts:2: globalThis\.setInterval;/);
  });

  test('E6 allows only the listed Error subclasses, and fails on a stale entry', () => {
    using f = fixture(
      {
        ...ALLOWED_ERROR_FILES,
        'apps/runtime/src/projects/config/normalize.ts': 'export const ok = 1;',
        'apps/runtime/src/commands/errors.ts': 'export class CommandFailed extends Error {}',
        'apps/desktop/src/errors.ts': 'export class DesktopThing extends Error {}',
      },
      { withAllowedErrors: false },
    );
    const errors = f.run();
    assert.deepEqual(rules(errors).sort(), ['E6', 'E6']);
    assert.ok(
      errors.some((e) => /commands\/errors\.ts:1: class CommandFailed extends Error/.test(e)),
    );
    assert.ok(
      errors.some((e) =>
        /normalize\.ts: allowlisted class ProjectConfigInvalid no longer extends Error/.test(e),
      ),
    );
  });

  test('E7 limits contracts to Schema and SchemaTransformation from effect', () => {
    using f = fixture({
      'packages/contracts/src/a.ts': [
        "import { Schema, Effect } from 'effect';",
        "import * as Fx from 'effect';",
        "import { Atom } from 'effect/reactivity';",
        "import { thing } from '@yourtechbudstudio/isagi-workflow-sdk';",
      ].join('\n'),
      'packages/contracts/src/a.test.ts': "import { Exit, Schema } from 'effect';",
    });
    const errors = f.run();
    assert.deepEqual(rules(errors), ['E7', 'E7', 'E7']);
    assert.match(errors[0], /a\.ts:1: contracts import Effect from "effect"/);
    assert.match(errors[1], /a\.ts:2: contracts import "effect" as \* as Fx/);
    assert.match(errors[2], /a\.ts:3: contracts import "effect\/reactivity"/);
  });

  test('comments and test files are ignored', () => {
    using f = fixture({
      'apps/runtime/src/doc.ts':
        '// setTimeout(x) and Effect.forkDetach(y) used to live here\nexport {};',
      'apps/runtime/src/area/testing.ts': 'yield* Effect.forkDetach(x); setTimeout(() => {}, 1);',
      'apps/runtime/src/area/tests/helpers.ts': 'export class Fake extends Error {}',
    });
    assert.deepEqual(f.run(), []);
  });

  test('typeArguments splits top-level arguments and skips arrows', () => {
    const text = 'Effect.Effect<(a: Map<string, number>) => void, E | F, R> rest';
    const parsed = typeArguments(text, text.indexOf('<'));
    assert.deepEqual(parsed?.args, ['(a: Map<string, number>) => void', 'E | F', 'R']);
    assert.equal(text.slice(parsed?.end), ' rest');
  });

  test('the repository conforms', () => {
    assert.deepEqual(checkEffectConventions(repoRoot), []);
  });

  test('the CLI exits 1 and prints violations for a failing tree, 0 for a clean one', () => {
    using bad = fixture({ 'apps/runtime/src/a.ts': 'setInterval(tick, 5);' });
    const failing = spawnSync(process.execPath, [scriptPath, bad.repo], { encoding: 'utf8' });
    assert.equal(failing.status, 1);
    assert.match(failing.stderr, /^E5 apps\/runtime\/src\/a\.ts:1: setInterval;/m);
    assert.match(failing.stderr, /effect-conventions: 1 violation\(s\)/);
    const clean = spawnSync(process.execPath, [scriptPath, repoRoot], { encoding: 'utf8' });
    assert.equal(clean.status, 0, clean.stderr);
    assert.match(clean.stderr, /effect-conventions: 0 violation\(s\)/);
  });
});
