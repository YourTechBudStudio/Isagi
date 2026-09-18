# Isagi workflow verifier

Verify an already-built Isagi workflow package and write its build receipt:

```sh
isagi-workflow-verify --workflow .
```

The verifier has one job: raise the probability that the Isagi runtime loads the workflow build without errors. It checks ahead of time exactly what the runtime checks at load time — exact SDK and verifier pins, symlink-free sources, a `dist/index.js` bundle that default-exports a loadable workflow definition with a valid `command()` manifest (validated in a bounded child process), a structurally valid graph, and a closed bundle that carries every executable dependency it needs. When every gate passes it writes the declared structure to `dist/isagi-workflow-structure.json` and then fingerprints the sources, the artifact, and that structure into `dist/isagi-workflow-build.json`; the runtime re-checks that receipt and refuses to run a workflow whose source or artifact no longer matches it. How the package installs dependencies is deliberately outside this contract.

The workflow package owns compilation and quality. Run the canonical `build` script before verification, and run your own `typecheck` and `test` scripts before that: the verifier never compiles, installs dependencies, or runs package scripts, and it does not gate on tests. The current versions are `@yourtechbudstudio/isagi-workflow-sdk@0.2.0`, `@yourtechbudstudio/isagi-workflow-verifier@0.2.0`, and `esbuild@0.28.0`. For the full authoring guide, use Isagi's installed `isagi-docs` skill.

## Trust boundary

A verified artifact is self-contained with respect to its statically discoverable package import graph: the verifier parses `dist/index.js` and rejects residual external imports, deferred `import()` loads, and ordinary deferred-load constructs. Loader calls are resolved against the binding actually visible at the call site, so an alias of `createRequire` is caught however it was spelled or ordered, while a parameter, local, or named function expression that merely shares a name with a global is not. It does not resist adversarial indirection, and it does not try to. Workflows remain trusted Node.js code and may intentionally access runtime files, processes, network resources, and Node built-ins. Verification is lifecycle containment, not a sandbox.

The `./receipt` export contains pure manifest parsing, canonical serialization, path policy, compatibility constants, and hash primitives for consumers that need to check a receipt without executing verifier operations. The `./structure` export contains the single structural inspection algorithm — descriptor extraction, validation diagnostics, canonicalization, hashing, and the capability report — which the Isagi runtime re-runs against the imported artifact so a receipt cannot describe a different graph than the one that executes.
