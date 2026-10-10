// Runtime module boundaries (issue #31): checks `apps/runtime/src` against the manifest `apps/runtime/module-boundaries.json`.
//
// Manifest semantics:
//   root             source root, repo-relative (`apps/runtime/src`)
//   compositionRoot  files (`index.ts`) and directory prefixes ending in `/` (`app/`) that assemble the modules
//   testFiles        globs, relative to root, for test-only code (default below)
//   modules          `{ "<name>": { path, public?, testing?, dependsOn? } }`; platform areas are modules too.
//                    `public` defaults to ["index.ts"], `testing` to "testing.ts". A `dependsOn` entry ending in `/*`
//                    expands to every other module whose name has that prefix.
//   tableOwners      `{ "<module>": ["<exported table identifier>", ...] }`
//   externals        `{ "<package>": { paths?: ["<prefix under root>"], basenames?: ["<glob>"] } }`
//
// Rules (one message per violation, each starting with its rule id so the runner can treat rules separately):
//   R1  every source file under root is inside a declared module or the composition root
//   R2  a cross-module import targets a declared public file; test files may also target the module's testing file
//   R3  the target module is in the importer's expanded dependsOn (type-only imports included); a test file may target
//       any module in the transitive closure of its module's dependsOn
//   R4  production files never import a test file (any module, including their own)
//   R5  dependsOn names exist and the declared graph is acyclic
//   R6  nothing outside the composition root imports the composition root
//   R7  in a production file of module M, a table identifier (tableOwners) of another module imported from that
//       module is never the first argument of `.insert(`, `.update(` or `.delete(`: only the owner writes its tables
//   R8  a `tables.ts` imports only `drizzle-orm`, `drizzle-orm/*`, `@isagi/contracts` and other modules' `tables.ts`
//   R9  a bare import of a package listed in externals comes only from a listed path prefix or basename glob (test
//       files exempt)
//   R10 production files: no `index.ts` below a module root (sub-folder barrel), no `export *` in a module `index.ts`
//   R11 no production file basename starts with `<parent-directory-name>.` (the legacy `commands/commands.service.ts`
//       pattern); test files are exempt because the target tree keeps `workflows/checkpoints/checkpoints.test.ts` and
//       the workflow fixture packages (`workflows/tests/fixtures/<name>/<name>.test.ts`) unchanged
//   R12 every declared module path exists and contains `index.ts`
//
// Imports are found on comment-stripped text (see source-files.mjs); TypeScript 7 has no JS compiler API.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  importsOf,
  isMainModule,
  listSources,
  rel,
  resolveRelative,
  stripComments,
} from './source-files.mjs';

export const CONFIG_PATH = 'apps/runtime/module-boundaries.json';

export const DEFAULT_TEST_FILES = [
  '**/*.test.ts',
  '**/tests/**',
  '**/testing.ts',
  '**/*test-support.ts',
];

const COMPOSITION = '<composition-root>';
const TABLE_ALLOWED_PACKAGE = /^(drizzle-orm(\/.*)?|@isagi\/contracts(\/.*)?)$/;

/**
 * @typedef {{ name: string, path: string, public: string[], testing: string, dependsOn: string[] }} ModuleConfig
 * @typedef {{ paths: string[], basenames: string[], basenamePatterns: RegExp[] }} ExternalRule
 * @typedef {{ name: string, composition: boolean, module: ModuleConfig | null }} Owner
 */

/**
 * Glob (`**`, `*`, literal text) to an anchored RegExp over `/`-separated paths. `**\/` also matches zero directories.
 * @param {string} glob
 */
export const globToRegExp = (glob) => {
  let source = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*' && glob[i + 2] === '/') {
      source += '(?:.*/)?';
      i += 2;
    } else if (c === '*' && glob[i + 1] === '*') {
      source += '.*';
      i += 1;
    } else if (c === '*') source += '[^/]*';
    else source += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
};

