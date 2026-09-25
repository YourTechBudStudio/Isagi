/**
 * `checkpoints export` against a fake runtime and real temporary directories.
 *
 * The fake answers each route by endpoint id. Its worktree route stands in for the runtime's
 * detached creation by making the folder with a `.git` file (and any baseline files a test asks
 * for), so every step after `prepare_baseline` runs against a real filesystem.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, test } from 'node:test';

import type { WorkflowCheckpointBase, WorkflowCheckpointInventoryEntry } from '@isagi/contracts';
import { RuntimeApiError, RuntimeDecodeError, RuntimeTransportError } from '@isagi/runtime-client';

import {
  fail,
  fakeRuntime,
  onlyJsonDocument,
  runIsagi,
  type Route,
} from '../testing/cli-harness.js';
import type { ExportResult } from './result.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    chmodTree(root);
    rmSync(root, { recursive: true, force: true });
  }
});

const gitBase = {
  kind: 'git',
  repositoryId: 3,
  commitSha: 'a'.repeat(40),
} as const satisfies WorkflowCheckpointBase;
const noneBase = {
  kind: 'none',
  reason: 'folder_project',
} as const satisfies WorkflowCheckpointBase;

interface Scenario {
  readonly base?: WorkflowCheckpointBase;
  /** Files by path; `content` answers the content route unless `serve` overrides it. */
  readonly files?: Readonly<Record<string, string | { content: string; executable?: boolean }>>;
  readonly absences?: readonly string[];
  readonly extraEntries?: readonly WorkflowCheckpointInventoryEntry[];
  /** Files the fake runtime's worktree holds before the inventory is applied. */
  readonly baseline?: (root: string) => void;
  readonly serve?: (path: string, bytes: Buffer) => unknown;
  readonly post?: Route;
  readonly sourcePath?: string | null;
  readonly projects?: readonly unknown[];
  readonly counts?: Record<string, number>;
}

function bytesResponse(bytes: Buffer) {
  return new Response(new Uint8Array(bytes));
}

function sha256(bytes: Buffer) {
  return createHash('sha256').update(bytes).digest('hex');
}

function scenario(options: Scenario = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'isagi-cli-export-')));
  roots.push(root);
  const source = join(root, 'source');
  mkdirSync(source);
  const base = options.base ?? noneBase;

  const bytesByFileId = new Map<string, { path: string; bytes: Buffer }>();
  const entries: WorkflowCheckpointInventoryEntry[] = [];
  for (const [path, spec] of Object.entries(options.files ?? {})) {
    const { content, executable = false } = typeof spec === 'string' ? { content: spec } : spec;
    const bytes = Buffer.from(content);
    const fileId = `wcf_${bytesByFileId.size + 1}`;
    bytesByFileId.set(fileId, { path, bytes });
    entries.push({
      kind: 'file',
      path,
      fileId,
      sha256: sha256(bytes),
      sizeBytes: bytes.length,
      executable,
    });
  }
  for (const path of options.absences ?? []) entries.push({ kind: 'absent', path });
  entries.push(...(options.extraEntries ?? []));

  const counts = options.counts ?? {
    scopes: 0,
    files: bytesByFileId.size,
    absences: options.absences?.length ?? 0,
    warnings: 0,
  };
  const defaultPost: Route = (params, body) => {
    const { destinationPath } = body as { destinationPath: string };
    mkdirSync(destinationPath, { recursive: true });
    writeFileSync(join(destinationPath, '.git'), 'gitdir: elsewhere\n');
    options.baseline?.(destinationPath);
    return {
      ...(params as object),
      destinationPath,
      base,
      worktreeId: 9,
    };
  };
  const runtime = fakeRuntime(
    {
      'workflows.getRun': () => ({
        run: {
          destination: {
            worktreePath: options.sourcePath === undefined ? source : options.sourcePath,
          },
        },
      }),
      'workspace.get': () => ({
        projects: options.projects ?? [
          {
            id: 3,
            rootPath: source,
            status: 'present',
            worktrees: [{ id: 5, path: source, activeSurfaceId: 1 }],
          },
        ],
      }),
      'workflows.getCheckpoint': () => ({ checkpoint: { base, counts } }),
      'workflows.listCheckpointInventory': (params) => ({
        checkpointId: (params as { checkpointId: string }).checkpointId,
        entries,
        nextCursor: null,
      }),
      'workflows.createCheckpointWorktree': options.post ?? defaultPost,
    },
    {
      'workflows.getCheckpointFileContent': (params) => {
        const file = bytesByFileId.get(String(params.fileId))!;
        return options.serve ? options.serve(file.path, file.bytes) : bytesResponse(file.bytes);
      },
    },
  );
  return { root, source, runtime, destination: join(root, 'out') };
}

