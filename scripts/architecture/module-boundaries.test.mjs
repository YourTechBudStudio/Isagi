import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CONFIG_PATH,
  checkModuleBoundaries,
  globToRegExp,
  packageOf,
  ruleOf,
  summarizeRules,
} from './module-boundaries.mjs';

const scriptPath = fileURLToPath(new URL('./module-boundaries.mjs', import.meta.url));

/**
 * A small runtime that satisfies every rule: platform areas, a table-owning module (`beta`), a module with routes and
 * an FK table (`alpha`), a top module whose tests reach `beta` through the transitive closure (`gamma`), and a
 * composition root (`index.ts`, `app/`). Files are relative to `src/`.
 */
const CLEAN_FILES = {
  'index.ts': "import { start } from './app/main.js';\n\nstart();\n",
  'app/main.ts': [
    "import cors from '@fastify/cors';",
    "import Fastify from 'fastify';",
    "import { registerAlphaRoutes } from '../alpha/index.js';",
    "import { gamma } from '../gamma/index.js';",
    'export const start = () => registerAlphaRoutes(Fastify().register(cors), gamma);',
  ].join('\n'),
  'app/tests/main.test.ts': [
    "import { fakeBeta } from '../../beta/testing.js';",
    "import { start } from '../main.js';",
    'void fakeBeta;',
    'void start;',
  ].join('\n'),
  'platform/fs/index.ts': 'export const canonical = (path: string) => path;\n',
  'platform/process/index.ts': [
    "import { spawn } from 'node:child_process';",
    "import { canonical } from '../fs/index.js';",
    'export const run = (command: string) => spawn(canonical(command));',
  ].join('\n'),
  'beta/index.ts': "export { betaRows, insertBeta } from './rows.js';\n",
  'beta/rows.ts': [
    "import { canonical } from '../platform/fs/index.js';",
    "import { betaItems } from './tables.js';",
    'export const betaRows = (db: Db) => db.select().from(betaItems);',
    'export const insertBeta = (db: Db) => db.insert(betaItems).values({ path: canonical("x") });',
  ].join('\n'),
  'beta/tables.ts': [
    "import { sqliteTable, text } from 'drizzle-orm/sqlite-core';",
    "import { sql } from 'drizzle-orm';",
    "import { statusLiterals } from '@isagi/contracts';",
    "export const betaItems = sqliteTable('beta_items', { path: text('path', { enum: statusLiterals }) });",
    'void sql;',
  ].join('\n'),
  'beta/testing.ts': 'export const fakeBeta = { betaRows: () => [] };\n',
  'alpha/index.ts': "export { registerAlphaRoutes } from './api.js';\n",
  'alpha/api.ts': [
    "import type { FastifyInstance } from 'fastify';",
    "import { readAlpha } from './service.js';",
    'export const registerAlphaRoutes = (fastify: FastifyInstance, extra: unknown) => readAlpha(fastify, extra);',
  ].join('\n'),
  'alpha/service.ts': [
    "import { betaRows, insertBeta } from '../beta/index.js';",
    "import { betaItems } from '../beta/tables.js';",
    "import { run } from '../platform/process/index.js';",
    "import { alphaItems } from './tables.js';",
    '// db.insert(betaItems) in a comment is not a write',
    'export const readAlpha = (db: Db, _extra: unknown) => {',
    '  db.update(alphaItems).set({ ok: true });',
    '  db.delete(alphaItems);',
    '  run("git");',
    '  return [betaRows(db), insertBeta(db), db.select().from(betaItems)];',
    '};',
  ].join('\n'),
  'alpha/tables.ts': [
    "import { integer, sqliteTable } from 'drizzle-orm/sqlite-core';",
    "import { betaItems } from '../beta/tables.js';",
    "export const alphaItems = sqliteTable('alpha_items', { beta: integer('beta').references(() => betaItems.path) });",
  ].join('\n'),
  'alpha/tests/service.test.ts': [
    "import { spawnSync } from 'node:child_process';",
    "import { fakeBeta } from '../../beta/testing.js';",
    "import { readAlpha } from '../service.js';",
    "import { helper } from './helper-test-support.js';",
    'void [spawnSync, fakeBeta, readAlpha, helper];',
  ].join('\n'),
  'alpha/tests/helper-test-support.ts': 'export const helper = 1;\n',
  'gamma/index.ts':
    "export const gamma = 'gamma';\nexport type { Alpha } from '../alpha/index.js';\n",
  'gamma/service.test.ts': [
    "import { fakeBeta } from '../beta/testing.js';",
    "import { gamma } from './index.js';",
    'void [fakeBeta, gamma];',
  ].join('\n'),
  'gamma/checks/checks.test.ts': 'export {};\n',
};

