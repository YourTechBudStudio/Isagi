import assert from 'node:assert/strict';
import test from 'node:test';

import { scanDeferredExecutableDependencies } from './closed-bundle.js';

function codes(source: string): readonly string[] {
  return scanDeferredExecutableDependencies(source).map((diagnostic) => diagnostic.code);
}

function isClosed(source: string): boolean {
  return scanDeferredExecutableDependencies(source).length === 0;
}

test('an ordinary closed bundle passes', () => {
  assert.ok(
    isClosed(`
      const graph = { key: 'Root' };
      export default { command() { return { title: 'Root' }; }, validate() {}, graph };
    `),
  );
});

test('a residual bare import is caught — the case a text scan misses entirely', () => {
  // This is what an --external build legitimately leaves in the output.
  const diagnostics = scanDeferredExecutableDependencies(
    `import { helper } from 'some-package';\nexport default { helper };`,
  );
  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.code),
    ['deferred_executable_dependency'],
  );
  assert.match(diagnostics[0]!.message, /still imports "some-package"/);
  assert.match(diagnostics[0]!.message, /line 1/);
});

test('re-exports from an external module are caught too', () => {
  assert.deepEqual(codes(`export * from 'some-package';`), ['deferred_executable_dependency']);
  assert.deepEqual(codes(`export { a } from 'some-package';`), ['deferred_executable_dependency']);
});

test('node: built-ins are the single declared exception', () => {
  assert.ok(isClosed(`import { readFile } from 'node:fs/promises';\nexport default { readFile };`));
  assert.ok(isClosed(`export * from 'node:path';`));
  assert.ok(isClosed(`const p = await import('node:os');\nexport default p;`));
});

test('bare built-in specifiers are not exempt, because a specifier alone cannot prove intent', () => {
  // `fs` is indistinguishable from an unbundled package by specifier; the scaffold uses `node:fs`.
  assert.deepEqual(codes(`import fs from 'fs';\nexport default fs;`), [
    'deferred_executable_dependency',
  ]);
});

test('a deferred import() is caught, whether its specifier is literal or computed', () => {
  assert.deepEqual(codes(`const m = await import('some-package');\nexport default m;`), [
    'deferred_executable_dependency',
  ]);
  const computed = scanDeferredExecutableDependencies(
    `const name = 'some' + 'package';\nconst m = await import(name);\nexport default m;`,
  );
  assert.equal(computed.length, 1);
  assert.match(computed[0]!.message, /computed specifier/);
});

test('each deferred-load construct is reported', () => {
  for (const source of [
    `import { createRequire } from 'node:module';\nconst r = createRequire(import.meta.url);\nexport default r;`,
    `process.dlopen({}, 'addon.node');\nexport default {};`,
    `const b = process.binding('fs');\nexport default b;`,
    `const v = eval('1 + 1');\nexport default v;`,
    `const f = new Function('return 1');\nexport default f;`,
    `const f = Function('return 1')();\nexport default f;`,
  ]) {
    assert.ok(codes(source).includes('deferred_executable_dependency'), source);
  }
});

test('a prompt string and a comment containing eval( are accepted', () => {
  // The two false positives a text scan produces. Strings and comments are not AST nodes.
  assert.ok(
    isClosed(
      `// Never let the agent call eval( on user input.\n` +
        `const prompt = "Explain why eval('x') is unsafe, and what require('fs') would do.";\n` +
        `/* import { danger } from 'some-package' */\n` +
        `export default { prompt };`,
    ),
  );
});

test('an identifier that merely resembles a safe name is not flagged', () => {
  assert.ok(
    isClosed(
      `const evaluation = { createRequirement: 1, bindings: 2 };\nexport default { evaluation };`,
    ),
  );
});

test('an unparseable artifact fails closed with an explanation', () => {
  const diagnostics = scanDeferredExecutableDependencies('export default { ');
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0]!.message, /could not be analyzed as an ES module/);
});