async function exportTo(
  setup: ReturnType<typeof scenario>,
  output = setup.destination,
  cwd = setup.root,
) {
  const run = await runIsagi(
    ['checkpoints', 'export', 'wcp_1', '--run', '42', '--output', output, '--json'],
    { runtime: setup.runtime, cwd },
  );
  const result = onlyJsonDocument(run.stdout) as ExportResult;
  assert.equal(run.code, result.status === 'complete' ? 0 : 1, run.stderr);
  if (result.status !== 'complete') {
    assert.ok(result.failure, 'a result that is not complete names its failure');
  } else {
    assert.equal(result.failure, null);
  }
  return { result, run, endpoints: setup.runtime.calls.map((call) => call.endpointId) };
}

function tree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (directory: string, prefix: string) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const key = prefix ? `${prefix}/${name}` : name;
      const stats = lstatSync(path);
      if (stats.isDirectory()) {
        out[`${key}/`] = '';
        walk(path, key);
      } else {
        out[key] = stats.isSymbolicLink() ? '<symlink>' : readFileSync(path, 'utf8');
      }
    }
  };
  walk(root, '');
  return out;
}

function chmodTree(root: string) {
  try {
    chmodSync(root, 0o755);
    for (const name of readdirSync(root)) {
      const path = join(root, name);
      if (lstatSync(path).isDirectory()) chmodTree(path);
    }
  } catch {
    // Best effort, so cleanup can remove what a permission test locked.
  }
}

function tempFilesUnder(root: string): string[] {
  return Object.keys(tree(root)).filter((path) => path.includes('.isagi-export-'));
}

// ---------------------------------------------------------------------------
// Success
// ---------------------------------------------------------------------------

test('a directory-only export writes every file with its mode and reports complete', async () => {
  const setup = scenario({
    files: { 'a.txt': 'a', 'bin/run.sh': { content: '#!/bin/sh\n', executable: true } },
  });
  const { result, run, endpoints } = await exportTo(setup);
  assert.equal(result.status, 'complete');
  assert.equal(result.destinationPath, setup.destination);
  assert.equal(result.worktreeId, null);
  assert.deepEqual(result.base, noneBase);
  assert.deepEqual(result.applied, { files: 2, absences: 0 });
  assert.deepEqual(result.limitations, [
    'no_baseline_captured_files_only',
    'dependencies_not_captured',
  ]);
  assert.deepEqual(tree(setup.destination), {
    'a.txt': 'a',
    'bin/': '',
    'bin/run.sh': '#!/bin/sh\n',
  });
  assert.equal(lstatSync(join(setup.destination, 'bin/run.sh')).mode & 0o777, 0o755);
  assert.equal(lstatSync(join(setup.destination, 'a.txt')).mode & 0o777, 0o644);
  assert.ok(
    !endpoints.includes('workflows.createCheckpointWorktree'),
    'no worktree for a none base',
  );
  assert.ok(
    !endpoints.includes('workflows.listCheckpointManifest'),
    'export never reads the manifest',
  );
  for (const stage of [
    'resolve_destination',
    'read_checkpoint',
    'validate_inventory',
    'prepare_baseline',
    'apply_absences',
    'write_files',
  ]) {
    assert.match(run.stderr, new RegExp(stage), 'one progress line per stage on stderr');
  }
});

