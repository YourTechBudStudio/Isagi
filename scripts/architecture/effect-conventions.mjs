// Effect convention rules no other check covers (plan R6, S4.Z; conventions §16; arch §4.5). Production files only:
// test files, test support and `testing.ts` surfaces are skipped. One message per violation, each starting with its
// rule id so the runner can keep a rule report-only (`reportRules`).
//   E1  services are class-form `class X extends Context.Service<X, Shape>()("id")`; the function form
//       `Context.Service<Shape>("id")` (the S2 drop-in for v3 `GenericTag`) is gone
//   E2  service and reference ids match `^isagi/(runtime|runtime-client|desktop|cli|web)/` (plan R7), are unique
//       repo-wide, end in the class name for class-form services, and inside the runtime name the owning module:
//       `isagi/runtime/<module>/…` or `isagi/runtime/platform/<area>/…` (runtime-modules §4.9)
//   E3  no `Effect.forkDetach`: every fiber belongs to a scope
//   E4  no `Effect.Effect<…, unknown…>` error channel outside the workflow author bridge (arch §4.3, §7)
//   E5  no `setTimeout(`/`setInterval(` in the runtime: time is `Effect.sleep`/`Schedule` (arch §3.2, conventions §6)
//   E6  `extends Error` in the runtime only for the invariant and pure-validator classes arch §4.2/§4.3 rule 1 keep
//   E7  contracts import nothing from `effect` but `Schema`/`SchemaTransformation` (contracts stay descriptive)
//
// Like the other checks this reads comment-stripped source text, not an AST (TypeScript 7 has no JS compiler API).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isMainModule, isTestFile, listSources, rel, stripComments } from './source-files.mjs';

/** Production source roots checked by E1–E4. */
export const SCANNED_DIRS = [
  'apps/runtime/src',
  'apps/desktop/src',
  'apps/cli/src',
  'apps/web/src',
  'packages/runtime-client/src',
  'packages/contracts/src',
];

const RUNTIME_SRC = 'apps/runtime/src/';
const CONTRACTS_SRC = 'packages/contracts/src/';

/** E4: the one file whose input may carry an `unknown` error channel (author effects of any error type). */
export const UNKNOWN_CHANNEL_ALLOWLIST = new Set([
  'apps/runtime/src/workflows/engine/author-bridge.ts',
]);

/**
 * E6: `extends Error` classes the runtime keeps on purpose, by file. Each is either an invariant violation raised only
 * as a defect, or a private error a pure validator throws and one `Effect.try` turns into the module's tagged error.
 * An entry that no longer matches fails, so the list only shrinks.
 */
export const ERROR_SUBCLASS_ALLOWLIST = {
  'apps/runtime/src/editor/contexts/row-mapper.ts': {
    EditorContextRowInvariantViolation:
      'invariant violation, used only with Effect.die (arch §4.2)',
  },
  'apps/runtime/src/workflows/state/serializable.ts': {
    UnserializableValueError:
      'pure validator on author data, caught at one Effect.try in the engine (arch §4.2)',
  },
  'apps/runtime/src/workflows/state/isolation.ts': {
    IsolationError:
      'pure validator on author data, caught at one Effect.try in the engine (arch §4.2)',
  },
  'apps/runtime/src/projects/config/normalize.ts': {
    ProjectConfigInvalid:
      'module-private error of the project-config normalizers, called only through one Effect.try that produces ProjectConfigError (arch §4.3 rule 1)',
  },
};

const SERVICE_ID = /^isagi\/(runtime|runtime-client|desktop|cli|web)\//;
const CONTRACT_EFFECT_NAMES = new Set(['Schema', 'SchemaTransformation']);

