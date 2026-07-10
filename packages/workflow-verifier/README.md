# Isagi workflow verifier

Build and verify an Isagi workflow package with one controlled command:

```sh
isagi-workflow-verify --workflow .
```

The verifier runs the package's `typecheck` and `test` scripts, creates a standalone Node.js ESM
bundle, validates its workflow export and command manifest in a bounded child process, and replaces
`dist` only after every gate passes. It never installs dependencies.

`build` and `verify` scripts should both run the command above. Workflow packages must use exact SDK
and verifier versions and an exact `packageManager` declaration.

## Trust boundary

A verified artifact is self-contained with respect to its statically discoverable package import
graph. Workflows remain trusted Node.js code and may intentionally access runtime files, processes,
network resources, and Node built-ins. Verification is lifecycle containment, not a sandbox.

The `./receipt` export contains pure manifest parsing, canonical serialization, path policy, and hash
primitives for consumers that need to check a receipt without executing verifier operations.
