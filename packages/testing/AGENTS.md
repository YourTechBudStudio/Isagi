# Testing helpers

## What this is

`@isagi/testing` is the private, test-only package every Effect test in the runtime, desktop and CLI uses to run an Effect and to prove nothing leaked. It is a devDependency only and is never imported by production code. The web app uses its own `lib/state/testing.ts` instead, because reactivity timers run on real timers that TestClock cannot drive.

## What it exports

- `runScoped(effect)`: live clock plus a scope closed before the promise settles. The default runner and the mechanical replacement for `Effect.runPromise` in tests.
- `runWithTestClock(effect)`: TestClock plus TestConsole plus a scope. Use it only when the test advances time with `TestClock.adjust`; an IO test with a real timeout would wait forever under it.
- Both reject with the squashed failure or defect, so `assert.rejects(run(effect), SomeTaggedError)` works.
- `makeLogCapture()`: `{ lines, layer }`; provide `layer` and assert on `lines` (`level`, `message`, `annotations`, `cause`) instead of mocking `console`.
- `makeFiberProbe()`: `{ counts, layer }`; provide `layer` at the root of the layer under test, close its scope, then assert `counts.active === 0`.
- `expectNoNewHandles(effect)`: dies if `effect` leaves new Node handles (timers, sockets, child processes) behind.
- `expectNoProcessMatching(marker, { withinMs? })`: dies if an OS process whose command line contains `marker` is still running after `withinMs` (default 2000). Put a unique marker in the command a test launches (node-pty children are not Node handles).

## Rules

- Keep it small and dependency-free apart from `effect`: helpers that several packages' tests need, nothing product-specific.
- Leak probes wait with real timers, never `Effect.sleep`, so they behave the same under both runners.
- Exports TypeScript source, like `@isagi/contracts`.
