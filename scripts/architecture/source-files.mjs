// Shared source scanner for the architecture checks. It has no dependencies on purpose: TypeScript 7 exposes no
// JS compiler API, so checks work on comment-stripped source text instead of an AST.
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE = /\.(ts|tsx|mts|mjs)$/;
const DECLARATION = /\.d\.(ts|mts)$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-electron', '.generated', 'coverage']);

/**
 * Every TypeScript/ESM source file under `root`, sorted, skipping build output and declaration files.
 * @param {string} root absolute directory
 * @returns {string[]} absolute file paths
 */
export const listSources = (root) => {
  /** @type {string[]} */
  const out = [];
  /** @param {string} dir */
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (SOURCE.test(entry) && !DECLARATION.test(entry)) out.push(path);
    }
  };
  walk(root);
  return out.sort();
};

/**
 * Test-only code: `*.test.*`/`*.spec.*`, `test-support.ts`/`<name>-test-support.ts`, a module's `testing.ts` (the
 * test-only surface other modules' tests import, runtime-modules §4), and anything under a `tests/` dir.
 * @param {string} relPath repo-relative, `/`-separated path (relative so the repo's own location never matters)
 */
export const isTestFile = (relPath) =>
  /\.(test|spec)\.(ts|tsx|mts|mjs)$/.test(relPath) ||
  /(^|\/)([a-z-]+-)?test-support\.ts$/.test(relPath) ||
  /(^|\/)testing\.ts$/.test(relPath) ||
  /(^|\/)tests\//.test(relPath);

/** @param {string} root @param {string} path */
export const rel = (root, path) => relative(root, path).split(sep).join('/');

const WORD = /[A-Za-z0-9_$]/;
// After these keywords a `/` starts a regular expression, not a division.
const EXPRESSION_KEYWORDS = new Set([
  'await',
  'case',
  'delete',
  'do',
  'else',
  'in',
  'instanceof',
  'new',
  'of',
  'return',
  'throw',
  'typeof',
  'void',
  'yield',
]);

/**
 * Replaces comments with spaces and keeps everything else (string literals hold import specifiers), so offsets and
 * line numbers are unchanged. A small lexer rather than a regex: a regex cannot tell `'src/**' + '/*.ts'` or
 * `'http://x'` from a comment. It tracks strings, template literals (with nested `${}`), and regex literals (by the
 * usual previous-token rule). It is a heuristic for formatted TS/ESM, not a parser: JSX text containing `'` or `//`
 * can still be misread for the rest of that line.
 * @param {string} text
 */