test('a loader call is caught however the binding reached the call site', () => {
  // Each of these loads a package that is not in the artifact. They differ only in how the loader
  // binding is spelled, aliased, or ordered relative to its use.
  for (const source of [
    `import { createRequire } from 'node:module';\nexport default createRequire(import.meta.url)('pkg');`,
    `import { createRequire as cr } from 'node:module';\nexport default cr(import.meta.url)('pkg');`,
    `import * as ns from 'node:module';\nexport default ns.createRequire(import.meta.url)('pkg');`,
    `import mod from 'node:module';\nexport default mod.createRequire(import.meta.url)('pkg');`,
    `const m = await import('node:module');\nexport default m.createRequire(import.meta.url)('pkg');`,
    `const { createRequire } = await import('node:module');\nexport default createRequire(import.meta.url)('pkg');`,
    `import { createRequire } from 'node:module';\nconst cr = createRequire;\nexport default cr(import.meta.url)('pkg');`,
    `import * as ns from 'node:module';\nconst { createRequire: cr } = ns;\nexport default cr(import.meta.url)('pkg');`,
    `import * as ns from 'node:module';\nconst cr = ns.createRequire;\nexport default cr(import.meta.url)('pkg');`,
    `import * as ns from 'node:module';\nconst a = ns;\nexport default a.createRequire(import.meta.url)('pkg');`,
  ]) {
    assert.ok(codes(source).includes('deferred_executable_dependency'), source);
  }
});

test('an alias declared after the code that uses it is still caught', () => {
  // Aliases resolve to a fixpoint rather than in source order, so a function that runs later but is
  // written earlier sees the same binding the engine will.
  for (const source of [
    `import { createRequire } from 'node:module';\nfunction load() { return cr(import.meta.url)('pkg'); }\nconst cr = createRequire;\nexport default load();`,
    `import { createRequire } from 'node:module';\nconst load = () => cr(import.meta.url)('pkg');\nconst cr = createRequire;\nexport default load();`,
    `import { createRequire } from 'node:module';\n{ var cr = createRequire; }\nexport default cr(import.meta.url)('pkg');`,
  ]) {
    assert.ok(codes(source).includes('deferred_executable_dependency'), source);
  }
});

test('importing node:module is permitted; only calling a loader through it is not', () => {
  // `node:` built-ins are explicitly allowed. Acquiring a binding is not the failure.
  for (const source of [
    `import * as mod from 'node:module';\nexport default mod.builtinModules;`,
    `import mod from 'node:module';\nexport default mod.isBuiltin('node:fs');`,
    `import { builtinModules } from 'node:module';\nexport default builtinModules.length;`,
    `import { createRequire } from 'node:module';\nexport default 1;`,
  ]) {
    assert.ok(isClosed(source), source);
  }
});

test("a name that resolves to the author's own binding is theirs, not the global", () => {
  // Every one of these is a valid closed bundle. Getting them right needs real binding resolution:
  // `var` hoisting out of a block, parameter scopes, a named function expression's self-binding,
  // and a parameter that shadows a real import.
  for (const source of [
    `var process = { binding: () => 1 };\nexport default process.binding('fs');`,
    `function f(process) { return process.binding('fs'); }\nexport default f({ binding: () => 1 });`,
    `const f = function process() { return process.binding('fs'); };\nexport default f;`,
    `function process() { return process.binding('fs'); }\nexport default process;`,
    `{ const Function = (s) => s; void Function('x'); }\nexport default 1;`,
    `import { createRequire } from 'node:module';\nfunction f(createRequire) { return createRequire(); }\nexport default f(() => 1);`,
    `const module = { createRequire() { return 1; } };\nexport default module.createRequire();`,
    `function binding() { return 1; }\nexport default binding();`,
    `const p = { eval: (s) => s };\nexport default p.eval('x');`,
    `var process = { env: {} };\nexport default process.env;`,
  ]) {
    assert.ok(isClosed(source), source);
  }
});

test('a declaration in an unrelated scope does not shadow the module-level global', () => {
  assert.ok(
    codes(
      `function shim() { const process = { env: {} }; return process; }\nexport default process.binding('fs');`,
    ).includes('deferred_executable_dependency'),
  );
});