test('a Git export applies absences, prunes emptied parents (R5) and overwrites baseline files', async () => {
  const setup = scenario({
    base: gitBase,
    baseline: (root) => {
      mkdirSync(join(root, 'gone'), { recursive: true });
      writeFileSync(join(root, 'gone/only.txt'), 'x');
      mkdirSync(join(root, 'kept'), { recursive: true });
      writeFileSync(join(root, 'kept/one.txt'), 'x');
      writeFileSync(join(root, 'kept/two.txt'), 'x');
      writeFileSync(join(root, 'changed.txt'), 'old');
      mkdirSync(join(root, 'dir-to-file'));
      writeFileSync(join(root, 'dir-to-file/inner'), 'x');
    },
    files: { 'changed.txt': 'new', 'dir-to-file': 'now a file' },
    absences: ['gone/only.txt', 'kept/one.txt', 'never/there.txt', 'dir-to-file/inner'],
  });
  const { result } = await exportTo(setup);
  assert.equal(result.status, 'complete');
  assert.equal(result.worktreeId, 9);
  assert.deepEqual(result.limitations, [
    'git_baseline_is_committed_state_only',
    'dependencies_not_captured',
  ]);
  assert.deepEqual(result.applied, { files: 2, absences: 4 });
  assert.deepEqual(tree(setup.destination), {
    '.git': 'gitdir: elsewhere\n',
    'changed.txt': 'new',
    'dir-to-file': 'now a file',
    'kept/': '',
    'kept/two.txt': 'x',
  });
});

test('the text summary is the only non-JSON rendering', async () => {
  const setup = scenario({ files: { 'a.txt': 'a' } });
  const run = await runIsagi(
    ['checkpoints', 'export', 'wcp_1', '--run', '42', '--output', setup.destination],
    { runtime: setup.runtime, cwd: setup.root },
  );
  assert.equal(run.code, 0);
  assert.match(run.stdout, /^Export complete: checkpoint wcp_1 of run 42/);
  assert.match(run.stdout, /applied: 1\/1 files/);
});

// ---------------------------------------------------------------------------
// resolve_destination
// ---------------------------------------------------------------------------

test('a nonempty, symlink or inside-checkout destination is refused before any request that creates', async () => {
  for (const base of [gitBase, noneBase]) {
    const nonEmpty = scenario({ base, files: { 'a.txt': 'a' } });
    mkdirSync(nonEmpty.destination);
    writeFileSync(join(nonEmpty.destination, 'x'), 'x');
    const refused = await exportTo(nonEmpty);
    assert.equal(refused.result.failure?.stage, 'resolve_destination');
    assert.equal(refused.result.failure?.code, 'export_destination_rejected');
    assert.deepEqual(refused.result.failure?.created, { destination: false, worktreeId: null });
    assert.equal(
      (refused.result.failure!.data as { destinationIssue: string }).destinationIssue,
      'not_empty',
    );
    assert.ok(!refused.endpoints.includes('workflows.createCheckpointWorktree'));

    const linked = scenario({ base, files: { 'a.txt': 'a' } });
    mkdirSync(join(linked.root, 'real'));
    symlinkSync(join(linked.root, 'real'), linked.destination);
    const symlink = await exportTo(linked);
    assert.equal(
      (symlink.result.failure!.data as { destinationIssue: string }).destinationIssue,
      'not_directory',
    );
    assert.deepEqual(
      readdirSync(join(linked.root, 'real')),
      [],
      'nothing written through the link',
    );

    const other = realpathSync(mkdtempSync(join(tmpdir(), 'isagi-cli-other-')));
    roots.push(other);
    const insideSetup = scenario({
      base,
      files: { 'a.txt': 'a' },
      projects: [
        {
          id: 4,
          rootPath: other,
          status: 'present',
          worktrees: [{ id: 8, path: other, activeSurfaceId: null }],
        },
      ],
    });
    const nested = await exportTo(insideSetup, join(other, 'deep/out'));
    assert.equal(nested.result.failure?.code, 'export_destination_rejected');
    assert.deepEqual(nested.result.failure?.data, {
      destinationPath: join(other, 'deep/out'),
      destinationIssue: 'inside_checkout',
      checkoutPath: other,
      worktreeId: 8,
    });
    assert.ok(!nested.endpoints.includes('workflows.createCheckpointWorktree'));
    assert.ok(!existsSync(join(other, 'deep')));
  }
});

