# Isagi workflow verifier

Verify an already-built Isagi workflow package and write its build receipt:

```sh
isagi-workflow-verify --workflow .
```

The verifier has one job: raise the probability that the Isagi runtime loads the workflow build without errors. It checks ahead of time exactly what the runtime checks at load time — exact SDK and verifier pins, an exact `packageManager` declaration, a single matching lockfile, symlink-free sources, and a `dist/index.js` bundle that default-exports a loadable workflow definition with a valid `command()` manifest (validated in a bounded child process). When every gate passes it fingerprints the sources and the artifact into `dist/isagi-workflow-build.json`; the runtime re-checks that receipt and refuses to run a workflow whose source or artifact no longer matches it.

The workflow package owns compilation and quality. Run the canonical `build` script before verification, and run your own `typecheck` and `test` scripts before that: the verifier never compiles, installs dependencies, or runs package scripts, and it does not gate on tests. The current versions are `@yourtechbudstudio/isagi-workflow-sdk@0.0.1`, `@yourtechbudstudio/isagi-workflow-verifier@0.0.1`, and `esbuild@0.28.0`. For the full authoring guide, use Isagi's installed `isagi-docs` skill.

## Trust boundary

A verified artifact is self-contained with respect to its statically discoverable package import graph. Workflows remain trusted Node.js code and may intentionally access runtime files, processes, network resources, and Node built-ins. Verification is lifecycle containment, not a sandbox.

The `./receipt` export contains pure manifest parsing, canonical serialization, path policy, compatibility constants, and hash primitives for consumers that need to check a receipt without executing verifier operations.
