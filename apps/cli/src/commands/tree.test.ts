import assert from 'node:assert/strict';
import test from 'node:test';

import packageJson from '../../package.json' with { type: 'json' };
import { fakeRuntimeEntry, minimalCommandLines, runIsagi } from '../testing/cli-harness.js';
import { checkCommandLine } from './check.js';
import { commandCatalog, isRawCommand } from './tree.js';

const groups = new Set([
  'isagi',
  'isagi workflows',
  'isagi workflows runs',
  'isagi workflows executions',
  'isagi workflows operations',
  'isagi workflows checkpoints',
]);

async function refused(line: string) {
  const checked = await checkCommandLine(line.split(' '));
  assert.equal(checked.ok, false, `expected a usage error for: ${line}`);
  return checked.ok ? undefined : checked.error;
}

async function accepted(argv: readonly string[]) {
  const checked = await checkCommandLine(argv);
  assert.ok(checked.ok, `${argv.join(' ')}: ${checked.ok ? '' : checked.error.message}`);
}

test('--help works for every node and shows examples, without loading the runtime', async () => {
  const runtimeEntry = fakeRuntimeEntry({
    load: () => Promise.reject(new Error('help must not load the runtime')),
  }).entry;
  for (const { path } of commandCatalog) {
    const run = await runIsagi([...path.slice(1), '--help'], { runtimeEntry });
    assert.equal(run.code, 0, path.join(' '));
    assert.equal(run.stderr, '', path.join(' '));
    assert.match(run.stdout, /^EXAMPLES$/m, path.join(' '));
    assert.match(run.stdout, new RegExp(`isagi ${path.slice(1).join(' ')}`), path.join(' '));
  }
  const version = await runIsagi(['--version'], { runtimeEntry });
  assert.equal(version.code, 0);
  assert.equal(version.stdout, `isagi v${packageJson.version}\n`);
});

test('the catalog lists every node once, and only checkpoints read is raw', () => {
  const paths = commandCatalog.map((entry) => entry.path.join(' '));
  assert.equal(new Set(paths).size, paths.length);
  const leaves = paths.filter((path) => !groups.has(path) && path !== 'isagi serve');
  assert.deepEqual(
    leaves.map((path) => path.slice('isagi '.length)).sort(),
    Object.keys(minimalCommandLines).sort(),
  );
  assert.deepEqual(
    commandCatalog.filter((entry) => entry.stdout === 'raw').map((entry) => entry.path.join(' ')),
    ['isagi workflows checkpoints read'],
  );
  assert.ok(isRawCommand(['isagi', 'workflows', 'checkpoints', 'read']));
  assert.ok(!isRawCommand(['isagi', 'workflows', 'checkpoints']));
  assert.ok(!isRawCommand(['isagi']));
});

test('every leaf accepts its minimal command line and refuses a missing positional or flag', async () => {
  for (const [command, rest] of Object.entries(minimalCommandLines)) {
    const argv = [...command.split(' '), ...rest];
    await accepted(argv);
    await accepted([...argv, '--json', '--runtime-url', 'http://127.0.0.1:1']);
    for (let index = 0; index < rest.length; index += rest[index]!.startsWith('--') ? 2 : 1) {
      const width = rest[index]!.startsWith('--') ? 2 : 1;
      const without = [...rest.slice(0, index), ...rest.slice(index + width)];
      await refused([...command.split(' '), ...without].join(' '));
    }
  }
});

test('the postmortem and reconstruction command lines parse', async () => {
  for (const line of [
    'workflows runs list --workflow implement-story --json',
    'workflows runs show 42 --json',
    'workflows runs events 42 --cursor 120 --json',
    'workflows executions show 137 --json',
    'workflows operations list --run 42 --session 9 --json',
    'workflows operations show 31 --json',
    'workflows checkpoints list --run 42 --scope plan --json',
    'workflows checkpoints show 5 --json',
    'workflows checkpoints read 5 scratch/plan.md',
    'workflows checkpoints export 5 --output ../rebuilt --json',
    'workflows list --worktree 3 --surface 9',
    'workflows runs launch implement-story --inputs {"story":47} --json',
    'workflows runs launch k --worktree-placement existing:31 --surface-placement create:Experiment',
    'serve',
    'serve --port 11299 --host 0.0.0.0 --data-dir /srv/isagi --json',
  ]) {
    await accepted(line.split(' '));
  }
});

