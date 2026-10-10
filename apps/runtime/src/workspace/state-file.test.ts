import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect } from 'effect';

import { makeLogCapture, runScoped } from '@isagi/testing';

import { DataDirectory } from '../platform/persistence/index.js';
import { makeTestDataDirectory } from '../platform/persistence/testing.js';
import { StateFile, stateFromActiveContext } from './state-file.js';

/** Runs `use` against a real `StateFile` over a fresh data directory, removed afterwards. */
async function withStateFile<A>(
  use: (input: {
    readonly root: string;
    readonly statePath: string;
    readonly run: <B, E>(effect: Effect.Effect<B, E, StateFile>) => Promise<B>;
  }) => Promise<A>,
) {
  const root = mkdtempSync(join(tmpdir(), 'isagi-state-'));
  const paths = makeTestDataDirectory(root).paths;
  try {
    return await use({
      root,
      statePath: paths.statePath,
      run: (effect) =>
        runScoped(
          effect.pipe(
            Effect.provide(StateFile.layer),
            Effect.provideService(DataDirectory, { paths }),
          ),
        ),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const readState = StateFile.use((stateFile) => stateFile.read);

test('malformed state file recovery is logged and stays out of the returned state', async () => {
  await withStateFile(async ({ root, statePath, run }) => {
    writeFileSync(statePath, '{ not json', 'utf8');
    const logs = makeLogCapture();

    const state = await run(readState.pipe(Effect.provide(logs.layer)));

    assert.deepEqual(state, {
      version: 1,
      workspace: { activeProjectId: null, activeWorktreeId: null, activeContextRevision: 0 },
    });
    assert.equal('recoveryNotice' in state, false);
    assert.equal(logs.lines.length, 1);
    assert.equal(logs.lines[0]?.level, 'Warn');
    assert.match(logs.lines[0]?.message ?? '', /^Recovered malformed Isagi state file/);
    const backupPath = logs.lines[0]?.annotations.backupPath;
    assert.equal(typeof backupPath, 'string');
    assert.equal(existsSync(String(backupPath)), true);
    assert.equal(existsSync(statePath), true);
    assert.deepEqual(JSON.parse(readFileSync(statePath, 'utf8')), state);
    assert.ok(readdirSync(root).some((entry) => entry.startsWith('state.json.malformed-')));
  });
});

/**
 * `parseState` is a lenient validator on purpose (plan R29): a strict decode would call these files malformed, back
 * them up and reset the user's active context. Each fixture is a shape an older runtime or a hand edit can leave.
 */
test('state.json without activeContextRevision or with null ids still restores', async () => {
  const fixtures = [
    {
      label: 'revision missing reads as 0',
      file: { version: 1, workspace: { activeProjectId: 2, activeWorktreeId: 20 } },
      expected: stateFromActiveContext(2, 20, 0),
    },
    {
      label: 'revision null reads as 0',
      file: {
        version: 1,
        workspace: { activeProjectId: 2, activeWorktreeId: 20, activeContextRevision: null },
      },
      expected: stateFromActiveContext(2, 20, 0),
    },
    {
      label: 'ids missing read as null',
      file: { version: 1, workspace: { activeContextRevision: 4 } },
      expected: stateFromActiveContext(null, null, 4),
    },
    {
      label: 'ids null read as null',
      file: {
        version: 1,
        workspace: { activeProjectId: null, activeWorktreeId: null, activeContextRevision: 4 },
      },
      expected: stateFromActiveContext(null, null, 4),
    },
    {
      label: 'an empty workspace object reads as the default',
      file: { version: 1, workspace: {} },
      expected: stateFromActiveContext(null, null, 0),
    },
  ];

  for (const fixture of fixtures) {
    await withStateFile(async ({ root, statePath, run }) => {
      const contents = `${JSON.stringify(fixture.file)}\n`;
      writeFileSync(statePath, contents, 'utf8');
      const logs = makeLogCapture();

      const state = await run(readState.pipe(Effect.provide(logs.layer)));

      assert.deepEqual(state, fixture.expected, fixture.label);
      // Restored, not recovered: no backup, no warning, and the file is left exactly as it was.
      assert.deepEqual(logs.lines, [], fixture.label);
      assert.equal(
        readdirSync(root).some((entry) => entry.startsWith('state.json.malformed-')),
        false,
        fixture.label,
      );
      assert.equal(readFileSync(statePath, 'utf8'), contents, fixture.label);
    });
  }

  // The lenient cases stop at absence: a value of the wrong kind is still malformed, backed up and reset.
  await withStateFile(async ({ root, statePath, run }) => {
    writeFileSync(
      statePath,
      JSON.stringify({ version: 1, workspace: { activeProjectId: 'two', activeWorktreeId: null } }),
      'utf8',
    );
    const logs = makeLogCapture();

    const state = await run(readState.pipe(Effect.provide(logs.layer)));

    assert.deepEqual(state, stateFromActiveContext(null, null, 0));
    assert.equal(logs.lines.length, 1);
    assert.ok(readdirSync(root).some((entry) => entry.startsWith('state.json.malformed-')));
    assert.deepEqual(JSON.parse(readFileSync(statePath, 'utf8')), state);
  });
});

test('a missing state file is created with the default state', async () => {
  await withStateFile(async ({ statePath, run }) => {
    const state = await run(readState);

    assert.deepEqual(state, stateFromActiveContext(null, null, 0));
    assert.deepEqual(JSON.parse(readFileSync(statePath, 'utf8')), state);
  });
});

test('active context writes keep the highest revision durable', async () => {
  await withStateFile(async ({ statePath, run }) => {
    const state = await run(
      Effect.gen(function* () {
        const stateFile = yield* StateFile;
        yield* stateFile.write(stateFromActiveContext(2, 20, 2));
        yield* stateFile.writeActiveContextIfFresh({
          activeProjectId: 3,
          activeWorktreeId: 30,
          revision: 2,
        });
        return yield* stateFile.writeActiveContextIfFresh({
          activeProjectId: 1,
          activeWorktreeId: 10,
          revision: 1,
        });
      }),
    );

    assert.deepEqual(state, stateFromActiveContext(2, 20, 2));
    assert.deepEqual(JSON.parse(readFileSync(statePath, 'utf8')), state);
  });
});
