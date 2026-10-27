# Workflow package

A workflow is a verified TypeScript package. Authoring and verification never launch a run.

## Start

For a new workflow, copy the bundled [minimal-workflow scaffold](minimal-workflow/) and read its [definition](minimal-workflow/src/index.ts), [tests](minimal-workflow/tests/workflow.test.ts), [package](minimal-workflow/package.json) and [TypeScript settings](minimal-workflow/tsconfig.json). For an existing workflow, keep its intended behavior while adapting it to the package contract.

- Pins: `@yourtechbudstudio/isagi-workflow-sdk@{{SDK_VERSION}}` in dependencies; `@yourtechbudstudio/isagi-workflow-verifier@{{VERIFIER_VERSION}}` and `esbuild@{{BUILDER_VERSION}}` in devDependencies. Install with the target repository's conventions and keep the scaffold's `build` and `verify` scripts.
- Signatures: the installed SDK is the authority. Start at `node_modules/@yourtechbudstudio/isagi-workflow-sdk/dist/index.d.ts` and follow its exports (`graph`, `nodes`, `state`, `operations`, `launch`, `checkpoints`). Import public symbols from the package root.
- Shape: default-export `defineWorkflow(...)` from `src/index.ts`, with relative `.js` imports under NodeNext.
- Bundle: one Node ESM file with statically resolvable dependencies. Native addons, deferred module loading, code splitting, emitted side assets and symlinked sources are outside the contract. Workflows are trusted Node code; verification is not a sandbox.

## Location and discovery

The package directory name is the workflow key people launch. Discovery sources, from lowest to highest priority:

1. `{{DATA_ROOT}}/workflows/<key>/` (global)
2. each `workflows.additionalDirectories` entry in the global config, in listed order
3. `<project root>/.isagi/workflows/<key>/` (project)

The highest-priority package owns a key even when it is broken; there is no fallback to a lower copy. An additional directory is a collection root holding `<key>/` packages, configured like this (rules in the [schema](config-global.schema.ts); restart required):

```yaml
workflows:
  additionalDirectories:
    - ~/isagi-workflows
```

Packages are validated when workflows are listed and again before each run starts, never at startup.

To reuse a graph from another package, export it from that package (for example `"exports": { "./graph": "./src/graph.ts" }`), depend on it locally (`link:`), import it, and validate its output in `onResult`. Graph keys must be unique across the whole composition.

## Verify

Keep tests hermetic with stubbed capabilities and exercise the routes that matter: success, failure and interruption, exhausted budgets, human escalation, and child output mapping. The scaffold shows direct graph tests without a live runtime.

Run the package's `typecheck`, `test`, `build`, then `verify`. Verification checks the existing build, package compatibility, declared structure and loadability; it does not compile, run tests or prove routes terminate. Any source or build change invalidates it, so rebuild and reverify. Report which commands passed and which failed or were skipped; the package is ready only when all pass.