test('a relative --output inside the current worktree is refused as inside_checkout', async () => {
  const setup = scenario({ files: { 'a.txt': 'a' } });
  const { result } = await exportTo(setup, './experiment-root', setup.source);
  assert.equal(result.failure?.code, 'export_destination_rejected');
  assert.equal((result.failure!.data as { sourceWorktree?: boolean }).sourceWorktree, true);
  assert.deepEqual(readdirSync(setup.source), []);
});

test('the source worktree is protected even when the snapshot lists its project as missing', async () => {
  const setup = scenario({
    files: { 'a.txt': 'a' },
    projects: [{ id: 3, rootPath: '/elsewhere/gone', status: 'missing', worktrees: [] }],
  });
  const { result } = await exportTo(setup, join(setup.source, 'sub'));
  assert.equal(result.failure?.stage, 'resolve_destination');
  assert.deepEqual(result.failure?.data, {
    destinationPath: join(setup.source, 'sub'),
    destinationIssue: 'inside_checkout',
    checkoutPath: setup.source,
    sourceWorktree: true,
  });
  assert.deepEqual(readdirSync(setup.source), []);
});

test('a run without a recorded destination path is an invalid response', async () => {
  const setup = scenario({ files: { 'a.txt': 'a' }, sourcePath: null });
  const { result } = await exportTo(setup);
  assert.equal(result.failure?.stage, 'resolve_destination');
  assert.equal(result.failure?.code, 'runtime_response_invalid');
});

// ---------------------------------------------------------------------------
// read_checkpoint and validate_inventory
// ---------------------------------------------------------------------------

test('resolvedWarningCounts counts inherited warnings and folds the truncation sentinel', async () => {
  const warning = (
    reason: string,
    path: string | null,
    observedBy: string,
    detail: Record<string, number> | null = null,
  ) =>
    ({
      kind: 'warning',
      reason,
      path,
      scopeId: null,
      detail,
      observedBy,
    }) as WorkflowCheckpointInventoryEntry;
  const setup = scenario({
    files: { 'a.txt': 'a' },
    counts: { scopes: 1, files: 1, absences: 0, warnings: 4 },
    extraEntries: [
      warning('symlink_skipped', 'src/link', 'wcp_parent'),
      warning('uncaptured_dirty_path', 'x', 'wcp_1'),
      warning('uncaptured_dirty_path', 'y', 'wcp_1'),
      warning('warnings_truncated', null, 'wcp_1', { omitted: 40 }),
    ],
  });
  const { result } = await exportTo(setup);
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.resolvedWarningCounts, { symlink_skipped: 1, uncaptured_dirty_path: 42 });
  assert.equal(result.counts?.warnings, 4, 'counts pass through unchanged');
});

test('an inventory with an unsafe path or colliding files fails at validate_inventory, before the baseline', async () => {
  const unsafe = scenario({ base: gitBase, files: { '.git/hooks/post-checkout': 'x' } });
  const refused = await exportTo(unsafe);
  assert.equal(refused.result.failure?.stage, 'validate_inventory');
  assert.equal(refused.result.failure?.code, 'export_path_unsafe');
  assert.ok(!refused.endpoints.includes('workflows.createCheckpointWorktree'));
  assert.ok(!existsSync(unsafe.destination));

  const colliding = scenario({ files: { 'A.md': 'a', 'a.md': 'b' } });
  const collision = await exportTo(colliding);
  assert.equal(collision.result.failure?.code, 'export_inventory_conflict');
  assert.deepEqual(collision.result.resolvedWarningCounts, {});
});

