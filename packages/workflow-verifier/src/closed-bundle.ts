import { parse } from 'acorn';
import { analyze } from 'eslint-scope';

import type { StructureDiagnostic } from './structure.js';

/**
 * Checks that a built artifact is closed: everything it executes is already inside it.
 *
 * The canonical build command passes `--log-override:unsupported-dynamic-import=error`, but nothing
 * in the receipt attests to the flags an author actually used — `requirePins` checks package
 * versions, not how the bundle was produced. So the guarantee is checked on the artifact itself.
 *
 * The check parses the module rather than scanning text. Text scanning was wrong in both
 * directions: it misses a residual `import` statement entirely, and it rejects a prompt string or a
 * comment that happens to contain `eval(`.
 *
 * Whether a *call* reaches a loader is a lexical question — `var` hoisting out of blocks,
 * default-parameter scopes, named function expressions, declaration order — and successive
 * hand-written resolvers answered it wrongly in both directions. `eslint-scope` answers it
 * properly, which is why it is a dependency: it resolves each callee to the binding actually
 * visible there, and reports which bindings came from `node:module` in the first place.
 *
 * It covers ordinary residual dependencies and deferred-load constructs, **not** adversarial
 * indirection: computed member access can still reach a loader. Workflow code is trusted,
 * in-process, and unsandboxed, and this check does not change that.
 */

const nodeModuleSpecifier = 'node:module';

/**
 * Assignment operators that can give a binding its right-hand value.
 *
 * The logical forms are conditional — `cr ||= createRequire` assigns only when `cr` is falsy — but
 * which branch a given run takes is not a question this check answers, so a right-hand side that
 * carries a loader makes the target one. That fails closed, and it matches how a plain `=` is
 * already treated. Arithmetic compound operators cannot yield a loader and are not candidates.
 */
const aliasingAssignmentOperators = new Set(['=', '||=', '&&=', '??=']);

/** Exports of `node:module` that hand back a way to load code outside the artifact. */
const moduleLoaderExports = new Set(['createRequire']);

/** Methods that load natively, read as `process.<name>(…)`. */
const processLoaderMethods = new Set(['binding', 'dlopen']);

/** The single declared exception. Bare `fs`/`path` are not exempt: by specifier alone they are
 *  indistinguishable from an unbundled package, and the scaffold and guide use the `node:` form. */
function isNodeBuiltin(specifier: string): boolean {
  return specifier.startsWith('node:');
}

interface AcornNode {
  readonly type: string;
  readonly start: number;
  readonly loc?: { readonly start: { readonly line: number; readonly column: number } };
  readonly [key: string]: unknown;
}

/** What a resolved binding refers to, when it refers to something that can load code. */
type LoaderBinding =
  | { readonly kind: 'loader'; readonly exportName: string }
  | { readonly kind: 'namespace' };

type ScopeVariable = { readonly name: string; readonly defs: readonly any[] };

export function scanDeferredExecutableDependencies(
  artifactSource: string,
): readonly StructureDiagnostic[] {
  let program: AcornNode;
  try {
    program = parse(artifactSource, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      locations: true,
      ranges: true,
    }) as unknown as AcornNode;
  } catch (cause) {
    return [unparseable(cause)];
  }

  let scopeManager;
  try {
    scopeManager = analyze(program as never, { ecmaVersion: 2024, sourceType: 'module' });
  } catch (cause) {
    return [unparseable(cause)];
  }

  const { loaders, resolvedAt } = analyzeBindings(scopeManager, program);

  const diagnostics: StructureDiagnostic[] = [];
  const report = (node: AcornNode, message: string): void => {
    diagnostics.push({
      code: 'deferred_executable_dependency',
      message: `${message} (${position(node)})`,
      at: {},
    });
  };

  walk(program, (node) => {
    switch (node.type) {
      case 'ImportDeclaration':
      case 'ExportAllDeclaration':
      case 'ExportNamedDeclaration': {
        const source = node.source as AcornNode | null | undefined;
        if (!source || typeof source.value !== 'string') return;
        // Importing a `node:` built-in is permitted, including `node:module`. Acquiring a binding is
        // not the failure; calling a loader through it is, and that is checked at the call site.
        if (isNodeBuiltin(source.value)) return;
        report(
          source,
          `dist/index.js still imports "${source.value}" at run time, so the bundle is not closed. Rebuild without --external so every executable dependency is inside the artifact`,
        );
        return;
      }
      case 'ImportExpression': {
        const source = node.source as AcornNode | undefined;
        if (source?.type === 'Literal' && typeof source.value === 'string') {
          if (isNodeBuiltin(source.value)) return;
          report(
            source,
            `dist/index.js defers loading "${source.value}" through import(), so the bundle is not closed`,
          );
          return;
        }
        report(
          node,
          'dist/index.js calls import() with a computed specifier, so the verifier cannot tell what it would load',
        );
        return;
      }
      case 'NewExpression':
      case 'CallExpression': {
        const callee = node.callee as AcornNode | undefined;
        if (!callee) return;
        const invoked = calledLoader(callee, loaders, resolvedAt);
        if (invoked) {
          report(
            callee,
            `dist/index.js calls ${invoked}, which can load code the artifact does not contain`,
          );
        }
        return;
      }
      default:
        return;
    }
  });

  return diagnostics;
}

