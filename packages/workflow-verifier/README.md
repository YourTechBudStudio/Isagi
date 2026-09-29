# Isagi workflow verifier

Verify an already-built Isagi workflow package and write its build receipt:

```sh
isagi-workflow-verify --workflow .
```

The verifier has one job: raise the probability that the Isagi runtime loads the workflow build without errors. It checks ahead of time what the runtime checks at load time — exact SDK and verifier pins, symlink-free sources, a `dist/index.js` bundle that default-exports a loadable workflow definition, and a structurally valid graph — and also that `command()` returns a valid manifest, importing the bundle in a bounded child process. When every gate passes it fingerprints the sources, the artifact, and the declared structure into `dist/isagi-workflow-build.json`; the runtime re-checks that receipt and refuses to run a workflow whose source or artifact no longer matches it. How the package installs dependencies is deliberately outside this contract.

The workflow package owns compilation and quality. Run the canonical `build` script before verification, and run your own `typecheck` and `test` scripts before that: the verifier never compiles, installs dependencies, or runs package scripts, and it does not gate on tests. The current versions are `@yourtechbudstudio/isagi-workflow-sdk@0.1.1`, `@yourtechbudstudio/isagi-workflow-verifier@0.1.1`, and `esbuild@0.28.0`. For the full authoring guide, use Isagi's installed `isagi-docs` skill.

## Trust boundary

The verifier imports a copy of `dist/index.js` on its own, from an empty temporary directory, in a child process with a time limit and an output limit, so a bundle whose top-level imports still name a package it did not inline fails verification. It checks that the workflow loads and declares a valid shape; it does not inspect what the workflow code does. Workflows remain trusted Node.js code and may intentionally access runtime files, processes, network resources, and Node built-ins. Verification is lifecycle containment, not a sandbox.

The `./receipt` export contains pure manifest parsing, canonical serialization, path policy, compatibility constants, and hash primitives for consumers that need to check a receipt without executing verifier operations. The `./structure` export contains the single structural inspection algorithm — descriptor extraction, validation diagnostics, canonicalization, and hashing — which the Isagi runtime re-runs against the imported artifact so a receipt cannot describe a different graph than the one that executes. It also exports the `command()` manifest check the verifier applies.