// ---------------------------------------------------------------------------
// prepare_baseline
// ---------------------------------------------------------------------------

const rejected = (data: Record<string, unknown>, code = 'workflow_rejected') =>
  fail(
    new RuntimeApiError({
      code,
      status: 409,
      message: 'refused',
      requestId: 'req-1',
      data,
    } as never),
  );

test('a runtime rejection passes through, with created taken from the rejection', async () => {
  const unavailable = scenario({
    base: gitBase,
    files: { 'a.txt': 'a' },
    post: () => rejected({ reason: 'workflow_checkpoint_commit_unavailable', runId: 42 }),
  });
  const gone = await exportTo(unavailable);
  assert.equal(gone.result.status, 'failed');
  assert.equal(gone.result.failure?.stage, 'prepare_baseline');
  assert.equal(gone.result.failure?.code, 'workflow_rejected');
  assert.equal(gone.result.failure?.reason, 'workflow_checkpoint_commit_unavailable');
  assert.equal(gone.result.failure?.requestId, 'req-1');
  assert.deepEqual(gone.result.failure?.created, { destination: false, worktreeId: null });

  const addFailed = scenario({
    base: gitBase,
    files: { 'a.txt': 'a' },
    post: () =>
      rejected({ reason: 'workflow_checkpoint_worktree_failed', stage: 'register', created: true }),
  });
  const partial = await exportTo(addFailed);
  assert.deepEqual(partial.result.failure?.created, { destination: true, worktreeId: null });
});

test('an error code other than workflow_rejected leaves what was created unknown, and is failed', async () => {
  const setup = scenario({
    base: gitBase,
    files: { 'a.txt': 'a' },
    post: () => rejected({ command: 'git worktree add' }, 'git_command_failed'),
  });
  const { result } = await exportTo(setup);
  assert.equal(result.status, 'failed');
  assert.equal(result.failure?.code, 'git_command_failed');
  assert.deepEqual(result.failure?.created, { destination: null, worktreeId: null });
});

test('a transport failure after sending is uncertain with no second POST; a refused connection is failed', async () => {
  const reset = scenario({
    base: gitBase,
    files: { 'a.txt': 'a' },
    post: () =>
      fail(
        new RuntimeTransportError(
          'Could not reach runtime endpoint.',
          Object.assign(new TypeError('fetch failed'), {
            cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
          }),
        ),
      ),
  });
  const uncertain = await exportTo(reset);
  assert.equal(uncertain.result.status, 'uncertain');
  assert.equal(uncertain.result.failure?.stage, 'prepare_baseline');
  assert.equal(uncertain.result.failure?.code, 'runtime_unreachable');
  assert.deepEqual(uncertain.result.failure?.created, { destination: null, worktreeId: null });
  assert.equal(
    uncertain.endpoints.filter((id) => id === 'workflows.createCheckpointWorktree').length,
    1,
    'never retried',
  );

  const undecodable = scenario({
    base: gitBase,
    files: { 'a.txt': 'a' },
    post: () => fail(new RuntimeDecodeError('workflows.createCheckpointWorktree', 'bad')),
  });
  assert.equal((await exportTo(undecodable)).result.status, 'uncertain');

  const refused = scenario({
    base: gitBase,
    files: { 'a.txt': 'a' },
    post: () =>
      fail(
        new RuntimeTransportError(
          'Could not reach runtime endpoint.',
          Object.assign(new TypeError('fetch failed'), {
            cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
          }),
        ),
      ),
  });
  const down = await exportTo(refused);
  assert.equal(down.result.status, 'failed');
  assert.equal(down.result.failure?.code, 'runtime_unreachable');
  assert.deepEqual(down.result.failure?.created, { destination: false, worktreeId: null });
});