function unparseable(cause: unknown): StructureDiagnostic {
  return {
    code: 'deferred_executable_dependency',
    message: `dist/index.js could not be analyzed as an ES module, so the verifier cannot confirm the bundle is closed: ${cause instanceof Error ? cause.message : String(cause)}`,
    at: {},
  };
}

/**
 * Which variables refer to something that can load code, and what each identifier resolves to.
 *
 * Import provenance comes straight from the scope analysis. Aliases are then propagated to a
 * fixpoint rather than in source order, so a function that uses an alias declared later in its
 * enclosing scope is treated the same as one that uses it afterwards.
 */
interface AliasCandidate {
  readonly variable: ScopeVariable;
  /** The expression whose value the binding takes. */
  readonly init: any;
  /** The binding pattern it is taken through: an identifier, or an object pattern. */
  readonly pattern: any;
  /** The identifier this candidate binds, which is how a destructured property is located. */
  readonly name: any;
}

function analyzeBindings(
  scopeManager: {
    readonly scopes: readonly {
      readonly variables: readonly ScopeVariable[];
      readonly references: readonly { readonly identifier: unknown; readonly resolved: unknown }[];
    }[];
  },
  program: AcornNode,
): {
  loaders: Map<ScopeVariable, LoaderBinding>;
  resolvedAt: Map<AcornNode, ScopeVariable | null>;
} {
  const loaders = new Map<ScopeVariable, LoaderBinding>();
  const resolvedAt = new Map<AcornNode, ScopeVariable | null>();
  const candidates: AliasCandidate[] = [];

  for (const scope of scopeManager.scopes) {
    for (const reference of scope.references) {
      resolvedAt.set(
        reference.identifier as AcornNode,
        (reference.resolved as ScopeVariable | null) ?? null,
      );
    }
    for (const variable of scope.variables) {
      for (const def of variable.defs) {
        if (def?.type === 'ImportBinding') {
          const imported = importedLoader(def);
          if (imported) loaders.set(variable, imported);
          continue;
        }
        if (def?.type === 'Variable') {
          candidates.push({
            variable,
            init: def.node?.init,
            pattern: def.node?.id,
            name: def.name,
          });
        }
      }
    }
  }

  // A plain assignment is an alias too. `let cr; cr = createRequire;` binds exactly what
  // `const cr = createRequire` binds, and reading only declarator initializers missed it.
  collectAssignmentAliases(program, resolvedAt, candidates);

  // Aliases can be written after the code that uses them, so iterate to a fixpoint. A binding that
  // is ever assigned a loader stays one: if it is later reassigned to something harmless, which of
  // the two a given call sees is not a question this check answers, and it fails closed.
  for (let changed = true; changed; ) {
    changed = false;
    for (const candidate of candidates) {
      if (loaders.has(candidate.variable)) continue;
      const binding = aliasedLoader(candidate, loaders, resolvedAt);
      if (!binding) continue;
      loaders.set(candidate.variable, binding);
      changed = true;
    }
  }

  return { loaders, resolvedAt };
}