/** `node:child_process` -> itself, `@scope/pkg/sub` -> `@scope/pkg`, `pkg/sub` -> `pkg`. @param {string} specifier */
export const packageOf = (specifier) => {
  if (specifier.startsWith('node:')) return specifier;
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
};

/** @param {unknown} value @param {string} what */
const stringArray = (value, what) => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string'))
    throw new Error(`module-boundaries: ${what} must be an array of strings`);
  return /** @type {string[]} */ (value);
};

/**
 * Reads and validates the manifest. A missing or malformed manifest throws: a broken config must not read as clean.
 * @param {string} configPath absolute path
 */
export const readConfig = (configPath) => {
  if (!existsSync(configPath))
    throw new Error(`module-boundaries: manifest ${configPath} does not exist`);
  const raw = JSON.parse(readFileSync(configPath, 'utf8'));
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error(`module-boundaries: manifest ${configPath} must be a JSON object`);
  if (typeof raw.root !== 'string' || raw.root === '')
    throw new Error('module-boundaries: "root" must be a non-empty string');
  if (raw.modules === null || typeof raw.modules !== 'object' || Array.isArray(raw.modules))
    throw new Error('module-boundaries: "modules" must be an object of name -> module');
  /** @type {ModuleConfig[]} */
  const modules = Object.entries(raw.modules).map(([name, m]) => {
    if (m === null || typeof m !== 'object' || typeof m.path !== 'string' || m.path === '')
      throw new Error(`module-boundaries: module ${name} needs a "path"`);
    if (m.testing !== undefined && typeof m.testing !== 'string')
      throw new Error(`module-boundaries: module ${name} "testing" must be a string`);
    return {
      name,
      path: m.path.replace(/\/+$/, ''),
      public: stringArray(m.public, `module ${name} "public"`) ?? ['index.ts'],
      testing: m.testing ?? 'testing.ts',
      dependsOn: stringArray(m.dependsOn, `module ${name} "dependsOn"`) ?? [],
    };
  });
  /** @type {Map<string, string>} table identifier -> owning module */
  const tableOwner = new Map();
  for (const [owner, tables] of Object.entries(raw.tableOwners ?? {})) {
    for (const table of stringArray(tables, `tableOwners.${owner}`) ?? [])
      tableOwner.set(table, owner);
  }
  /** @type {Map<string, ExternalRule>} */
  const externals = new Map();
  for (const [pkg, rule] of Object.entries(raw.externals ?? {})) {
    const basenames = stringArray(rule?.basenames, `externals.${pkg}.basenames`) ?? [];
    externals.set(pkg, {
      paths: stringArray(rule?.paths, `externals.${pkg}.paths`) ?? [],
      basenames,
      basenamePatterns: basenames.map(globToRegExp),
    });
  }
  return {
    root: raw.root.replace(/\/+$/, ''),
    compositionRoot: stringArray(raw.compositionRoot, '"compositionRoot"') ?? [],
    testFiles: (stringArray(raw.testFiles, '"testFiles"') ?? DEFAULT_TEST_FILES).map(globToRegExp),
    modules,
    tableOwner,
    externals,
  };
};

/** `import <clause> from '<specifier>'`, where the clause is default, `* as ns` and/or `{ a, b as c }`. */
const IMPORT_CLAUSE = /(?<=^|[\s;])import\s+(type\s+)?([\w$*{}\s,]+?)\s+from\s+['"]([^'"]+)['"]/g;
/** First argument of a Drizzle write: `.insert(x`, `.update(ns.x`, `.delete(x`. */
const TABLE_WRITE =
  /\.(insert|update|delete)\(\s*([A-Za-z_$][\w$]*)(?:\s*\.\s*([A-Za-z_$][\w$]*))?\s*[,)]/g;

/**
 * Value bindings of an import clause: named locals -> imported name, and namespace locals. Type-only names are skipped.
 * @param {string} clause
 */
