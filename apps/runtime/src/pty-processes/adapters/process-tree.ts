import { execFile } from 'node:child_process';
import process from 'node:process';
import { promisify } from 'node:util';

import { Effect } from 'effect';

// A PTY's own process is only the root of what it runs. Agents, shells, test
// runners, and dev servers start children that can leave the root's process
// group or ignore the SIGHUP a closing terminal sends, and so outlive a signal
// aimed at the root alone — re-parented to init, where no PTY row or backend
// session points at them any more. Termination therefore snapshots the whole
// tree while the root still anchors it, signals that snapshot, and finally
// SIGKILLs whatever of it is still alive.

const execFileAsync = promisify(execFile);

export interface ProcessTableRow {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  // Opaque start-time text. Paired with the pid it names exactly one process,
  // so a late signal cannot land on an unrelated process that reused the pid.
  readonly startedAt: string;
}

export interface ProcessTreeSnapshot {
  readonly ptyProcessId: number;
  readonly rootPid: number;
  // The root as it was seen, or `null` when it had already exited.
  readonly root: ProcessTableRow | null;
  // Every process descended from the root, plus every member of the root's
  // process group. Group membership catches children whose intermediate parent
  // already exited and re-parented them away from the root.
  readonly descendants: readonly ProcessTableRow[];
}

// `null` means the tree could not be inspected: an unsupported platform or a
// failing `ps`. Callers still signal the root they hold directly; only the
// descendant sweep is lost, and that loss is logged rather than failing the
// termination it would otherwise block.
export function snapshotProcessTree(input: {
  readonly ptyProcessId: number;
  readonly rootPid: number;
}): Effect.Effect<ProcessTreeSnapshot | null> {
  return readProcessTable.pipe(
    Effect.map((rows) =>
      rows === null ? null : selectProcessTree(rows, input.ptyProcessId, input.rootPid),
    ),
  );
}

// Signals the snapshotted descendants, never the root: the root is signalled
// through the backend handle that owns it, so it is not signalled twice.
export function signalProcessTreeDescendants(
  snapshot: ProcessTreeSnapshot | null,
  signal: NodeJS.Signals,
) {
  return Effect.sync(() => {
    if (!snapshot) return;
    for (const row of snapshot.descendants) signalPid(row.pid, signal);
  });
}

// The escalation. Re-reads the process table and SIGKILLs every process that
// is still the same process the snapshot saw — root included — plus anything
// that joined the root's process group after the snapshot.
//
// With `requireRootExited`, the sweep acts only on evidence that the root is
// gone. It is for callers whose kill failed without saying whether it acted:
// a dead root means the kill happened and its descendants are strays to take,
// while a live root is still a running process whose children are not ours.
//
// Reports whether the sweep SIGKILLed the snapshotted root itself — the one
// fact a caller needs to stay honest about having terminated a live process.
export function killProcessTreeSurvivors(
  snapshot: ProcessTreeSnapshot | null,
  options: { readonly requireRootExited?: boolean } = {},
): Effect.Effect<{ readonly killedRoot: boolean }> {
  return Effect.gen(function* () {
    const none = { killedRoot: false };
    if (!snapshot) return none;
    const rows = yield* readProcessTable;
    if (rows === null) return none;
    if (options.requireRootExited && isRootStillAlive(snapshot, rows)) {
      console.warn(
        `[runtime] Not sweeping PTY process tree because its root is still alive ptyProcessId=${snapshot.ptyProcessId} rootPid=${snapshot.rootPid}`,
      );
      return none;
    }
    const sweep = sweepProcessTreeSurvivors(snapshot, rows, signalPid);
    if (sweep.killedPids.length > 0) {
      console.warn(
        `[runtime] SIGKILLed PTY process tree survivors ptyProcessId=${snapshot.ptyProcessId} rootPid=${snapshot.rootPid} pids=${sweep.killedPids.join(',')}`,
      );
    }
    return { killedRoot: sweep.killedRoot };
  });
}