test('the native loader calls are reported', () => {
  for (const source of [
    `export default process.binding('fs');`,
    `process.dlopen({}, 'addon.node');\nexport default {};`,
    `export default eval('1 + 1');`,
    `export default new Function('return 1');`,
    `export default Function('return 1')();`,
  ]) {
    assert.ok(codes(source).includes('deferred_executable_dependency'), source);
  }
});

test('the same construct is classified the same way however the function is written', () => {
  const declaration = `function f(fs) { return fs.binding('x'); }\nexport default f;`;
  const arrow = `const f = (fs) => fs.binding('x');\nexport default f;`;
  assert.deepEqual(codes(declaration), codes(arrow));
  assert.ok(isClosed(declaration));
});

test('a namespace used directly, with no binding in between, is still a namespace', () => {
  // `(await import('node:module')).createRequire(…)` has no intermediate variable, so binding
  // resolution alone never sees it. It is ordinary syntax, not computed indirection.
  for (const source of [
    `export default (await import('node:module')).createRequire(import.meta.url)('pkg');`,
    `const req = (await import('node:module')).createRequire(import.meta.url);\nexport default req('pkg');`,
    `const cr = (await import('node:module')).createRequire;\nexport default cr(import.meta.url)('pkg');`,
  ]) {
    assert.ok(codes(source).includes('deferred_executable_dependency'), source);
  }
});

test('an inert member call on that same namespace is still a closed bundle', () => {
  assert.ok(isClosed(`export default (await import('node:module')).isBuiltin('node:fs');`));
});

test('a destructured loader alias is caught even when it carries a default', () => {
  // The bound name sits inside an AssignmentPattern, so the property value is not the identifier.
  for (const source of [
    `import * as ns from 'node:module';\nconst fallback = () => () => 1;\nconst { createRequire: cr = fallback } = ns;\nexport default cr(import.meta.url)('pkg');`,
    `const fb = () => () => 1;\nconst { createRequire: cr = fb } = await import('node:module');\nexport default cr(import.meta.url)('pkg');`,
  ]) {
    assert.ok(codes(source).includes('deferred_executable_dependency'), source);
  }
});

test('destructuring an inert export with a default stays closed', () => {
  assert.ok(
    isClosed(
      `import * as ns from 'node:module';\nconst { builtinModules: bm = [] } = ns;\nexport default bm;`,
    ),
  );
});

test('a loader reached through a plain assignment is an alias like any other', () => {
  // `let cr; cr = createRequire;` binds exactly what `const cr = createRequire` binds. Reading only
  // declarator initializers missed every one of these, each of which loads an external package.
  for (const source of [
    `import { createRequire } from 'node:module';\nlet cr;\ncr = createRequire;\nexport default cr(import.meta.url)('pkg');`,
    `import * as ns from 'node:module';\nlet m;\nm = ns;\nexport default m.createRequire(import.meta.url)('pkg');`,
    `import * as ns from 'node:module';\nlet cr;\ncr = ns.createRequire;\nexport default cr(import.meta.url)('pkg');`,
    `import * as ns from 'node:module';\nlet cr;\n({ createRequire: cr } = ns);\nexport default cr(import.meta.url)('pkg');`,
    `let m;\nm = await import('node:module');\nexport default m.createRequire(import.meta.url)('pkg');`,
  ]) {
    assert.ok(codes(source).includes('deferred_executable_dependency'), source);
  }
});

test('a binding ever assigned a loader stays one, so reassignment cannot launder it', () => {
  // Which of the two values a given call sees is not a question this check answers, so it fails
  // closed rather than accepting the artifact.
  assert.ok(
    codes(
      `import { createRequire } from 'node:module';\nlet cr = createRequire;\ncr = () => () => 1;\nexport default cr(import.meta.url)('pkg');`,
    ).includes('deferred_executable_dependency'),
  );
});