const cleanConfig = () => ({
  root: 'src',
  compositionRoot: ['index.ts', 'app/'],
  testFiles: ['**/*.test.ts', '**/tests/**', '**/testing.ts', '**/*test-support.ts'],
  modules: {
    'platform/fs': { path: 'platform/fs', dependsOn: [] },
    'platform/process': { path: 'platform/process', dependsOn: ['platform/fs'] },
    beta: { path: 'beta', public: ['index.ts', 'tables.ts'], dependsOn: ['platform/*'] },
    alpha: { path: 'alpha', public: ['index.ts', 'tables.ts'], dependsOn: ['platform/*', 'beta'] },
    gamma: { path: 'gamma', dependsOn: ['alpha'] },
  },
  tableOwners: { beta: ['betaItems'], alpha: ['alphaItems'] },
  externals: {
    fastify: { paths: ['app/'], basenames: ['api.ts', '*-api.ts', '*-route.ts'] },
    '@fastify/cors': { paths: ['app/'] },
    'node:child_process': { paths: ['platform/process/'] },
  },
});

/**
 * A throwaway repo holding the clean tree plus `changes` (path under src -> text, or null to delete) and a manifest
 * edited by `editConfig`.
 * @param {Record<string, string | null>} [changes]
 * @param {(config: ReturnType<typeof cleanConfig>) => void} [editConfig]
 */
const fixture = (changes = {}, editConfig = () => {}) => {
  const repo = mkdtempSync(join(tmpdir(), 'isagi-boundaries-'));
  const files = { ...CLEAN_FILES, ...changes };
  for (const [path, text] of Object.entries(files)) {
    if (text === null) continue;
    mkdirSync(dirname(join(repo, 'src', path)), { recursive: true });
    writeFileSync(join(repo, 'src', path), text);
  }
  const config = cleanConfig();
  editConfig(config);
  mkdirSync(dirname(join(repo, CONFIG_PATH)), { recursive: true });
  writeFileSync(join(repo, CONFIG_PATH), JSON.stringify(config));
  return {
    repo,
    run: () => checkModuleBoundaries(repo),
    [Symbol.dispose]: () => rmSync(repo, { recursive: true, force: true }),
  };
};

/** @param {string[]} errors */
const rules = (errors) => errors.map(ruleOf);

