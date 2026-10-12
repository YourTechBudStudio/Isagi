# Runtime

## Modules

- `src/` is vertical modules over a domain-free `platform/`, with `app/` as the only composition root (wiring, no capability behavior). `platform/` names no product concept and imports no module.
- Other modules use only a module's `index.ts` and `tables.ts` (tests may also use its `testing.ts`). Dependencies point down; a lower module learns about a higher one through an `InternalEvent` or a port wired in `app/`, never an import.
- Each table lives in its owning module's `tables.ts`, and only that module writes it. Generate migrations only with `pnpm -C apps/runtime db:generate`; never edit `drizzle/` by hand.

## Sessions and PTY processes

- Durable sessions (`agent_sessions`, `terminal_sessions`) own continuity; a PTY process is a disposable incarnation, replaced freely (ADRs 0005, 0006).
- The PTY layer (`pty-processes`) is generic: it never imports or branches on harness semantics. Harness adapters build its launch envelope.
- tmux is a transport only. Restoration comes from durable sessions plus the latest observed harness session ids, never from a backend's own session persistence.
- A new table that owns a PTY process must declare a foreign key to `pty_processes.id`, or the PTY GC kills its process.

## Effect

- A sequence that must finish once started (persist a row then publish its event, kill a process then record the outcome) is `Effect.uninterruptible` or runs on a service-owned fiber, so a client disconnect cannot cut it in half.
- Periodic work uses `runPeriodically` (`platform/fibers`); never `setTimeout`/`setInterval` or `Effect.forkDetach`.
- In a `forever`/`repeat` loop, never `catchCause` around an effect that can interrupt itself (such as `Queue.take` on a shut-down queue): the loop spins. Re-raise when `Cause.hasInterruptsOnly`.
- Logs use a static message with ids as annotations. Anything that may echo user data is logged through `describeOperationalCause` (`platform/diagnostics`), never raw.
- Tests use `TestClock` only when they drive time (an IO test with a real timeout hangs under it). Fakes record calls lazily, inside `Effect.sync`/`Effect.suspend`.
