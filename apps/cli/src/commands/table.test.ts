import assert from 'node:assert/strict';
import test from 'node:test';

import { minimalArgv } from '../testing/cli-harness.js';
import { commandTable, parseCommandLine } from './table.js';

function parsesAsUsageError(argv: readonly string[]) {
  const parsed = parseCommandLine(argv);
  assert.equal(parsed.kind, 'usage_error', `expected a usage error for: ${argv.join(' ')}`);
  return parsed.kind === 'usage_error' ? parsed.message : '';
}

test('every table entry parses from its minimal command line', () => {
  for (const spec of commandTable) {
    const parsed = parseCommandLine(minimalArgv(spec));
    assert.equal(parsed.kind, 'command', `${spec.group} ${spec.verb}`);
    if (parsed.kind === 'command') assert.equal(parsed.id, `${spec.group} ${spec.verb}`);
  }
});

test('every table entry refuses a missing positional or required flag', () => {
  for (const spec of commandTable) {
    const argv = minimalArgv(spec);
    if (spec.positionals.length > 0) {
      parsesAsUsageError(argv.filter((_, index) => index !== 2));
    }
    for (const [name, option] of Object.entries(spec.options)) {
      if (option.type !== 'string' || !option.required) continue;
      const at = argv.indexOf(`--${name}`);
      parsesAsUsageError(argv.filter((_, index) => index !== at && index !== at + 1));
    }
  }
});

test('the postmortem and reconstruction command lines parse', () => {
  for (const line of [
    'runs list --workflow implement-story --json',
    'runs show 42 --json',
    'runs events 42 --cursor 120 --json',
    'executions show 137 --json',
    'operations list --run 42 --session 9 --json',
    'operations show 31 --json',
    'checkpoints list --run 42 --scope plan --json',
    'checkpoints show 5 --json',
    'checkpoints read 5 scratch/plan.md',
    'checkpoints export 5 --output ../rebuilt --json',
  ]) {
    assert.equal(parseCommandLine(line.split(' ')).kind, 'command', line);
  }
});

test('values are converted: IDs and cursors to numbers, paths kept verbatim', () => {
  const read = parseCommandLine(['checkpoints', 'read', '5', 'notes/a b.md']);
  assert.ok(read.kind === 'command');
  assert.deepEqual(read.arguments.positionals, { checkpointId: 5, path: 'notes/a b.md' });

  const events = parseCommandLine(['runs', 'events', '4', '--cursor', '120']);
  assert.ok(events.kind === 'command');
  assert.deepEqual(events.arguments.options, { cursor: 120, limit: undefined });
  parsesAsUsageError(['runs', 'events', '4', '--cursor', 'c1']);
});

test('IDs must be positive integers', () => {
  for (const value of ['0', '-3', '1.5', 'abc', '1e3', '99999999999999999999']) {
    parsesAsUsageError(['runs', 'show', value]);
    parsesAsUsageError(['operations', 'list', '--run', value]);
    parsesAsUsageError(['checkpoints', 'show', value]);
  }
});

test('the page limit and run status follow the contract', () => {
  assert.equal(parseCommandLine(['runs', 'list', '--limit', '500']).kind, 'command');
  parsesAsUsageError(['runs', 'list', '--limit', '501']);
  parsesAsUsageError(['runs', 'list', '--limit', '0']);
  assert.equal(parseCommandLine(['runs', 'list', '--status', 'failed']).kind, 'command');
  assert.match(parsesAsUsageError(['runs', 'list', '--status', 'broken']), /must be one of/);
});

