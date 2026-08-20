import type {
  CommandLogMetadataLatestRun,
  CommandStatus,
  CommandSummary,
  WorkflowCommandManifestDto,
  WorktreeCommandsOutput,
} from '@isagi/contracts';

import {
  FIXTURE_CATALOG,
  FIXTURE_CONTROL_FAILED_RUN,
  FIXTURE_CONTROL_PLANE,
  FIXTURE_MANAGED_SUSPENDED,
  FIXTURE_REMOVED_SUSPENDED,
  FIXTURE_SNAPSHOT,
  FIXTURE_SURFACE_DETAILS,
  FIXTURE_SUSPENDED_COMMANDS,
} from './seed.js';

/**
 * A runtime made of one mutable object and a `fetch` stub.
 *
 * The fixture mounts the production `CommandPalette` and `WorkbenchDrawer`, so
 * the production query observer, the production runtime client and its decoding,
 * the real run helper, and the real invalidation all execute. The only thing
 * replaced is the process at the other end of the wire.
 *
 * It applies runs for real. `POST .../commands/run` marks the command `running`
 * in this state, so the catalog read that follows *converges* on the transition
 * instead of reporting the old status and hiding a broken invalidation. Server
 * state observed after the fact is the proof a mutation happened; a recorded
 * request alone would only prove the client spoke.
 *
 * Tests steer it through `window.commandPaletteFixture` rather than through
 * on-screen controls: the palette and the drawer should be the only things on
 * this page. These are the runtime's half of that object; the fixture app owns
 * the global and merges its own store-side controls in, so there is exactly one
 * publisher.
 */
export interface CommandPaletteRuntimeControls {
  /** Replace a worktree's catalog with a valid `configured` read. */
  readonly setCatalog: (commands: readonly CommandSummary[], worktreeId?: number) => void;
  /**
   * Commands with live runtime state whose config entries are gone. Kept apart
   * from `setCatalog` because the contract keeps them apart: they are the same
   * shape but a different fact, and only the configured half is runnable.
   */
  readonly setRemovedCommands: (commands: readonly CommandSummary[], worktreeId?: number) => void;
  /**
   * Serve a `config_error` catalog for a worktree, with its diagnostic and any
   * commands the runtime is still managing through the unreadable config.
   */
  readonly breakConfig: (worktreeId?: number, managedCommands?: readonly CommandSummary[]) => void;
  /**
   * Attach a latest run to one command, so the drawer's diagnostic path runs on
   * real metadata instead of the `null` every command otherwise reports.
   */
  readonly setLatestRun: (
    commandName: string,
    latestRun: CommandLogMetadataLatestRun | null,
  ) => void;
  /**
   * Make catalog reads fail at the transport level. This is the `unavailable`
   * state, which is a failed read rather than a catalog variant — the production
   * retry ladder means the failure row appears a few seconds later, exactly as
   * it would in the app.
   */
  readonly setCatalogUnavailable: (unavailable: boolean) => void;
  /** Workflow rows, by title. Empty by default, so the group is absent for a real reason. */
  readonly setWorkflows: (titles: readonly string[]) => void;
  /** Reject the next run, so the palette's inline failure can be observed. */
  readonly failNextRun: () => void;
  /** Hold every run open for `ms`, widening the in-flight window. */
  readonly setRunDelay: (ms: number) => void;
  /** Catalog reads served, in total or for one worktree. */
  readonly commandsFetchCount: (worktreeId?: number) => number;
  /** Ordered run requests the endpoint received — the server-owned mutation record. */
  readonly runRequests: () => readonly {
    readonly worktreeId: number;
    readonly commandName: string;
  }[];
  /**
   * Put the origin worktree into one of the reviewable suspension states.
   *
   * This is the seam a human reviewer uses: open the page, run
   * `commandPaletteFixture.applyScenario('managed')` in the console, and look at
   * the real drawer and strip. The browser tests drive the same entry point, so
   * what a reviewer judges and what the suite pins are the same fixture data
   * rather than two definitions that can drift apart.
   */
  readonly applyScenario: (scenario: SuspensionScenario) => void;
  /** Ordered stop/restart requests, so an intent-clearing Stop is observable. */
  readonly actionRequests: () => readonly {
    readonly action: 'stop' | 'restart';
    readonly worktreeId: number;
    readonly commandName: string;
  }[];
}

/**
 * `suspended` is the ordinary case a switch produces. `removed` and `managed`
 * are the two ways a suspension stops being able to resolve itself. `diagnostic`
 * is the neighbouring state that is *not* a suspension: a running command whose
 * stop attempt failed.
 */
export type SuspensionScenario = 'suspended' | 'removed' | 'managed' | 'diagnostic';

const RUNTIME_ORIGIN = 'http://command-palette-fixture.invalid';