test('a returned base or path that differs is an invalid response, with the worktree kept', async () => {
  const otherBase = scenario({
    base: gitBase,
    files: { 'a.txt': 'a' },
    post: (params, body) => {
      const { destinationPath } = body as { destinationPath: string };
      mkdirSync(destinationPath);
      writeFileSync(join(destinationPath, '.git'), '');
      return {
        ...(params as object),
        destinationPath,
        base: { ...gitBase, commitSha: 'b'.repeat(40) },
        worktreeId: 9,
      };
    },
  });
  const base = await exportTo(otherBase);
  assert.equal(base.result.failure?.code, 'runtime_response_invalid');
  assert.equal(base.result.worktreeId, 9);
  assert.deepEqual(base.result.failure?.created, { destination: true, worktreeId: 9 });
  assert.deepEqual(tree(otherBase.destination), { '.git': '' }, 'no file written');

  const elsewhere = scenario({
    base: gitBase,
    files: { 'a.txt': 'a' },
    post: (params, body) => {
      const destinationPath = `${(body as { destinationPath: string }).destinationPath}-moved`;
      mkdirSync(destinationPath);
      writeFileSync(join(destinationPath, '.git'), '');
      return { ...(params as object), destinationPath, base: gitBase, worktreeId: 9 };
    },
  });
  const moved = await exportTo(elsewhere);
  assert.equal(moved.result.failure?.code, 'runtime_response_invalid');
  assert.deepEqual(moved.result.failure?.created, { destination: true, worktreeId: 9 });
  assert.deepEqual(tree(`${elsewhere.destination}-moved`), { '.git': '' });
});

test('a returned worktree that is not visible here is export_destination_not_visible', async () => {
  const setup = scenario({
    base: gitBase,
    files: { 'a.txt': 'a' },
    post: (params, body) => ({
      ...(params as object),
      destinationPath: (body as { destinationPath: string }).destinationPath,
      base: gitBase,
      worktreeId: 9,
    }),
  });
  const { result } = await exportTo(setup);
  assert.equal(result.failure?.stage, 'prepare_baseline');
  assert.equal(result.failure?.code, 'export_destination_not_visible');
  assert.deepEqual(result.failure?.created, { destination: true, worktreeId: 9 });
});

test('a failed mkdir for a directory-only export leaves nothing, so created is false', async (context) => {
  if (process.getuid?.() === 0) return context.skip('root ignores directory permissions');
  const setup = scenario({ files: { 'a.txt': 'a' } });
  const locked = join(setup.root, 'locked');
  mkdirSync(locked);
  chmodSync(locked, 0o555);
  const { result } = await exportTo(setup, join(locked, 'out'));
  assert.equal(result.failure?.stage, 'prepare_baseline');
  assert.equal(result.failure?.code, 'filesystem_write_failed');
  assert.deepEqual(result.failure?.created, { destination: false, worktreeId: null });
});

// ---------------------------------------------------------------------------
// apply_absences and write_files
// ---------------------------------------------------------------------------

test('an absence at a directory is export_path_conflict', async () => {
  const setup = scenario({
    base: gitBase,
    baseline: (root) => mkdirSync(join(root, 'tree')),
    absences: ['tree'],
  });
  const { result } = await exportTo(setup);
  assert.equal(result.failure?.stage, 'apply_absences');
  assert.equal(result.failure?.code, 'export_path_conflict');
  assert.deepEqual(result.failure?.created, { destination: true, worktreeId: 9 });
});

test('a baseline symlink component is refused and nothing is written through it', async () => {
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'isagi-cli-outside-')));
  roots.push(outside);
  const setup = scenario({
    base: gitBase,
    baseline: (root) => symlinkSync(outside, join(root, 'link')),
    files: { 'link/escaped.txt': 'x' },
    absences: ['link/victim.txt'],
  });
  writeFileSync(join(outside, 'victim.txt'), 'keep');
  const { result } = await exportTo(setup);
  assert.equal(result.failure?.stage, 'write_files');
  assert.equal(result.failure?.code, 'export_path_unsafe');
  assert.deepEqual(
    readdirSync(outside),
    ['victim.txt'],
    'the absence did not follow the link either',
  );
});

