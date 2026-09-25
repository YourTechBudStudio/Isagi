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

test('the story commands parse with their story flags', () => {
  for (const line of [
    'runs list --workflow implement-story --json',
    'runs inspect 42 --json',
    'evidence list --run 42 --execution 137 --descendants --json',
    'evidence inspect artifact-501 --run 42 --json',
    'evidence read artifact-501 --run 42',
    'evidence export artifact-503 --run 42 --output ./review-screenshot.png --json',
    'checkpoints list --run 42 --execution 137 --descendants --json',
    'checkpoints inspect checkpoint-42-2 --run 42 --json',
    'checkpoints inspect checkpoint-42-2 --run 42 --resolved --json',
    'checkpoints inspect checkpoint-42-2 --run 42 --manifest --json',
  ]) {
    assert.equal(parseCommandLine(line.split(' ')).kind, 'command', line);
  }
});

test('values are converted: IDs to numbers, keys kept verbatim, labels repeated', () => {
  const parsed = parseCommandLine([
    'evidence',
    'list',
    '--run',
    '42',
    '--execution',
    '137',
    '--label',
    'round-1',
    '--label',
    'a,b',
  ]);
  assert.equal(parsed.kind, 'command');
  if (parsed.kind !== 'command') return;
  assert.deepEqual(parsed.arguments.options, {
    run: 42,
    execution: 137,
    descendants: false,
    role: undefined,
    label: ['round-1', 'a,b'],
    cursor: undefined,
    limit: undefined,
  });

  const inspected = parseCommandLine(['checkpoints', 'inspect', 'wcp_01J', '--run', '42']);
  assert.ok(inspected.kind === 'command');
  assert.deepEqual(inspected.arguments.positionals, { checkpointId: 'wcp_01J' });
});

test('--resolved and --manifest are mutually exclusive', () => {
  const message = parsesAsUsageError([
    'checkpoints',
    'inspect',
    'wcp_1',
    '--run',
    '1',
    '--resolved',
    '--manifest',
  ]);
  assert.match(message, /--resolved and --manifest cannot be combined/);
});

test('--descendants requires --execution for both evidence and checkpoints', () => {
  for (const group of ['evidence', 'checkpoints']) {
    const message = parsesAsUsageError([group, 'list', '--run', '1', '--descendants']);
    assert.match(message, /--descendants requires --execution/);
  }
});

test('IDs must be positive integers', () => {
  for (const value of ['0', '-3', '1.5', 'abc', '1e3', '99999999999999999999']) {
    parsesAsUsageError(['runs', 'inspect', value]);
    parsesAsUsageError(['executions', 'list', '--run', value]);
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
  parsesAsUsageError(['runs', 'inspect', '1', '2']);
  // Not exposed on purpose.
  parsesAsUsageError(['runs', 'dismiss', '1']);
  parsesAsUsageError(['runs', 'advance', '1']);
  // Phase-later commands are not registered as placeholders.
  parsesAsUsageError(['checkpoints', 'export', 'wcp_1', '--run', '1', '--output', '/tmp/x']);
});

test('global flags are read wherever they appear, including on a usage error', () => {
  const parsed = parseCommandLine([
    '--json',
    '--runtime-url',
    'http://h:1',
    'runs',
    'inspect',
    '3',
  ]);
  assert.ok(parsed.kind === 'command');
  assert.deepEqual(parsed.global, { json: true, runtimeUrl: 'http://h:1' });

  const refused = parseCommandLine(['runs', 'inspect', 'x', '--json']);
  assert.ok(refused.kind === 'usage_error');
  assert.equal(refused.global.json, true);
});

test('help is generated from the table', () => {
  const top = parseCommandLine(['--help']);
  assert.ok(top.kind === 'help');
  for (const spec of commandTable) assert.ok(top.text.includes(`${spec.group} ${spec.verb}`));

  const one = parseCommandLine(['checkpoints', 'inspect', '--help']);
  assert.ok(one.kind === 'help');
  assert.match(one.text, /Usage: isagi checkpoints inspect <checkpointId> --run <runId>/);
  assert.match(one.text, /--resolved and --manifest are mutually exclusive/);
});