export function installFakeRuntime(): CommandPaletteRuntimeControls {
  const catalog = new Map<number, WorktreeCommandsOutput>(
    Object.entries(FIXTURE_CATALOG).map(([worktreeId, commands]) => [
      Number(worktreeId),
      configured(Number(worktreeId), commands),
    ]),
  );
  const commandsFetches: number[] = [];
  const runs: { readonly worktreeId: number; readonly commandName: string }[] = [];
  const actions: {
    readonly action: 'stop' | 'restart';
    readonly worktreeId: number;
    readonly commandName: string;
  }[] = [];
  const latestRuns = new Map<string, CommandLogMetadataLatestRun>();
  let workflows: readonly {
    readonly workflowKey: string;
    readonly manifest: WorkflowCommandManifestDto;
  }[] = [];
  let catalogUnavailable = false;
  let failNextRun = false;
  let runDelay = 0;

  window.isagi = { getRuntimeUrl: () => Promise.resolve(RUNTIME_ORIGIN) };
  const controls: CommandPaletteRuntimeControls = {
    setCatalog: (commands, worktreeId = FIXTURE_DEFAULT_WORKTREE) => {
      const current = catalog.get(worktreeId);
      catalog.set(
        worktreeId,
        configured(
          worktreeId,
          commands,
          current?.status === 'configured' ? current.removedCommands : [],
        ),
      );
    },
    setRemovedCommands: (commands, worktreeId = FIXTURE_DEFAULT_WORKTREE) => {
      const current = catalog.get(worktreeId);
      catalog.set(
        worktreeId,
        configured(worktreeId, current?.status === 'configured' ? current.commands : [], commands),
      );
    },
    breakConfig: (worktreeId = FIXTURE_DEFAULT_WORKTREE, managedCommands = []) => {
      catalog.set(worktreeId, {
        status: 'config_error',
        worktreeId,
        diagnostic: {
          code: 'command_config_invalid',
          path: '.isagi/config.yaml',
          message: 'commands.dev.run: expected a string, got a list',
        },
        managedCommands,
      });
    },
    setLatestRun: (commandName, latestRun) => {
      if (latestRun === null) {
        latestRuns.delete(commandName);
        return;
      }
      latestRuns.set(commandName, latestRun);
    },
    setCatalogUnavailable: (unavailable) => {
      catalogUnavailable = unavailable;
    },
    setWorkflows: (titles) => {
      workflows = titles.map((title, index) => ({
        workflowKey: `fixture/workflow-${index + 1}`,
        manifest: { title, description: 'a fixture workflow' },
      }));
    },
    failNextRun: () => {
      failNextRun = true;
    },
    setRunDelay: (ms) => {
      runDelay = ms;
    },
    commandsFetchCount: (worktreeId) =>
      worktreeId === undefined
        ? commandsFetches.length
        : commandsFetches.filter((id) => id === worktreeId).length,
    // Composed from the controls above rather than reaching past them, so there
    // is exactly one way to mutate each part of this world.
    applyScenario: (scenario) => {
      latestRuns.clear();
      if (scenario === 'managed') {
        controls.breakConfig(FIXTURE_DEFAULT_WORKTREE, FIXTURE_MANAGED_SUSPENDED);
        return;
      }
      if (scenario === 'removed') {
        controls.setCatalog(FIXTURE_SUSPENDED_COMMANDS.filter((c) => c.status === 'running'));
        controls.setRemovedCommands(FIXTURE_REMOVED_SUSPENDED);
        return;
      }
      controls.setRemovedCommands([]);
      controls.setCatalog(FIXTURE_SUSPENDED_COMMANDS);
      if (scenario === 'diagnostic') {
        controls.setLatestRun('api', FIXTURE_CONTROL_FAILED_RUN);
      }
    },
    runRequests: () => [...runs],
    actionRequests: () => [...actions],
  };

  const realFetch = window.fetch.bind(window);

  window.fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      window.location.origin,
    );
    if (url.origin !== RUNTIME_ORIGIN) return realFetch(input as RequestInfo, init);

    const method = init?.method ?? 'GET';
    const path = url.pathname.replace('/api/v1', '');

    if (method === 'GET' && path === '/workspace') return success(FIXTURE_SNAPSHOT);
    if (method === 'GET' && path === '/control-plane') return success(FIXTURE_CONTROL_PLANE);
    if (method === 'POST' && path === '/workflows/descriptors') {
      return success({ workflows: workflows.map((entry) => ({ ok: true, ...entry })) });
    }

    const surface = /^\/surfaces\/(\d+)$/.exec(path);
    if (method === 'GET' && surface) {
      const detail = FIXTURE_SURFACE_DETAILS[Number(surface[1])];
      return detail
        ? success(detail)
        : failure(404, 'runtime_database_failed', 'No such surface in the fixture.', {
            operation: 'surfaces.get',
          });
    }

    const commands = /^\/worktrees\/(\d+)\/commands$/.exec(path);
    if (method === 'GET' && commands) {
      const worktreeId = Number(commands[1]);
      commandsFetches.push(worktreeId);
      if (catalogUnavailable) {
        return failure(
          500,
          'runtime_database_failed',
          'The fixture runtime cannot read commands.',
          {
            operation: 'commands.listForWorktree',
          },
        );
      }
      return success(catalog.get(worktreeId) ?? configured(worktreeId, []));
    }

    const logMetadata = /^\/worktrees\/(\d+)\/commands\/log-metadata$/.exec(path);
    if (method === 'GET' && logMetadata) {
      const worktreeId = Number(logMetadata[1]);
      const commandName = url.searchParams.get('commandName') ?? '';
      return success({
        worktreeId,
        commandName,
        status: summaryFor(catalog.get(worktreeId), commandName)?.status ?? 'idle',
        // No run history by default: `CommandDetail` renders its idle state, which
        // keeps the fixture free of a log stream and its WebSocket. A test that
        // needs the diagnostic path seeds one run through `setLatestRun`.
        latestRun: latestRuns.get(commandName) ?? null,
      });
    }

    const run = /^\/worktrees\/(\d+)\/commands\/run$/.exec(path);
    if (method === 'POST' && run) {
      const worktreeId = Number(run[1]);
      const body = JSON.parse(String(init?.body ?? '{}')) as { commandName?: string };
      const commandName = body.commandName ?? '';
      runs.push({ worktreeId, commandName });

      if (runDelay > 0) await delay(runDelay);
      if (failNextRun) {
        failNextRun = false;
        // A real refusal envelope, so the web layer decodes it as a typed
        // rejection and renders its own copy rather than a generic transport
        // failure. `command_action_failed` is the 500-status reason the contract
        // reserves for a launch that did not go through.
        return failure(500, 'worktree_commands_rejected', 'The fixture runtime refused this run.', {
          reason: 'command_action_failed',
          worktreeId,
          commandName,
        });
      }

      return success({
        worktreeId,
        commandName,
        summary: applyStatus(catalog, worktreeId, commandName, 'running'),
      });
    }

    // Stop and restart converge the same way a run does. Stop is the affordance
    // this phase widened: on a suspended command it clears the resume intent and
    // the command becomes an ordinary `stopped`, with no process involved. A
    // fixture that only recorded the request would prove the client spoke and
    // nothing about whether the drawer then tells the truth.
    const action = /^\/worktrees\/(\d+)\/commands\/(stop|restart)$/.exec(path);
    if (method === 'POST' && action) {
      const worktreeId = Number(action[1]);
      const kind = action[2] === 'restart' ? 'restart' : 'stop';
      const body = JSON.parse(String(init?.body ?? '{}')) as { commandName?: string };
      const commandName = body.commandName ?? '';
      actions.push({ action: kind, worktreeId, commandName });

      if (runDelay > 0) await delay(runDelay);
      return success({
        worktreeId,
        commandName,
        summary: applyStatus(
          catalog,
          worktreeId,
          commandName,
          kind === 'restart' ? 'running' : 'stopped',
        ),
      });
    }

    // Loudly, not with a permissive catch-all: a route the fixture does not know
    // about means production started depending on something this page has never
    // stood up, and a bland success would hide that.
    console.error('[command-palette fixture] no route for', method, path);
    return failure(404, 'api_route_not_found', `No fixture route for ${method} ${path}`);
  };

  return controls;
}