export const stripComments = (text) => {
  const n = text.length;
  /** @type {string[]} */
  const out = [];
  // Previous significant token: '' (start), 'value' (identifier/literal/closing token), 'keyword', or a punctuator.
  let previous = '';
  // One counter per open template `${`: how many `{` are open inside that expression.
  /** @type {number[]} */
  const templates = [];
  let i = 0;

  /** @param {number} from @param {number} to */
  const blank = (from, to) => out.push(text.slice(from, to).replace(/[^\n]/g, ' '));
  /** Consumes template text from `from` up to and including the closing backtick or the next `${`. @param {number} from */
  const templateText = (from) => {
    let j = from;
    while (j < n) {
      const c = text[j];
      if (c === '\\') j += 2;
      else if (c === '`') return { end: j + 1, opensExpression: false };
      else if (c === '$' && text[j + 1] === '{') return { end: j + 2, opensExpression: true };
      else j += 1;
    }
    return { end: n, opensExpression: false };
  };
  /** @param {number} from */
  const continueTemplate = (from) => {
    const { end, opensExpression } = templateText(from);
    out.push(text.slice(i, end));
    i = end;
    if (opensExpression) {
      templates.push(0);
      previous = '(';
    } else previous = 'value';
  };
  /** End of a regex literal starting at `i`, or -1 when the line ends first (then `/` was a division). */
  const regexEnd = () => {
    let j = i + 1;
    let inClass = false;
    while (j < n) {
      const c = text[j];
      if (c === '\n') return -1;
      if (c === '\\') j += 2;
      else {
        if (inClass) inClass = c !== ']';
        else if (c === '[') inClass = true;
        else if (c === '/') {
          j += 1;
          while (j < n && /[a-z]/.test(text[j])) j += 1;
          return j;
        }
        j += 1;
      }
    }
    return -1;
  };

  while (i < n) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '/' && next === '/') {
      const end = text.indexOf('\n', i);
      blank(i, end === -1 ? n : end);
      i = end === -1 ? n : end;
    } else if (c === '/' && next === '*') {
      const close = text.indexOf('*/', i + 2);
      const end = close === -1 ? n : close + 2;
      blank(i, end);
      i = end;
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      const end = Math.min(n, text[j] === c ? j + 1 : j);
      out.push(text.slice(i, end));
      i = end;
      previous = 'value';
    } else if (c === '`') {
      continueTemplate(i + 1);
    } else if (c === '}' && templates.length > 0 && templates[templates.length - 1] === 0) {
      templates.pop();
      continueTemplate(i + 1);
    } else if (c === '/' && previous !== 'value' && previous !== ')' && previous !== ']') {
      const end = regexEnd();
      out.push(end === -1 ? c : text.slice(i, end));
      i = end === -1 ? i + 1 : end;
      previous = end === -1 ? c : 'value';
    } else if (WORD.test(c)) {
      let j = i + 1;
      while (j < n && WORD.test(text[j])) j += 1;
      const word = text.slice(i, j);
      out.push(word);
      i = j;
      previous = EXPRESSION_KEYWORDS.has(word) ? 'keyword' : 'value';
    } else {
      if (templates.length > 0 && c === '{') templates[templates.length - 1] += 1;
      if (templates.length > 0 && c === '}') templates[templates.length - 1] -= 1;
      out.push(c);
      i += 1;
      if (!/\s/.test(c)) previous = c;
    }
  }
  return out.join('');
};

/** 1-based line of `index` in `text`. @param {string} text @param {number} index */
const lineAt = (text, index) => text.slice(0, index).split('\n').length;

const IMPORT =
  /(?<=^|[\s;])(?:import|export)\s+(?:type\s+)?(?:[\w$*{}\s,]+?\s+from\s+)?['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

/**
 * Static and literal dynamic import/re-export specifiers, with 1-based lines and whether the statement is type-only.
 * @param {string} path
 * @returns {{ specifier: string, line: number, typeOnly: boolean }[]}
 */
export const importsOf = (path) => {
  const text = stripComments(readFileSync(path, 'utf8'));
  return [...text.matchAll(IMPORT)].map((match) => ({
    specifier: match[1] ?? match[2],
    line: lineAt(text, match.index),
    typeOnly: /^(import|export)\s+type\s/.test(match[0]),
  }));
};

/**
 * Resolves a relative `./x.js` specifier to the on-disk .ts/.tsx file (NodeNext style); null for package specifiers.
 * @param {string} from importing file @param {string} specifier
 */
export const resolveRelative = (from, specifier) => {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(dirname(from), specifier);
  const candidates = [
    base,
    base.replace(/\.js$/, '.ts'),
    base.replace(/\.js$/, '.tsx'),
    base.replace(/\.mjs$/, '.mts'),
    `${base}.ts`,
    join(base, 'index.ts'),
  ];
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not this candidate; try the next one.
    }
  }
  return base;
};

/**
 * Matches of `regex` (must be global) in the comment-stripped file, with 1-based lines.
 * @param {string} path @param {RegExp} regex
 * @returns {{ text: string, line: number }[]}
 */
export const matchesOf = (path, regex) => {
  const text = stripComments(readFileSync(path, 'utf8'));
  return [...text.matchAll(regex)].map((match) => ({
    text: match[0],
    line: lineAt(text, match.index),
  }));
};

/** True when the module at `importMetaUrl` is the script node was asked to run. @param {string} importMetaUrl */
export const isMainModule = (importMetaUrl) =>
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(importMetaUrl));
