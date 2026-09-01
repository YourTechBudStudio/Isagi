import assert from 'node:assert/strict';
import test from 'node:test';

import type { CommandActionOutput, CommandStatus, CommandSummary } from '@isagi/contracts';

import { paletteCopy } from '../../copy/index.js';
import {
  configuredCommandEntries,
  configuredCommandSection,
  type ConfiguredCommandEntryDeps,
} from './configured-commands.js';
import type { PaletteContext } from './types.js';

const WORKTREE_ID = 11;

test('a configured catalog maps to the context command summaries', () => {
  assert.deepEqual(
    configuredCommandSection({ data: configured([summary('dev')]), isError: false }),
    {
      configuredCommands: [summary('dev')],
    },
  );
});

test('an empty configured catalog maps to an empty list, not to absence', () => {
  const section = configuredCommandSection({ data: configured([]), isError: false });

  assert.deepEqual(section.configuredCommands, []);
  assert.equal(section.configuredCommandsFailure, undefined);
});

test('a config_error read maps to the config_error failure kind and no commands', () => {
  const section = configuredCommandSection({
    data: {
      status: 'config_error',
      worktreeId: WORKTREE_ID,
      diagnostic: {
        code: 'command_config_invalid',
        path: '/repo/.isagi/config.yaml',
        message: 'commands must be a mapping',
      },
      managedCommands: [summary('dev', 'running')],
    },
    isError: false,
  });

  assert.equal(section.configuredCommandsFailure, 'config_error');
  // Managed survivors of a broken config are not runnable, so they never
  // become palette rows.
  assert.equal(section.configuredCommands, undefined);
});

test('a terminal query error maps to unavailable and overrides retained data', () => {
  const section = configuredCommandSection({ data: configured([summary('dev')]), isError: true });

  assert.equal(section.configuredCommandsFailure, 'unavailable');
  assert.equal(section.configuredCommands, undefined);
});

test('a pending query with no data yields no section fields', () => {
  assert.deepEqual(configuredCommandSection({ data: undefined, isError: false }), {});
});

test('each configured command yields one worktree-commands row with a worktree-scoped id', () => {
  const [entry, ...rest] = configuredCommandEntries(
    ctx({ configuredCommands: [summary('dev')] }),
    recorder().deps,
  );

  assert.equal(rest.length, 0);
  assert.equal(entry?.id, `command:${WORKTREE_ID}:dev`);
  assert.equal(entry?.label, 'dev');
  assert.equal(entry?.group, 'worktree-commands');
  assert.equal(entry?.sub, paletteCopy.commands.sub.run);
  // The closure is the whole operational target: nothing else carries it, and
  // nothing parses the id.
  assert.equal(entry?.values, undefined);
  assert.equal(entry?.command, undefined);
  assert.equal(entry?.tone, undefined);
});

test('a running row opens focused details without running anything', async () => {
  const { deps, calls } = recorder();
  const [entry] = configuredCommandEntries(
    ctx({
      configuredCommands: [summary('api', 'running', [{ port: 8080, envVar: null, urls: [] }])],
    }),
    deps,
  );

  await entry?.run();

  assert.deepEqual(calls, ['open:api']);
  assert.equal(entry?.tone, 'working');
  // A pathless resolved entry is the one thing that still earns a raw token: it
  // has no URL badge and no drawer URL row, so the palette is where it shows.
  assert.equal(entry?.sub, paletteCopy.commands.sub.running([8080]));
});

test('a running row omits ports that already have a URL representation', () => {
  // A port with paths appears as a strip badge and a drawer row. Repeating it
  // here as a bare number would be a third, less informative presentation.
  const [entry] = configuredCommandEntries(
    ctx({
      configuredCommands: [
        summary('api', 'running', [
          {
            port: 8080,
            envVar: null,
            urls: [{ label: 'app', path: '/', url: 'http://localhost:8080/' }],
          },
          { port: 9229, envVar: null, urls: [] },
        ]),
      ],
    }),
    recorder().deps,
  );

  assert.equal(entry?.sub, paletteCopy.commands.sub.running([9229]));
});

test('a running row with degraded or empty ports keeps the plain subtitle', () => {
  for (const ports of [null, []] as const) {
    const [entry] = configuredCommandEntries(
      ctx({ configuredCommands: [summary('api', 'running', ports)] }),
      recorder().deps,
    );
    assert.equal(entry?.sub, paletteCopy.commands.sub.running([]));
  }
});

test('the running subtitle still formats port tokens it is given', () => {
  // The formatter survives the reset intact — `:<port>` remains the target
  // presentation for a resolved pathless entry. Only its data source changed.
  assert.equal(paletteCopy.commands.sub.running([]), 'open details');
  assert.equal(paletteCopy.commands.sub.running([8080]), 'open details \u00b7 :8080');
  assert.equal(paletteCopy.commands.sub.running([8080, 9229]), 'open details \u00b7 :8080 :9229');
});