describe('module-boundaries', () => {
  test('the clean tree passes every rule', () => {
    using f = fixture();
    assert.deepEqual(f.run(), []);
  });

  /**
   * One failing fixture per rule. Each must report exactly one violation, of that rule, matching `message`.
   * @type {{ rule: string, why: string, changes?: Record<string, string | null>, config?: (c: ReturnType<typeof cleanConfig>) => void, message: RegExp }[]}
   */
  const cases = [
    {
      rule: 'R1',
      why: 'a file outside every module and the composition root',
      changes: { 'legacy/old.ts': 'export {};\n' },
      message: /^R1 src\/legacy\/old\.ts: not inside any declared module/,
    },
    {
      rule: 'R2',
      why: 'a deep import into a declared dependency',
      changes: {
        'gamma/index.ts': "export { registerAlphaRoutes as gamma } from '../alpha/api.js';\n",
      },
      message:
        /^R2 src\/gamma\/index\.ts:1: deep import into alpha \(api\.ts\); use index\.ts \| tables\.ts$/,
    },
    {
      rule: 'R3',
      why: 'a type-only import of a public file of an undeclared module',
      changes: {
        'beta/index.ts':
          "export { betaRows, insertBeta } from './rows.js';\nimport type { gamma } from '../gamma/index.js';\n",
      },
      message: /^R3 src\/beta\/index\.ts:2: beta -> gamma is not a declared dependency$/,
    },
    {
      rule: 'R4',
      why: 'production code importing its own module test support',
      changes: {
        'alpha/api.ts': [
          "import type { FastifyInstance } from 'fastify';",
          "import { helper } from './tests/helper-test-support.js';",
          'export const registerAlphaRoutes = (fastify: FastifyInstance) => [fastify, helper];',
        ].join('\n'),
      },
      message:
        /^R4 src\/alpha\/api\.ts:2: production code imports test file src\/alpha\/tests\/helper-test-support\.ts$/,
    },
    {
      rule: 'R5',
      why: 'a dependency cycle in the declared graph',
      config: (c) => {
        c.modules.beta.dependsOn.push('gamma');
      },
      message:
        /^R5 apps\/runtime\/module-boundaries\.json: dependency cycle (beta -> gamma -> alpha -> beta|alpha -> beta -> gamma -> alpha|gamma -> alpha -> beta -> gamma)$/,
    },
    {
      rule: 'R6',
      why: 'a module importing the composition root',
      changes: {
        'gamma/index.ts': "import { start } from '../app/main.js';\nexport const gamma = start;\n",
      },
      message: /^R6 src\/gamma\/index\.ts:1: imports the composition root \(src\/app\/main\.ts\)$/,
    },
    {
      rule: 'R7',
      why: "a write to another module's table",
      changes: {
        'alpha/writer.ts': [
          "import { betaItems } from '../beta/tables.js';",
          'export const write = (db: Db) =>',
          '  db.insert(betaItems).values({});',
        ].join('\n'),
      },
      message:
        /^R7 src\/alpha\/writer\.ts:3: alpha writes \(insert\) beta's table betaItems; only the owning module writes its tables$/,
    },
    {
      rule: 'R8',
      why: 'a tables.ts importing a non-table file of its own module',
      changes: {
        'beta/tables.ts': `${CLEAN_FILES['beta/tables.ts']}\nimport { betaRows } from './rows.js';\nvoid betaRows;\n`,
      },
      message:
        /^R8 src\/beta\/tables\.ts:6: tables\.ts imports src\/beta\/rows\.ts; only other modules' tables\.ts are allowed$/,
    },
    {
      rule: 'R9',
      why: 'a production file importing a restricted external outside its allowed paths',
      changes: {
        'alpha/runner.ts':
          "import { execFile } from 'node:child_process';\nexport const runner = execFile;\n",
      },
      message:
        /^R9 src\/alpha\/runner\.ts:1: imports node:child_process, which only platform\/process\/ may import$/,
    },
    {
      rule: 'R10',
      why: 'a sub-folder barrel',
      changes: { 'alpha/internal/index.ts': 'export const internal = 1;\n' },
      message:
        /^R10 src\/alpha\/internal\/index\.ts: sub-folder barrel; export from alpha\/index\.ts instead$/,
    },
    {
      rule: 'R11',
      why: 'a file name repeating its directory name',
      changes: { 'beta/beta.repository.ts': 'export {};\n' },
      message: /^R11 src\/beta\/beta\.repository\.ts: file name repeats its directory name "beta"$/,
    },
    {
      rule: 'R12',
      why: 'a declared module without index.ts',
      changes: { 'delta/service.ts': 'export {};\n' },
      config: (c) => {
        Object.assign(c.modules, { delta: { path: 'delta', dependsOn: [] } });
      },
      message: /^R12 src\/delta: module delta has no index\.ts$/,
    },
  ];

  for (const { rule, why, changes, config, message } of cases) {
    test(`${rule} fires alone for ${why}`, () => {
      using f = fixture(changes, config);
      const errors = f.run();
      assert.deepEqual(rules(errors), [rule], errors.join('\n'));
      assert.match(errors[0], message);
    });
  }

  test('R2 lets test files use the testing surface but not module internals', () => {
    using f = fixture({
      'gamma/deep.test.ts': "import { betaRows } from '../beta/rows.js';\nvoid betaRows;\n",
      'gamma/index.ts':
        "import { fakeBeta } from '../alpha/testing.js';\nexport const gamma = fakeBeta;\n",
      'alpha/testing.ts': 'export const fakeBeta = 1;\n',
    });
    assert.deepEqual(f.run(), [
      'R2 src/gamma/deep.test.ts:1: deep import into beta (rows.ts); use index.ts | tables.ts | testing.ts',
      'R4 src/gamma/index.ts:1: production code imports test file src/alpha/testing.ts',
      'R2 src/gamma/index.ts:1: deep import into alpha (testing.ts); use index.ts | tables.ts',
    ]);
  });

  test('R3 allows tests the transitive closure but not modules above them', () => {
    using f = fixture({
      'beta/tests/up.test.ts': "import { gamma } from '../../gamma/index.js';\nvoid gamma;\n",
      'gamma/closure.test.ts': "import { betaRows } from '../beta/index.js';\nvoid betaRows;\n",
    });
    assert.deepEqual(f.run(), [
      'R3 src/beta/tests/up.test.ts:1: beta -> gamma is not a declared transitive dependency',
    ]);
  });

  test('R3 makes production files declare direct dependencies even when they are transitive', () => {
    using f = fixture({
      'gamma/index.ts':
        "import { betaRows } from '../beta/index.js';\nexport const gamma = betaRows;\n",
    });
    assert.deepEqual(f.run(), [
      'R3 src/gamma/index.ts:1: gamma -> beta is not a declared dependency',
    ]);
  });

  test('R5 reports unknown dependency names and prefixes that match nothing', () => {
    using f = fixture({}, (c) => {
      c.modules.gamma.dependsOn.push('nope', 'shared/*');
    });
    assert.deepEqual(f.run(), [
      'R5 apps/runtime/module-boundaries.json: gamma dependsOn unknown module nope',
      'R5 apps/runtime/module-boundaries.json: gamma dependsOn shared/*, which matches no module',
    ]);
  });

  test('R6 applies to test files outside the composition root too', () => {
    using f = fixture({
      'gamma/app.test.ts': "import { start } from '../app/main.js';\nvoid start;\n",
    });
    assert.deepEqual(rules(f.run()), ['R6']);
  });

  test('R7 follows aliases, namespace imports and every write verb, and ignores tests and reads', () => {
    using f = fixture({
      'alpha/writer.ts': [
        "import * as betaTables from '../beta/tables.js';",
        "import { betaItems as items } from '../beta/tables.js';",
        'export const write = (db: Db) => [',
        '  db.update(items).set({}),',
        '  db.delete(betaTables.betaItems),',
        '  db.select().from(items),',
        '];',
      ].join('\n'),
      'alpha/tests/writer.test.ts':
        "import { betaItems } from '../../beta/tables.js';\ndb.insert(betaItems);\n",
    });
    assert.deepEqual(f.run(), [
      "R7 src/alpha/writer.ts:4: alpha writes (update) beta's table betaItems; only the owning module writes its tables",
      "R7 src/alpha/writer.ts:5: alpha writes (delete) beta's table betaItems; only the owning module writes its tables",
    ]);
  });

  test('R8 rejects packages other than drizzle-orm and @isagi/contracts', () => {
    using f = fixture({
      'beta/tables.ts': `import { join } from 'node:path';\n${CLEAN_FILES['beta/tables.ts']}\nvoid join;\n`,
    });
    assert.deepEqual(rules(f.run()), ['R8']);
  });

  test('R9 allows listed basenames and exempts test files', () => {
    using f = fixture({
      'gamma/admin-route.ts':
        "import type { FastifyInstance } from 'fastify';\nexport type R = FastifyInstance;\n",
      'gamma/server.ts':
        "import type { FastifyReply } from 'fastify';\nexport type S = FastifyReply;\n",
      'gamma/server.test.ts': "import Fastify from 'fastify';\nvoid Fastify;\n",
    });
    assert.deepEqual(f.run(), [
      'R9 src/gamma/server.ts:1: imports fastify, which only app/, api.ts, *-api.ts, *-route.ts may import',
    ]);
  });

  test('R10 rejects `export *` in a module index and ignores barrels in tests', () => {
    using f = fixture({
      'beta/index.ts': "export * from './rows.js';\n",
      'beta/tests/fixtures/index.ts': 'export const fixture = 1;\n',
    });
    assert.deepEqual(f.run(), ['R10 src/beta/index.ts:1: `export *`; re-export names explicitly']);
  });

  test('R12 reports a declared path that does not exist', () => {
    using f = fixture({}, (c) => {
      Object.assign(c.modules, { delta: { path: 'delta' } });
    });
    assert.deepEqual(f.run(), [
      'R12 apps/runtime/module-boundaries.json: module delta path src/delta does not exist',
    ]);
  });

  test('a missing or malformed manifest throws instead of reading as clean', () => {
    using f = fixture();
    assert.throws(() => checkModuleBoundaries(f.repo, join(f.repo, 'nope.json')), /does not exist/);
    writeFileSync(join(f.repo, CONFIG_PATH), JSON.stringify({ root: 'src' }));
    assert.throws(() => f.run(), /"modules" must be an object/);
  });

  test('helpers: globs, package names and rule summaries', () => {
    assert.ok(globToRegExp('**/tests/**').test('tests/a.ts'));
    assert.ok(globToRegExp('**/tests/**').test('a/b/tests/c/d.ts'));
    assert.ok(globToRegExp('**/*test-support.ts').test('x/live-test-support.ts'));
    assert.ok(!globToRegExp('*-api.ts').test('a/b-api.ts'));
    assert.equal(packageOf('node:child_process'), 'node:child_process');
    assert.equal(packageOf('@fastify/websocket/x'), '@fastify/websocket');
    assert.equal(packageOf('drizzle-orm/sqlite-core'), 'drizzle-orm');
    assert.equal(summarizeRules(['R10 a', 'R2 b', 'R2 c', 'R9 d']), 'R2 2, R9 1, R10 1');
  });

  test('the CLI prints every violation with per-rule counts and sets the exit code', () => {
    {
      using f = fixture();
      const clean = spawnSync(process.execPath, [scriptPath, f.repo], { encoding: 'utf8' });
      assert.equal(clean.status, 0, clean.stderr);
      assert.match(clean.stderr, /^module-boundaries: 0 violation\(s\)$/m);
    }
    {
      using f = fixture({ 'legacy/old.ts': 'export {};\n', 'beta/beta.repository.ts': '' });
      const failing = spawnSync(process.execPath, [scriptPath, f.repo], { encoding: 'utf8' });
      assert.equal(failing.status, 1);
      assert.match(failing.stderr, /^R1 src\/legacy\/old\.ts: /m);
      assert.match(failing.stderr, /^module-boundaries: 2 violation\(s\) \(R1 1, R11 1\)$/m);
    }
  });
});
