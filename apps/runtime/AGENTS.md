# Runtime

- Other modules use only a module's `index.ts` and `tables.ts` (tests may also use its `testing.ts`). Only the owning module writes its tables.
- The PTY layer (`pty-processes`) is generic: it never imports or branches on harness semantics. Harness adapters build its launch envelope.
- A new table that owns a PTY process must declare a foreign key to `pty_processes.id`, or the PTY GC kills its process.