test('startable rows run then open the drawer, for resolved running and failed launches', async () => {
  const startable: CommandStatus[] = ['idle', 'stopped', 'exited', 'failed'];
  const resolved: CommandStatus[] = ['running', 'failed'];

  for (const status of startable) {
    for (const launchResult of resolved) {
      const { deps, calls } = recorder(launchResult);
      const [entry] = configuredCommandEntries(
        ctx({ configuredCommands: [summary('dev', status)] }),
        deps,
      );

      await entry?.run();

      // Order is the assertion: the handoff must follow the launch, and a
      // success-shaped `failed` result still hands off to the drawer.
      assert.deepEqual(calls, ['run:dev', 'open:dev'], `${status} launching ${launchResult}`);
      assert.equal(entry?.sub, paletteCopy.commands.sub.run);
      assert.equal(entry?.tone, undefined);
    }
  }
});

test('a suspended row resumes the command and says so, without looking like a fresh run', async () => {
  const { deps, calls } = recorder();
  const [entry] = configuredCommandEntries(
    ctx({ configuredCommands: [summary('dev', 'suspended')] }),
    deps,
  );

  await entry?.run();

  // Behaviourally a suspended row is a startable row — same launch, same handoff
  // to the drawer. Only the word differs, because the user is continuing a
  // command that already exists rather than starting a new one.
  assert.deepEqual(calls, ['run:dev', 'open:dev']);
  assert.equal(entry?.sub, paletteCopy.commands.sub.resume);
  assert.notEqual(entry?.sub, paletteCopy.commands.sub.run);
  // No state tint: `working` is reserved for a command that is actually running,
  // and a suspended row must not borrow the live cue.
  assert.equal(entry?.tone, undefined);
});

test('a rejected run rethrows and never opens the drawer', async () => {
  const { deps, calls } = recorder();
  const [entry] = configuredCommandEntries(ctx({ configuredCommands: [summary('dev')] }), {
    ...deps,
    runCommand: async () => Promise.reject(new Error('runtime unreachable')),
  });

  await assert.rejects(async () => entry?.run(), /runtime unreachable/);
  assert.deepEqual(calls, []);
});

test('a catalog failure yields one selectable error row that opens the drawer unfocused', async () => {
  for (const [kind, copy] of [
    ['config_error', paletteCopy.commands.failure.configError],
    ['unavailable', paletteCopy.commands.failure.unavailable],
  ] as const) {
    const { deps, calls } = recorder();
    const entries = configuredCommandEntries(ctx({ configuredCommandsFailure: kind }), deps);

    assert.equal(entries.length, 1, kind);
    assert.equal(entries[0]?.id, 'configured-commands-failure');
    assert.equal(entries[0]?.tone, 'error');
    assert.equal(entries[0]?.label, copy.label);
    assert.equal(entries[0]?.sub, copy.sub);

    await entries[0]?.run();
    // No command argument, so the drawer keeps whatever was selected before.
    assert.deepEqual(calls, ['open:']);
  }
});

test('a catalog failure takes precedence over any retained command rows', () => {
  const entries = configuredCommandEntries(
    ctx({
      configuredCommands: [summary('dev'), summary('api', 'running')],
      configuredCommandsFailure: 'unavailable',
    }),
    recorder().deps,
  );

  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.id, 'configured-commands-failure');
});

test('no rows without an active worktree', () => {
  assert.deepEqual(
    configuredCommandEntries(
      ctx({ activeWorktree: null, configuredCommands: [summary('dev')] }),
      recorder().deps,
    ),
    [],
  );
  assert.deepEqual(
    configuredCommandEntries(
      ctx({ activeWorktree: null, configuredCommandsFailure: 'config_error' }),
      recorder().deps,
    ),
    [],
  );
});

function summary(
  name: string,
  status: CommandStatus = 'idle',
  ports: CommandSummary['ports'] = [],
): CommandSummary {
  return { name, status, ports };
}

function configured(commands: readonly CommandSummary[]) {
  return {
    status: 'configured',
    worktreeId: WORKTREE_ID,
    commands,
    removedCommands: [],
  } as const;
}

/**
 * Records what a selection did, in the order it happened, so the tests assert
 * branch order rather than trusting that a launch preceded its handoff.
 */
function recorder(launchStatus: CommandStatus = 'running') {
  const calls: string[] = [];
  const deps: ConfiguredCommandEntryDeps = {
    runCommand: async (worktreeId, commandName) => {
      calls.push(`run:${commandName}`);
      const output: CommandActionOutput = {
        worktreeId,
        commandName,
        summary: summary(commandName, launchStatus),
      };
      return output;
    },
    openDrawer: (commandName) => {
      calls.push(`open:${commandName ?? ''}`);
    },
  };
  return { deps, calls };
}

function ctx(options: Partial<PaletteContext> = {}): PaletteContext {
  return {
    projects: [],
    activeProject: null,
    activeWorktree: {
      id: WORKTREE_ID,
      projectId: 1,
      title: 'feature/commands',
      path: '/repo/isagi-feature',
      branch: 'feature/commands',
      head: 'abcdef0',
      isRoot: false,
      attention: 'idle',
      parked: false,
      surfaces: [],
      activeSurfaceId: null,
    },
    activeSurface: null,
    activePaneId: null,
    launchableHarnesses: [],
    editorAvailable: false,
    ...options,
  };
}
