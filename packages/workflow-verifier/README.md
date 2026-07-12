# Isagi workflow verifier

Verify an already-built Isagi workflow package and write its build receipt:

```sh
isagi-workflow-verify --workflow .
```

The workflow package owns compilation through its canonical `build` script and exact `esbuild` development dependency. Run that script before verification. The verifier never builds or installs dependencies: it runs the package's `typecheck` and `test` scripts, validates the existing `dist/index.js` workflow export and command manifest in a bounded child process, and writes `dist/isagi-workflow-build.json` only after every gate passes.

Workflow packages must preserve the canonical `build` and `verify` scripts, exact SDK, verifier, and esbuild versions, and an exact `packageManager` declaration. The current versions are `@yourtechbudstudio/isagi-workflow-sdk@0.0.1`, `@yourtechbudstudio/isagi-workflow-verifier@0.0.1`, and `esbuild@0.28.0`. For the full authoring guide, use Isagi's installed `isagi-docs` skill.

## Trust boundary

A verified artifact is self-contained with respect to its statically discoverable package import graph. Workflows remain trusted Node.js code and may intentionally access runtime files, processes, network resources, and Node built-ins. Verification is lifecycle containment, not a sandbox.

The `./receipt` export contains pure manifest parsing, canonical serialization, path policy, compatibility constants, and hash primitives for consumers that need to check a receipt without executing verifier operations.