/** The worktree the controls address unless told otherwise: the one the fixture opens on. */
const FIXTURE_DEFAULT_WORKTREE = 12;

function configured(
  worktreeId: number,
  commands: readonly CommandSummary[],
  removedCommands: readonly CommandSummary[] = [],
): WorktreeCommandsOutput {
  return { status: 'configured', worktreeId, commands, removedCommands };
}

/**
 * Move one command to a new status wherever it lives, and answer with the
 * summary the endpoint would have returned.
 *
 * Every list is searched, not just the configured one: a removed or managed
 * command is stoppable, so an action that only converged the configured half
 * would leave the drawer showing a suspended command that has already been
 * stopped — the exact stale-read failure this fixture exists to catch.
 */
function applyStatus(
  catalog: Map<number, WorktreeCommandsOutput>,
  worktreeId: number,
  commandName: string,
  status: CommandStatus,
): CommandSummary {
  const current = catalog.get(worktreeId);
  const existing = summaryFor(current, commandName);
  const summary: CommandSummary = { ...(existing ?? { name: commandName, ports: [] }), status };
  const replace = (commands: readonly CommandSummary[]) =>
    commands.map((command) => (command.name === commandName ? summary : command));

  if (current?.status === 'configured') {
    catalog.set(worktreeId, {
      ...current,
      commands: replace(current.commands),
      removedCommands: replace(current.removedCommands),
    });
  } else if (current?.status === 'config_error') {
    catalog.set(worktreeId, { ...current, managedCommands: replace(current.managedCommands) });
  }
  return summary;
}

function summaryFor(output: WorktreeCommandsOutput | undefined, commandName: string) {
  const pools =
    output?.status === 'configured'
      ? [output.commands, output.removedCommands]
      : output?.status === 'config_error'
        ? [output.managedCommands]
        : [];
  for (const pool of pools) {
    const found = pool.find((command) => command.name === commandName);
    if (found) return found;
  }
  return undefined;
}

function success(data: unknown) {
  return json(200, { data, meta: { requestId: 'command-palette-fixture' } });
}

function failure(status: number, code: string, message: string, data?: unknown) {
  return json(status, {
    error: {
      code,
      status,
      message,
      requestId: 'command-palette-fixture',
      ...(data ? { data } : {}),
    },
  });
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