test('an assignment that carries no loader leaves the bundle closed', () => {
  for (const source of [
    `import * as ns from 'node:module';\nlet bm;\nbm = ns.builtinModules;\nexport default bm;`,
    `let cr;\ncr = (u) => () => 1;\nexport default cr(import.meta.url)('pkg');`,
    `import { createRequire } from 'node:module';\nfunction f() { let createRequire; createRequire = (u) => () => 1; return createRequire(1)(2); }\nexport default f;`,
  ]) {
    assert.ok(isClosed(source), source);
  }
});

test('a chained assignment gives every target the same loader', () => {
  // Assignment is right-associative and evaluates to its right-hand side, so `a = b = createRequire`
  // makes both a loader. Only `b` was caught before, because `a`'s initializer is itself an
  // assignment rather than an identifier.
  for (const source of [
    `import { createRequire } from 'node:module';\nlet a, b;\na = b = createRequire;\nexport default a(import.meta.url)('pkg');`,
    `import { createRequire } from 'node:module';\nlet a, b;\na = b = createRequire;\nexport default b(import.meta.url)('pkg');`,
    `import { createRequire } from 'node:module';\nlet a, b, c;\na = b = c = createRequire;\nexport default a(import.meta.url)('pkg');`,
    `import { createRequire } from 'node:module';\nlet b;\nconst a = b = createRequire;\nexport default a(import.meta.url)('pkg');`,
    `import * as ns from 'node:module';\nlet a, b;\na = b = ns;\nexport default a.createRequire(import.meta.url)('pkg');`,
    `import { createRequire } from 'node:module';\nconst a = (0, createRequire);\nexport default a(import.meta.url)('pkg');`,
  ]) {
    assert.ok(codes(source).includes('deferred_executable_dependency'), source);
  }
});

test('a chain that carries no loader leaves the bundle closed', () => {
  for (const source of [
    `let a, b;\na = b = (u) => () => 1;\nexport default a(import.meta.url)('pkg');`,
    `import * as ns from 'node:module';\nlet a, b;\na = b = ns.builtinModules;\nexport default a;`,
  ]) {
    assert.ok(isClosed(source), source);
  }
});

test('a logical assignment aliases a loader just as a plain one does', () => {
  // `cr ||= createRequire` is conditional, but which branch a given run takes is not a question
  // this check answers, so a loader on the right-hand side makes the target one. Fails closed.
  for (const source of [
    `import { createRequire } from 'node:module';\nlet cr;\ncr ||= createRequire;\nexport default cr(import.meta.url)('pkg');`,
    `import { createRequire } from 'node:module';\nlet cr;\ncr ??= createRequire;\nexport default cr(import.meta.url)('pkg');`,
    `import { createRequire } from 'node:module';\nlet cr = () => () => 1;\ncr &&= createRequire;\nexport default cr(import.meta.url)('pkg');`,
    `import * as ns from 'node:module';\nlet m;\nm ||= ns;\nexport default m.createRequire(import.meta.url)('pkg');`,
    `import * as ns from 'node:module';\nlet cr;\ncr ??= ns.createRequire;\nexport default cr(import.meta.url)('pkg');`,
    `import { createRequire } from 'node:module';\nlet a, b;\na = (b ??= createRequire);\nexport default a(import.meta.url)('pkg');`,
  ]) {
    assert.ok(codes(source).includes('deferred_executable_dependency'), source);
  }
});

test('a logical assignment that carries no loader leaves the bundle closed', () => {
  for (const source of [
    `let cr;\ncr ||= (u) => () => 1;\nexport default cr(import.meta.url)('pkg');`,
    `import * as ns from 'node:module';\nlet bm;\nbm ??= ns.builtinModules;\nexport default bm;`,
    // An arithmetic compound cannot yield a loader, so it is not an alias candidate at all.
    `import { createRequire } from 'node:module';\nlet n = 0;\nn += 1;\nexport default n;`,
    `import { createRequire } from 'node:module';\nfunction f() { let createRequire; createRequire ||= (u) => () => 1; return createRequire(1)(2); }\nexport default f;`,
  ]) {
    assert.ok(isClosed(source), source);
  }
});