const bindingsOf = (clause) => {
  /** @type {Map<string, string>} */
  const named = new Map();
  /** @type {string[]} */
  const namespaces = [];
  const namespace = clause.match(/\*\s*as\s+([\w$]+)/);
  if (namespace) namespaces.push(namespace[1]);
  const braces = clause.match(/\{([^}]*)\}/);
  for (const part of braces ? braces[1].split(',') : []) {
    const words = part.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0 || words[0] === 'type') continue;
    named.set(words[2] ?? words[0], words[0]);
  }
  return { named, namespaces };
};

/** 1-based line of `index` in `text`. @param {string} text @param {number} index */
const lineAt = (text, index) => text.slice(0, index).split('\n').length;

/**
 * @param {string} repoRoot absolute repo root
 * @param {string} [configPath] absolute manifest path; defaults to the committed manifest under `repoRoot`
 * @returns {string[]} one message per violation, each starting with its rule id (`R1`..`R12`); empty when clean
 */
export const checkModuleBoundaries = (repoRoot, configPath = join(repoRoot, CONFIG_PATH)) => {
  const config = readConfig(configPath);
  const configRel = rel(repoRoot, configPath);
  const root = join(repoRoot, config.root);
  if (!existsSync(root) || !statSync(root).isDirectory())
    throw new Error(`module-boundaries: root ${config.root} is not a directory`);
  /** @type {string[]} */
  const errors = [];
  const byName = new Map(config.modules.map((m) => [m.name, m]));

  // R5: expand `prefix/*`, report unknown names, then look for cycles in the expanded graph.
  /** @type {Map<string, string[]>} */
  const deps = new Map();
  for (const m of config.modules) {
    /** @type {string[]} */
    const expanded = [];
    for (const dep of m.dependsOn) {
      if (dep.endsWith('/*')) {
        const prefix = dep.slice(0, -1);
        const matches = config.modules.filter(
          (o) => o.name !== m.name && o.name.startsWith(prefix),
        );
        if (matches.length === 0)
          errors.push(`R5 ${configRel}: ${m.name} dependsOn ${dep}, which matches no module`);
        expanded.push(...matches.map((o) => o.name));
      } else if (byName.has(dep)) expanded.push(dep);
      else errors.push(`R5 ${configRel}: ${m.name} dependsOn unknown module ${dep}`);
    }
    deps.set(m.name, [...new Set(expanded)]);
  }
  const done = new Set();
  /** @type {string[]} */
  const stack = [];
  /** @param {string} name */
  const visit = (name) => {
    if (done.has(name)) return;
    const at = stack.indexOf(name);
    if (at !== -1) {
      errors.push(`R5 ${configRel}: dependency cycle ${[...stack.slice(at), name].join(' -> ')}`);
      return;
    }
    stack.push(name);
    for (const dep of deps.get(name) ?? []) visit(dep);
    stack.pop();
    done.add(name);
  };
  for (const m of config.modules) visit(m.name);
  /** @type {Map<string, Set<string>>} */
  const closures = new Map();
  /** @param {string} name */
  const closureOf = (name) => {
    let closure = closures.get(name);
    if (!closure) {
      closure = new Set();
      const pending = [...(deps.get(name) ?? [])];
      while (pending.length > 0) {
        const next = /** @type {string} */ (pending.pop());
        if (closure.has(next)) continue;
        closure.add(next);
        pending.push(...(deps.get(next) ?? []));
      }
      closures.set(name, closure);
    }
    return closure;
  };

  // R12
  for (const m of config.modules) {
    const dir = join(root, m.path);
    if (!existsSync(dir) || !statSync(dir).isDirectory())
      errors.push(
        `R12 ${configRel}: module ${m.name} path ${config.root}/${m.path} does not exist`,
      );
    else if (!existsSync(join(dir, 'index.ts')))
      errors.push(`R12 ${config.root}/${m.path}: module ${m.name} has no index.ts`);
  }

  /** @param {string} relPath @returns {Owner | null} */
  const ownerOf = (relPath) => {
    const composition = config.compositionRoot.some((entry) =>
      entry.endsWith('/') ? relPath.startsWith(entry) : relPath === entry,
    );
    if (composition) return { name: COMPOSITION, composition: true, module: null };
    let best = null;
    for (const m of config.modules) {
      if (
        (relPath === m.path || relPath.startsWith(`${m.path}/`)) &&
        (!best || m.path.length > best.path.length)
      )
        best = m;
    }
    return best ? { name: best.name, composition: false, module: best } : null;
  };
  /** @param {string} relPath */
  const isTest = (relPath) => config.testFiles.some((glob) => glob.test(relPath));

  for (const file of listSources(root)) {
    const fileRel = rel(root, file);
    const at = (/** @type {number} */ line) => `${config.root}/${fileRel}:${line}`;
    const name = basename(fileRel);
    const parent = basename(dirname(fileRel));
    const test = isTest(fileRel);
    if (!test && dirname(fileRel) !== '.' && name.startsWith(`${parent}.`))
      errors.push(
        `R11 ${config.root}/${fileRel}: file name repeats its directory name "${parent}"`,
      );

    const owner = ownerOf(fileRel);
    if (!owner) {
      errors.push(
        `R1 ${config.root}/${fileRel}: not inside any declared module or the composition root`,
      );
      continue;
    }
    const ownModule = owner.module;
    const isTables = ownModule !== null && name === 'tables.ts';
    const text = stripComments(readFileSync(file, 'utf8'));

    if (ownModule && !test && name === 'index.ts') {
      if (dirname(fileRel) !== ownModule.path)
        errors.push(
          `R10 ${config.root}/${fileRel}: sub-folder barrel; export from ${ownModule.path}/index.ts instead`,
        );
      else
        for (const match of text.matchAll(/\bexport\s+(?:type\s+)?\*/g))
          errors.push(
            `R10 ${at(lineAt(text, match.index))}: \`export *\`; re-export names explicitly`,
          );
    }

    for (const { specifier, line } of importsOf(file)) {
      if (!specifier.startsWith('.')) {
        if (isTables && !TABLE_ALLOWED_PACKAGE.test(specifier))
          errors.push(
            `R8 ${at(line)}: tables.ts imports ${specifier}; only drizzle-orm, @isagi/contracts and other modules' tables.ts are allowed`,
          );
        const rule = config.externals.get(packageOf(specifier));
        if (rule && !test) {
          const allowed =
            rule.paths.some((prefix) => fileRel.startsWith(prefix)) ||
            rule.basenamePatterns.some((glob) => glob.test(name));
          if (!allowed)
            errors.push(
              `R9 ${at(line)}: imports ${specifier}, which only ${[...rule.paths, ...rule.basenames].join(', ')} may import`,
            );
        }
        continue;
      }
      const target = /** @type {string} */ (resolveRelative(file, specifier));
      const targetRel = rel(root, target);
      if (targetRel.startsWith('..')) {
        if (isTables)
          errors.push(`R8 ${at(line)}: tables.ts imports ${specifier} from outside ${config.root}`);
        continue;
      }
      if (!test && isTest(targetRel))
        errors.push(
          `R4 ${at(line)}: production code imports test file ${config.root}/${targetRel}`,
        );
      const targetOwner = ownerOf(targetRel);
      if (!targetOwner) {
        // The target itself is reported by R1.
        if (isTables)
          errors.push(
            `R8 ${at(line)}: tables.ts imports ${config.root}/${targetRel}, which is not a module's tables.ts`,
          );
        continue;
      }
      if (targetOwner.composition) {
        if (!owner.composition)
          errors.push(`R6 ${at(line)}: imports the composition root (${config.root}/${targetRel})`);
        continue;
      }
      const targetModule = /** @type {ModuleConfig} */ (targetOwner.module);
      const inside = targetRel.slice(targetModule.path.length + 1);
      if (isTables && (targetOwner.name === owner.name || inside !== 'tables.ts'))
        errors.push(
          `R8 ${at(line)}: tables.ts imports ${config.root}/${targetRel}; only other modules' tables.ts are allowed`,
        );
      if (targetOwner.name === owner.name) continue;
      if (!targetModule.public.includes(inside) && !(test && inside === targetModule.testing)) {
        const surface = test ? [...targetModule.public, targetModule.testing] : targetModule.public;
        errors.push(
          `R2 ${at(line)}: deep import into ${targetModule.name} (${inside}); use ${surface.join(' | ')}`,
        );
      }
      if (ownModule) {
        const allowed = test
          ? closureOf(owner.name).has(targetModule.name)
          : (deps.get(owner.name) ?? []).includes(targetModule.name);
        if (!allowed)
          errors.push(
            `R3 ${at(line)}: ${owner.name} -> ${targetModule.name} is not a declared ${test ? 'transitive ' : ''}dependency`,
          );
      }
    }

    // R7: collect other modules' table identifiers imported here, then look for writes to them.
    if (ownModule && !test && config.tableOwner.size > 0) {
      /** @type {Map<string, string>} local name -> table identifier */
      const tables = new Map();
      /** @type {Set<string>} */
      const namespaces = new Set();
      for (const match of text.matchAll(IMPORT_CLAUSE)) {
        if (match[1]) continue;
        const targetOwner = match[3].startsWith('.')
          ? ownerOf(rel(root, /** @type {string} */ (resolveRelative(file, match[3]))))
          : null;
        if (!targetOwner || targetOwner.composition || targetOwner.name === owner.name) continue;
        const { named, namespaces: locals } = bindingsOf(match[2]);
        for (const [local, imported] of named) {
          const tableModule = config.tableOwner.get(imported);
          if (tableModule && tableModule !== owner.name) tables.set(local, imported);
        }
        for (const local of locals) namespaces.add(local);
      }
      if (tables.size > 0 || namespaces.size > 0) {
        for (const match of text.matchAll(TABLE_WRITE)) {
          const [, verb, first, member] = match;
          const table =
            member === undefined ? tables.get(first) : namespaces.has(first) ? member : undefined;
          const tableModule = table === undefined ? undefined : config.tableOwner.get(table);
          if (table === undefined || tableModule === undefined || tableModule === owner.name)
            continue;
          errors.push(
            `R7 ${at(lineAt(text, match.index))}: ${owner.name} writes (${verb}) ${tableModule}'s table ${table}; only the owning module writes its tables`,
          );
        }
      }
    }
  }
  return errors;
};

/** Rule id of a violation message (`R2 apps/...` -> `R2`). @param {string} violation */
export const ruleOf = (violation) => violation.slice(0, violation.indexOf(' '));

/** `R2 312, R3 48, ...` in rule order. @param {string[]} violations */
export const summarizeRules = (violations) => {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const violation of violations)
    counts.set(ruleOf(violation), (counts.get(ruleOf(violation)) ?? 0) + 1);
  return [...counts]
    .sort(([a], [b]) => Number(a.slice(1)) - Number(b.slice(1)))
    .map(([rule, count]) => `${rule} ${count}`)
    .join(', ');
};

if (isMainModule(import.meta.url)) {
  const repoRoot = resolve(
    process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '../..'),
  );
  const configPath = process.argv[3] === undefined ? undefined : resolve(process.argv[3]);
  const errors = checkModuleBoundaries(repoRoot, configPath);
  for (const error of errors) console.error(error);
  const summary = errors.length > 0 ? ` (${summarizeRules(errors)})` : '';
  console.error(`module-boundaries: ${errors.length} violation(s)${summary}`);
  process.exit(errors.length > 0 ? 1 : 0);
}