// SIGKILLs the survivors through `signal` and reports only what was actually
// delivered. A root that exited just before its signal (ESRCH) or refused it
// (EPERM) was not killed by this sweep, so `killedRoot` must not claim it.
export function sweepProcessTreeSurvivors(
  snapshot: ProcessTreeSnapshot,
  rows: readonly ProcessTableRow[],
  signal: (pid: number, signal: NodeJS.Signals) => boolean,
) {
  const killedPids: number[] = [];
  let killedRoot = false;
  for (const row of processTreeSurvivors(snapshot, rows)) {
    if (!signal(row.pid, 'SIGKILL')) continue;
    killedPids.push(row.pid);
    if (isSnapshotRoot(snapshot, row)) killedRoot = true;
  }
  return { killedPids, killedRoot };
}

function isRootStillAlive(snapshot: ProcessTreeSnapshot, rows: readonly ProcessTableRow[]) {
  return rows.some((row) => isSnapshotRoot(snapshot, row));
}

function isSnapshotRoot(snapshot: ProcessTreeSnapshot, row: ProcessTableRow) {
  return row.pid === snapshot.root?.pid && row.startedAt === snapshot.root.startedAt;
}

export function parseProcessTable(stdout: string): ProcessTableRow[] {
  const rows: ProcessTableRow[] = [];
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S.*?)\s*$/.exec(line);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      startedAt: match[4] ?? '',
    });
  }
  return rows;
}

export function selectProcessTree(
  rows: readonly ProcessTableRow[],
  ptyProcessId: number,
  rootPid: number,
): ProcessTreeSnapshot {
  const children = new Map<number, ProcessTableRow[]>();
  for (const row of rows) {
    const siblings = children.get(row.ppid);
    if (siblings) siblings.push(row);
    else children.set(row.ppid, [row]);
  }

  const selected = new Map<number, ProcessTableRow>();
  const queue = [rootPid];
  for (const row of rows) {
    if (row.pgid === rootPid) queue.push(row.pid);
  }
  while (queue.length > 0) {
    const pid = queue.pop() as number;
    for (const child of children.get(pid) ?? []) {
      if (selected.has(child.pid)) continue;
      selected.set(child.pid, child);
      queue.push(child.pid);
    }
    const self = rows.find((row) => row.pid === pid);
    if (self && self.pgid === rootPid) selected.set(self.pid, self);
  }
  selected.delete(rootPid);
  selected.delete(process.pid);

  return {
    ptyProcessId,
    rootPid,
    root: rows.find((row) => row.pid === rootPid) ?? null,
    descendants: [...selected.values()],
  };
}

export function processTreeSurvivors(
  snapshot: ProcessTreeSnapshot,
  rows: readonly ProcessTableRow[],
) {
  const known = new Map<number, string>();
  if (snapshot.root) known.set(snapshot.root.pid, snapshot.root.startedAt);
  for (const row of snapshot.descendants) known.set(row.pid, row.startedAt);

  // A process group id stays reserved while any member lives, so group members
  // are ours — unless the group emptied and a new process reused the root pid
  // as its own group, which shows up as a different process at the root pid.
  const currentRoot = rows.find((row) => row.pid === snapshot.rootPid);
  const groupIdReused =
    currentRoot !== undefined && currentRoot.startedAt !== snapshot.root?.startedAt;

  return rows.filter(
    (row) =>
      row.pid !== process.pid &&
      (known.get(row.pid) === row.startedAt || (!groupIdReused && row.pgid === snapshot.rootPid)),
  );
}

// Windows has no process groups or `ps`; node-pty's own kill is all there is.
const readProcessTable: Effect.Effect<ProcessTableRow[] | null> =
  process.platform === 'win32' ? Effect.succeed(null) : readPosixProcessTable();

function readPosixProcessTable() {
  return Effect.tryPromise({
    try: async () => {
      const { stdout } = await execFileAsync('ps', ['-Ao', 'pid=,ppid=,pgid=,lstart='], {
        encoding: 'utf8',
        env: { ...process.env, LC_ALL: 'C' },
        maxBuffer: 16 * 1024 * 1024,
        timeout: 5_000,
      });
      return parseProcessTable(stdout);
    },
    catch: (cause) => cause,
  }).pipe(
    Effect.catchAll((cause) =>
      Effect.sync(() => {
        console.warn(
          '[runtime] Could not read the process table; PTY descendants will not be swept',
          cause,
        );
        return null;
      }),
    ),
  );
}

// Reports whether the signal was delivered.
function signalPid(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    // Already gone (ESRCH) or not ours to signal (EPERM): either way there is
    // nothing more this sweep can do for that process.
    return false;
  }
}