/** Every `x = …` write, as an alias candidate resolved the same way a declaration is. */
function collectAssignmentAliases(
  program: AcornNode,
  resolvedAt: ReadonlyMap<AcornNode, ScopeVariable | null>,
  into: AliasCandidate[],
): void {
  walk(program, (node) => {
    if (node.type !== 'AssignmentExpression') return;
    if (typeof node.operator !== 'string' || !aliasingAssignmentOperators.has(node.operator))
      return;
    const left: any = node.left;
    const init = node.right;
    const add = (identifier: any): void => {
      const variable = resolvedAt.get(identifier as AcornNode);
      if (variable) into.push({ variable, init, pattern: left, name: identifier });
    };
    if (left?.type === 'Identifier') {
      add(left);
      return;
    }
    if (left?.type !== 'ObjectPattern') return;
    for (const property of left.properties ?? []) {
      if (property?.computed === true) continue;
      const bound =
        property?.value?.type === 'AssignmentPattern' ? property.value.left : property?.value;
      if (bound?.type === 'Identifier') add(bound);
    }
  });
}

/**
 * Whether an expression denotes the `node:module` namespace.
 *
 * Either a name that resolves to a namespace binding, or an awaited `import('node:module')` used
 * directly. The second has no intermediate binding at all, so resolution alone never sees it, and
 * `(await import('node:module')).createRequire(…)` is ordinary syntax rather than indirection.
 */
function isNodeModuleNamespace(
  expression: any,
  loaders: ReadonlyMap<ScopeVariable, LoaderBinding>,
  resolvedAt: ReadonlyMap<AcornNode, ScopeVariable | null>,
): boolean {
  const unwrapped = unwrapAwait(expression);
  if (!unwrapped) return false;
  if (unwrapped.type === 'ImportExpression') {
    return unwrapped.source?.type === 'Literal' && unwrapped.source.value === nodeModuleSpecifier;
  }
  if (unwrapped.type !== 'Identifier') return false;
  const resolved = resolvedAt.get(unwrapped as AcornNode);
  return resolved ? loaders.get(resolved)?.kind === 'namespace' : false;
}

/** A binding introduced by `import … from 'node:module'`, if it carries a loader. */
function importedLoader(def: any): LoaderBinding | null {
  const source = def?.parent?.source;
  if (source?.value !== nodeModuleSpecifier) return null;
  const specifier = def.node;
  if (specifier?.type === 'ImportSpecifier') {
    const name = specifier.imported?.name;
    return typeof name === 'string' && moduleLoaderExports.has(name)
      ? { kind: 'loader', exportName: name }
      : null;
  }
  // A namespace or default import carries every export, loaders included.
  return specifier?.type === 'ImportNamespaceSpecifier' ||
    specifier?.type === 'ImportDefaultSpecifier'
    ? { kind: 'namespace' }
    : null;
}

/** The ordinary static aliases authors write, resolved through the scope analysis. */
function aliasedLoader(
  candidate: AliasCandidate,
  loaders: ReadonlyMap<ScopeVariable, LoaderBinding>,
  resolvedAt: ReadonlyMap<AcornNode, ScopeVariable | null>,
): LoaderBinding | null {
  const init = unwrapAwait(candidate.init);
  if (!init) return null;

  const sourceBinding = (identifier: unknown): LoaderBinding | undefined => {
    const resolved = resolvedAt.get(identifier as AcornNode);
    return resolved ? loaders.get(resolved) : undefined;
  };

  // `const m = await import('node:module')`
  if (init.type === 'ImportExpression' && init.source?.value === nodeModuleSpecifier) {
    return patternBinding(candidate, { kind: 'namespace' });
  }
  // `const cr = createRequire` / `const alias = ns` / `const { createRequire: cr } = ns`
  if (init.type === 'Identifier') {
    const binding = sourceBinding(init);
    return binding ? patternBinding(candidate, binding) : null;
  }
  // `const cr = ns.createRequire`, and the same off an awaited import.
  if (init.type === 'MemberExpression' && init.computed !== true) {
    if (!isNodeModuleNamespace(init.object, loaders, resolvedAt)) return null;
    const name = init.property?.type === 'Identifier' ? init.property.name : undefined;
    return typeof name === 'string' && moduleLoaderExports.has(name)
      ? { kind: 'loader', exportName: name }
      : null;
  }
  return null;
}