const FORK_DETACH = /\bEffect\.forkDetach\b/g;
const TIMER = /(?<![\w$.])(?:globalThis\.)?set(?:Timeout|Interval)\s*\(/g;
const EXTENDS_ERROR = /\bclass\s+([A-Za-z_$][\w$]*)(?:\s*<[^{]*?>)?\s+extends\s+Error\b/g;
const SERVICE = /\bContext\.(Service|Reference)\s*</g;
const EFFECT_TYPE = /\bEffect\.Effect\s*</g;
const EFFECT_IMPORT =
  /\b(?:import|export)\s+(type\s+)?([^'";]*?)\s+from\s+['"](effect(?:\/[^'"]*)?)['"]|\bimport\s*\(\s*['"](effect(?:\/[^'"]*)?)['"]\s*\)/g;

/** 1-based line of `index` in `text`. @param {string} text @param {number} index */
const lineAt = (text, index) => text.slice(0, index).split('\n').length;

/**
 * Splits the type arguments of a generic whose `<` is at `open` into top-level arguments. Returns the arguments and
 * the index just past the closing `>`, or null when the text ends first. `=>` is an arrow, not a closing bracket.
 * @param {string} text @param {number} open index of `<`
 * @returns {{ args: string[], end: number } | null}
 */
export const typeArguments = (text, open) => {
  const closers = { '<': '>', '(': ')', '[': ']', '{': '}' };
  /** @type {string[]} */
  const stack = ['>'];
  /** @type {string[]} */
  const args = [];
  let start = open + 1;
  for (let i = open + 1; i < text.length; i += 1) {
    const c = text[i];
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
      i = j;
    } else if (c in closers) stack.push(closers[/** @type {keyof typeof closers} */ (c)]);
    else if (c === '>' && text[i - 1] === '=') continue;
    else if (c === '>' || c === ')' || c === ']' || c === '}') {
      if (stack.at(-1) !== c) return null;
      stack.pop();
      if (stack.length === 0) {
        args.push(text.slice(start, i).trim());
        return { args, end: i + 1 };
      }
    } else if (c === ',' && stack.length === 1) {
      args.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  return null;
};

/** True when a type argument is `unknown` or a union with an `unknown` member. @param {string} type */
const hasUnknown = (type) =>
  type
    .split('|')
    .map((member) => member.trim())
    .includes('unknown');

/**
 * Where the runtime expects `file`'s service ids to live: `isagi/runtime/<module>/` or
 * `isagi/runtime/platform/<area>/`. Null outside the runtime and for the composition root (`src/index.ts`).
 * @param {string} file repo-relative
 */
const runtimeIdPrefix = (file) => {
  if (!file.startsWith(RUNTIME_SRC)) return null;
  const parts = file.slice(RUNTIME_SRC.length).split('/');
  if (parts.length < 2) return null;
  if (parts[0] === 'platform')
    return parts.length < 3 ? null : `isagi/runtime/platform/${parts[1]}/`;
  return `isagi/runtime/${parts[0]}/`;
};

/**
 * @param {string} file repo-relative
 * @param {string} text comment-stripped source
 * @param {Map<string, string>} ids id -> first `file:line` seen (E2 uniqueness, across files)
 * @param {string[]} errors
 */
const checkServices = (file, text, ids, errors) => {
  for (const match of text.matchAll(SERVICE)) {
    const line = lineAt(text, match.index);
    const kind = match[1];
    const before = text.slice(Math.max(0, match.index - 200), match.index);
    const classMatch = /\bclass\s+([A-Za-z_$][\w$]*)\s+extends\s+$/.exec(before);
    const generic = typeArguments(text, match.index + match[0].length - 1);
    if (generic === null) continue;
    const rest = text.slice(generic.end);
    if (kind === 'Service' && classMatch === null) {
      errors.push(
        `E1 ${file}:${line}: function-form Context.Service; declare \`class X extends Context.Service<X, Shape>()("id")\``,
      );
      continue;
    }
    const idMatch =
      kind === 'Service'
        ? /^\s*\(\s*\)\s*\(\s*(['"])([^'"]+)\1/.exec(rest)
        : /^\s*\(\s*(['"])([^'"]+)\1/.exec(rest);
    if (idMatch === null) {
      errors.push(`E2 ${file}:${line}: Context.${kind} id must be a string literal`);
      continue;
    }
    const id = idMatch[2];
    if (!SERVICE_ID.test(id)) {
      errors.push(
        `E2 ${file}:${line}: id ${JSON.stringify(id)} must start with isagi/(runtime|runtime-client|desktop|cli|web)/`,
      );
    } else {
      const prefix = runtimeIdPrefix(file);
      if (prefix !== null && !id.startsWith(prefix))
        errors.push(`E2 ${file}:${line}: id ${JSON.stringify(id)} must start with ${prefix}`);
    }
    if (classMatch !== null && !id.endsWith(`/${classMatch[1]}`))
      errors.push(`E2 ${file}:${line}: id ${JSON.stringify(id)} must end with /${classMatch[1]}`);
    const first = ids.get(id);
    if (first === undefined) ids.set(id, `${file}:${line}`);
    else errors.push(`E2 ${file}:${line}: id ${JSON.stringify(id)} is already used at ${first}`);
  }
};

/** @param {string} file @param {string} text @param {string[]} errors */
const checkUnknownChannels = (file, text, errors) => {
  if (UNKNOWN_CHANNEL_ALLOWLIST.has(file)) return;
  for (const match of text.matchAll(EFFECT_TYPE)) {
    const generic = typeArguments(text, match.index + match[0].length - 1);
    const error = generic?.args[1];
    if (error !== undefined && hasUnknown(error))
      errors.push(
        `E4 ${file}:${lineAt(text, match.index)}: Effect.Effect with an unknown error channel; declare the failures it can have`,
      );
  }
};

/** @param {string} file @param {string} text @param {string[]} errors */
const checkContractImports = (file, text, errors) => {
  for (const match of text.matchAll(EFFECT_IMPORT)) {
    const line = lineAt(text, match.index);
    const specifier = match[3] ?? match[4];
    if (specifier !== 'effect') {
      errors.push(
        `E7 ${file}:${line}: contracts import ${JSON.stringify(specifier)}; only Schema/SchemaTransformation from "effect"`,
      );
      continue;
    }
    const clause = match[2] ?? '';
    const named = /^\{([\s\S]*)\}$/.exec(clause.trim());
    if (named === null) {
      errors.push(
        `E7 ${file}:${line}: contracts import "effect" as ${clause.trim() || 'a dynamic import'}; name Schema/SchemaTransformation`,
      );
      continue;
    }
    for (const part of named[1].split(',')) {
      const name = part
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)[0]
        ?.trim();
      if (name && !CONTRACT_EFFECT_NAMES.has(name))
        errors.push(
          `E7 ${file}:${line}: contracts import ${name} from "effect"; only Schema/SchemaTransformation`,
        );
    }
  }
};

/**
 * @param {string} repoRoot absolute repo root
 * @returns {string[]} one message per violation; empty when the repo conforms
 */
export const checkEffectConventions = (repoRoot) => {
  /** @type {string[]} */
  const errors = [];
  /** @type {Map<string, string>} */
  const ids = new Map();
  /** @type {Set<string>} */
  const allowedErrorsSeen = new Set();
  for (const dir of SCANNED_DIRS) {
    const abs = join(repoRoot, dir);
    if (!existsSync(abs)) continue;
    for (const path of listSources(abs)) {
      const file = rel(repoRoot, path);
      if (isTestFile(file)) continue;
      const text = stripComments(readFileSync(path, 'utf8'));
      checkServices(file, text, ids, errors);
      for (const match of text.matchAll(FORK_DETACH))
        errors.push(
          `E3 ${file}:${lineAt(text, match.index)}: Effect.forkDetach; fork into a scope (forkScoped, FiberSet, FiberMap)`,
        );
      checkUnknownChannels(file, text, errors);
      if (file.startsWith(RUNTIME_SRC)) {
        for (const match of text.matchAll(TIMER))
          errors.push(
            `E5 ${file}:${lineAt(text, match.index)}: ${match[0].replace(/\s*\($/, '')}; use Effect.sleep or a Schedule`,
          );
        for (const match of text.matchAll(EXTENDS_ERROR)) {
          const name = match[1];
          const allowed = /** @type {Record<string, Record<string, string>>} */ (
            ERROR_SUBCLASS_ALLOWLIST
          )[file];
          if (allowed !== undefined && Object.hasOwn(allowed, name)) {
            allowedErrorsSeen.add(`${file}#${name}`);
            continue;
          }
          errors.push(
            `E6 ${file}:${lineAt(text, match.index)}: class ${name} extends Error; use Data.TaggedError (only arch §4.2 invariant/pure-validator classes may extend Error)`,
          );
        }
      }
      if (file.startsWith(CONTRACTS_SRC)) checkContractImports(file, text, errors);
    }
  }
  for (const [file, classes] of Object.entries(ERROR_SUBCLASS_ALLOWLIST)) {
    for (const name of Object.keys(classes)) {
      if (!allowedErrorsSeen.has(`${file}#${name}`))
        errors.push(
          `E6 ${file}: allowlisted class ${name} no longer extends Error here; delete the stale entry`,
        );
    }
  }
  return errors;
};

if (isMainModule(import.meta.url)) {
  const repoRoot = resolve(
    process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '../..'),
  );
  const errors = checkEffectConventions(repoRoot);
  for (const error of errors) console.error(error);
  console.error(`effect-conventions: ${errors.length} violation(s)`);
  process.exit(errors.length > 0 ? 1 : 0);
}