test('IDs and cursors must be positive integers', async () => {
  for (const value of ['0', '-3', '1.5', 'abc', '1e3', '99999999999999999999']) {
    await refused(`workflows runs show ${value}`);
    await refused(`workflows operations list --run ${value}`);
    await refused(`workflows checkpoints show ${value}`);
    await refused(`workflows runs events 4 --cursor ${value}`);
  }
  const error = await refused('workflows runs show abc');
  assert.equal(error?.message, '<runId> must be a positive integer, got "abc".');
});

test('the page limit and run status follow the contract', async () => {
  await accepted(['workflows', 'runs', 'list', '--limit', '500']);
  await refused('workflows runs list --limit 501');
  await refused('workflows runs list --limit 0');
  await accepted(['workflows', 'runs', 'list', '--status', 'failed']);
  const error = await refused('workflows runs list --status broken');
  assert.match(error?.message ?? '', /^--status must be one of .*, got "broken"\.$/);
});

test('placement values follow their grammar; a surface title keeps every colon', async () => {
  const line = (worktree: string, surface: string) => [
    'workflows',
    'runs',
    'launch',
    'k',
    '--worktree-placement',
    worktree,
    '--surface-placement',
    surface,
  ];
  for (const [worktree, surface] of [
    ['current', 'current'],
    ['existing:31', 'existing:7'],
    ['create:exp/retry:origin/main', 'create:Retry: phase 2: again'],
  ] as const) {
    await accepted(line(worktree, surface));
  }
  for (const [worktree, surface] of [
    ['existing:0', 'current'],
    ['existing:x', 'current'],
    ['create:branch', 'current'],
    ['create::main', 'current'],
    ['create:b:', 'current'],
    ['elsewhere', 'current'],
    ['current', 'create:'],
    ['current', 'existing:-1'],
    ['current', 'new'],
  ] as const) {
    const checked = await checkCommandLine(line(worktree, surface));
    assert.equal(checked.ok, false, `${worktree} ${surface}`);
  }
});

test('paired flags must be given together, --surface needs its --worktree, a flag needs its value', async () => {
  for (const [line, message] of [
    [
      'workflows runs launch k --worktree-placement current',
      '--worktree-placement requires --surface-placement.',
    ],
    [
      'workflows runs launch k --surface-placement current',
      '--surface-placement requires --worktree-placement.',
    ],
    ['workflows list --surface 3', '--surface requires --worktree.'],
    ['workflows operations list --run', '--run needs a value.'],
    ['serve --host', '--host needs a value.'],
  ] as const) {
    const error = await refused(line);
    assert.equal(error?.message, message);
  }
});

test('unknown commands, flags and extra arguments are usage errors', async () => {
  for (const line of [
    'workflows',
    'workflows runs',
    'nope list',
    'workflows runs nope',
    'workflows runs list --bogus',
    'workflows runs show 1 2',
    'serve --runtime-url http://127.0.0.1:1',
    'workflows runs list --json=true',
    // Not exposed on purpose.
    'workflows runs dismiss 1',
    'workflows runs advance 1',
    // Removed: ids are global, and evidence, attempts, payloads and versions are gone.
    'workflows checkpoints show 5 --run 42',
    'workflows runs inspect 1',
    'workflows runs versions 1',
    'workflows executions list 1',
    'workflows attempts list 1',
    'workflows checkpoints inspect 1',
    // The old root spellings.
    'runs list',
    'checkpoints show 5',
  ]) {
    await refused(line);
  }
  assert.equal((await checkCommandLine([])).ok, false);
});