test('unknown commands, flags and extra arguments are usage errors', () => {
  parsesAsUsageError([]);
  parsesAsUsageError(['runs']);
  parsesAsUsageError(['nope', 'list']);
  parsesAsUsageError(['runs', 'nope']);
  parsesAsUsageError(['runs', 'list', '--bogus']);
  parsesAsUsageError(['runs', 'show', '1', '2']);
  // Not exposed on purpose.
  parsesAsUsageError(['runs', 'dismiss', '1']);
  parsesAsUsageError(['runs', 'advance', '1']);
  // Removed: ids are global, and evidence, attempts, payloads and versions are gone.
  parsesAsUsageError(['checkpoints', 'show', '5', '--run', '42']);
  for (const [group, verb] of [
    ['runs', 'inspect'],
    ['runs', 'versions'],
    ['executions', 'list'],
    ['attempts', 'list'],
    ['payloads', 'read'],
    ['evidence', 'list'],
    ['checkpoints', 'inspect'],
  ]) {
    parsesAsUsageError([group!, verb!, '1']);
  }
});

test('global flags are read wherever they appear, including on a usage error', () => {
  const parsed = parseCommandLine(['--json', '--runtime-url', 'http://h:1', 'runs', 'show', '3']);
  assert.ok(parsed.kind === 'command');
  assert.deepEqual(parsed.global, { json: true, runtimeUrl: 'http://h:1' });

  const refused = parseCommandLine(['runs', 'show', 'x', '--json']);
  assert.ok(refused.kind === 'usage_error');
  assert.equal(refused.global.json, true);
});

test('help is generated from the table', () => {
  const top = parseCommandLine(['--help']);
  assert.ok(top.kind === 'help');
  for (const spec of commandTable) assert.ok(top.text.includes(`${spec.group} ${spec.verb}`));

  const one = parseCommandLine(['checkpoints', 'read', '--help']);
  assert.ok(one.kind === 'help');
  assert.match(one.text, /Usage: isagi checkpoints read <checkpointId> <path>/);
  assert.match(one.text, /Writes raw bytes to stdout/);
});

test('launch and export commands parse with their story flags', () => {
  for (const argv of [
    ['checkpoints', 'export', '5', '--output', '/Users/me/isagi-experiments/phase-2', '--json'],
    ['workflows', 'list', '--json'],
    ['workflows', 'list', '--worktree', '3', '--surface', '9'],
    ['runs', 'launch', 'implement-story', '--inputs', '{"story":47}', '--json'],
    [
      'runs',
      'launch',
      'implement-story',
      '--worktree-placement',
      'existing:31',
      '--surface-placement',
      'create:Experiment',
    ],
  ]) {
    assert.equal(parseCommandLine(argv).kind, 'command', argv.join(' '));
  }
});

test('placement values follow their grammar; a surface title keeps every colon', () => {
  const placement = (worktree: string, surface: string) => {
    const parsed = parseCommandLine([
      'runs',
      'launch',
      'k',
      '--worktree-placement',
      worktree,
      '--surface-placement',
      surface,
    ]);
    assert.ok(parsed.kind === 'command', `${worktree} ${surface}`);
    const options = parsed.arguments.options as Record<string, unknown>;
    return [options['worktree-placement'], options['surface-placement']];
  };
  assert.deepEqual(placement('current', 'current'), [{ kind: 'current' }, { kind: 'current' }]);
  assert.deepEqual(placement('existing:31', 'existing:7'), [
    { kind: 'existing', worktreeId: 31 },
    { kind: 'existing', surfaceId: 7 },
  ]);
  assert.deepEqual(placement('create:exp/retry:origin/main', 'create:Retry: phase 2: again'), [
    { kind: 'create', branch: 'exp/retry', fromRef: 'origin/main' },
    { kind: 'create', title: 'Retry: phase 2: again' },
  ]);

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
    parsesAsUsageError([
      'runs',
      'launch',
      'k',
      '--worktree-placement',
      worktree,
      '--surface-placement',
      surface,
    ]);
  }
});

test('paired flags must be given together, and --surface needs its --worktree', () => {
  assert.match(
    parsesAsUsageError(['runs', 'launch', 'k', '--worktree-placement', 'current']),
    /--worktree-placement requires --surface-placement/,
  );
  assert.match(
    parsesAsUsageError(['runs', 'launch', 'k', '--surface-placement', 'current']),
    /--surface-placement requires --worktree-placement/,
  );
  assert.match(
    parsesAsUsageError(['workflows', 'list', '--surface', '3']),
    /--surface requires --worktree/,
  );
});
