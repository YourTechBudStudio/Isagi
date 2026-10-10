// Preloaded into the runtime test process with `--import`. When the exit watchdog
// (`scripts/test-exit-watchdog.mjs`) sends SIGUSR2, this prints what keeps the event
// loop alive, so a hung suite names its leak instead of only timing out.
import process from 'node:process';

/* eslint-disable no-underscore-dangle -- Node exposes live handles and timer details only through these private fields. */

process.on('SIGUSR2', () => {
  const handles = process._getActiveHandles?.() ?? [];
  const described = handles.map((handle) => {
    const kind = handle?.constructor?.name ?? typeof handle;
    if (kind === 'ChildProcess')
      return `ChildProcess pid=${handle.pid} ${handle.spawnargs?.join(' ')}`;
    if (kind === 'Socket' || kind === 'Server') {
      return `${kind} ${handle.remoteAddress ?? ''}:${handle.remotePort ?? handle.address?.()?.port ?? ''}`;
    }
    if (kind === 'Timeout') {
      return `Timeout ${handle._idleTimeout}ms ${String(handle._onTimeout).slice(0, 120).replace(/\s+/g, ' ')}`;
    }
    return kind;
  });
  process.stderr.write(
    `dump-handles: ${JSON.stringify(process.getActiveResourcesInfo())}\n  ${described.join('\n  ')}\n`,
  );
});