test('oversized or hash-mismatched content is content_integrity_mismatch and leaves no temp file', async () => {
  for (const serve of [
    (_path: string, bytes: Buffer) => bytesResponse(Buffer.concat([bytes, Buffer.from('extra')])),
    (_path: string, bytes: Buffer) =>
      bytesResponse(Buffer.from(bytes.toString('utf8').toUpperCase())),
    (_path: string, bytes: Buffer) => bytesResponse(bytes.subarray(0, 1)),
  ]) {
    const setup = scenario({ base: gitBase, files: { 'dir/a.txt': 'abcdef' }, serve });
    const { result } = await exportTo(setup);
    assert.equal(result.status, 'failed');
    assert.equal(result.failure?.stage, 'write_files');
    assert.equal(result.failure?.code, 'content_integrity_mismatch');
    assert.deepEqual(result.failure?.created, { destination: true, worktreeId: 9 });
    assert.deepEqual(tempFilesUnder(setup.destination), []);
    assert.ok(!existsSync(join(setup.destination, 'dir/a.txt')));
  }
});

test('a content refusal after the worktree exists is failed with the worktree reported', async () => {
  const setup = scenario({
    base: gitBase,
    files: { 'a.txt': 'a', 'b.txt': 'b' },
    serve: (path, bytes) =>
      path === 'b.txt'
        ? rejected({
            reason: 'workflow_checkpoint_content_unavailable',
            checkpointId: 'wcp_1',
            fileId: 'wcf_2',
            cause: 'missing',
          })
        : bytesResponse(bytes),
  });
  const { result } = await exportTo(setup);
  assert.equal(result.status, 'failed');
  assert.equal(result.failure?.stage, 'write_files');
  assert.equal(result.failure?.reason, 'workflow_checkpoint_content_unavailable');
  assert.equal(result.worktreeId, 9);
  assert.deepEqual(result.failure?.created, { destination: true, worktreeId: 9 });
  assert.deepEqual(tempFilesUnder(setup.destination), []);
});

test('a directory-only export reports created by what it wrote (wroteEntry)', async () => {
  const refuse = () =>
    rejected({ reason: 'workflow_checkpoint_content_unavailable', cause: 'corrupt' });

  const nested = scenario({ files: { 'sub/a.txt': 'a' }, serve: refuse });
  const withParent = await exportTo(nested);
  assert.equal(withParent.result.failure?.stage, 'write_files');
  assert.deepEqual(withParent.result.failure?.created, { destination: true, worktreeId: null });
  assert.deepEqual(tree(nested.destination), { 'sub/': '' });

  const flat = scenario({ files: { 'a.txt': 'a' }, serve: refuse });
  const nothing = await exportTo(flat);
  assert.deepEqual(nothing.result.failure?.created, { destination: false, worktreeId: null });
  assert.deepEqual(readdirSync(flat.destination), []);
});

test('a broken content stream is runtime_unreachable, not a disk failure', async () => {
  const setup = scenario({
    files: { 'a.txt': 'abcdef' },
    serve: () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.error(new Error('socket hang up'));
          },
        }),
      ),
  });
  const { result } = await exportTo(setup);
  assert.equal(result.failure?.code, 'runtime_unreachable');
  assert.deepEqual(tempFilesUnder(setup.destination), []);
});

test('every failing export exits 1 with exactly one JSON document', async () => {
  const setup = scenario({ files: { 'a.txt': 'a' }, sourcePath: null });
  const run = await runIsagi(
    ['checkpoints', 'export', 'wcp_1', '--run', '42', '--output', setup.destination, '--json'],
    { runtime: setup.runtime, cwd: setup.root },
  );
  assert.equal(run.code, 1);
  const document = onlyJsonDocument(run.stdout) as ExportResult;
  assert.equal(document.status, 'failed');
  assert.ok(!('error' in document), 'the result, not an error document');
  assert.ok(existsSync(dirname(setup.destination)));
});