/** Applies a source binding to whichever name of the declaration this variable is. */
function patternBinding(candidate: AliasCandidate, source: LoaderBinding): LoaderBinding | null {
  const pattern = candidate.pattern;
  if (pattern?.type === 'Identifier') return source;
  if (source.kind !== 'namespace' || pattern?.type !== 'ObjectPattern') return null;
  for (const property of pattern.properties ?? []) {
    if (property?.computed === true) continue;
    // `const { createRequire: cr = fallback } = ns` binds `cr` inside an assignment pattern.
    const bound =
      property?.value?.type === 'AssignmentPattern' ? property.value.left : property?.value;
    if (bound !== candidate.name) continue;
    const key = property.key?.type === 'Identifier' ? property.key.name : undefined;
    if (typeof key === 'string' && moduleLoaderExports.has(key)) {
      return { kind: 'loader', exportName: key };
    }
  }
  return null;
}

/**
 * The value an initializer ultimately takes.
 *
 * `await import(…)` yields the module; `a = b = createRequire` gives `a` the same value as `b`,
 * because assignment is right-associative and evaluates to its right-hand side; a logical
 * assignment is followed the same way and for the same fail-closed reason; a sequence evaluates to
 * its last expression. Each is ordinary non-computed syntax, so each is followed.
 */
function unwrapAwait(value: any): any {
  let current = value;
  for (;;) {
    if (current?.type === 'AwaitExpression') {
      current = current.argument;
      continue;
    }
    if (
      current?.type === 'AssignmentExpression' &&
      aliasingAssignmentOperators.has(current.operator)
    ) {
      current = current.right;
      continue;
    }
    if (current?.type === 'SequenceExpression' && Array.isArray(current.expressions)) {
      const last = current.expressions.at(-1);
      if (last) {
        current = last;
        continue;
      }
    }
    return current;
  }
}

/**
 * The loader a call invokes, named for the diagnostic, or null.
 *
 * A callee that resolves to a binding is that binding — an author's own `process`, a parameter
 * named `createRequire`, a named function expression called `process`. Only an unresolved name is
 * the global of that name.
 */
function calledLoader(
  callee: AcornNode,
  loaders: ReadonlyMap<ScopeVariable, LoaderBinding>,
  resolvedAt: ReadonlyMap<AcornNode, ScopeVariable | null>,
): string | null {
  if (callee.type === 'Identifier') {
    const name = callee.name;
    if (typeof name !== 'string') return null;
    const resolved = resolvedAt.get(callee);
    const binding = resolved ? loaders.get(resolved) : undefined;
    if (binding?.kind === 'loader') {
      return binding.exportName === name
        ? `"${name}" imported from ${nodeModuleSpecifier}`
        : `"${name}" (${binding.exportName} from ${nodeModuleSpecifier})`;
    }
    if (resolved) return null;
    if (name === 'eval') return 'the global "eval"';
    if (name === 'Function') return 'the Function constructor';
    return null;
  }

  if (callee.type !== 'MemberExpression' || callee.computed === true) return null;
  const object = callee.object as AcornNode | undefined;
  const property = callee.property as AcornNode | undefined;
  if (property?.type !== 'Identifier' || typeof property.name !== 'string') return null;
  const propertyName = property.name;

  if (isNodeModuleNamespace(object, loaders, resolvedAt) && moduleLoaderExports.has(propertyName)) {
    const receiver = object?.type === 'Identifier' ? String(object.name) : nodeModuleSpecifier;
    return `"${receiver}.${propertyName}" from ${nodeModuleSpecifier}`;
  }

  if (object?.type !== 'Identifier' || typeof object.name !== 'string') return null;
  // Only an unresolved name is the global of that name.
  if (resolvedAt.get(object)) return null;
  if (object.name === 'process' && processLoaderMethods.has(propertyName)) {
    return `"process.${propertyName}"`;
  }
  return null;
}

function position(node: AcornNode): string {
  return node.loc
    ? `line ${node.loc.start.line}, column ${node.loc.start.column}`
    : `offset ${node.start}`;
}

/**
 * A generic AST walk. Strings and comments are not nodes, which is exactly why the parsed check
 * accepts a prompt containing `eval(` that a text scan would reject.
 */
function walk(node: AcornNode, visit: (node: AcornNode) => void): void {
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'type') continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const entry of value) if (isNode(entry)) walk(entry, visit);
    } else if (isNode(value)) {
      walk(value, visit);
    }
  }
}

function isNode(value: unknown): value is AcornNode {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string'
  );
}
