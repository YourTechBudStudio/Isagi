import type {
  CommandSummary,
  WorkflowCommandManifestDto,
  WorktreeCommandsOutput,
} from '@isagi/contracts';

import {
  FIXTURE_CATALOG,
  FIXTURE_CONTROL_PLANE,
  FIXTURE_SNAPSHOT,
  FIXTURE_SURFACE_DETAILS,
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
  /** Serve a `config_error` catalog for a worktree, with its diagnostic. */
  readonly breakConfig: (worktreeId?: number) => void;
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
}

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
      catalog.set(worktreeId, configured(worktreeId, commands));
    },
    breakConfig: (worktreeId = FIXTURE_DEFAULT_WORKTREE) => {
      catalog.set(worktreeId, {
        status: 'config_error',
        worktreeId,
        diagnostic: {
          code: 'command_config_invalid',
          path: '.isagi/config.yaml',
          message: 'commands.dev.run: expected a string, got a list',
        },
        managedCommands: [],
      });
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
    runRequests: () => [...runs],
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
        // No run history: `CommandDetail` renders its idle state, which keeps the
        // fixture free of a log stream and its WebSocket.
        latestRun: null,
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

      const current = catalog.get(worktreeId);
      const summary: CommandSummary = { name: commandName, status: 'running', ports: [] };
      if (current?.status === 'configured') {
        catalog.set(worktreeId, {
          ...current,
          commands: current.commands.map((command) =>
            command.name === commandName ? summary : command,
          ),
        });
      }
      return success({ worktreeId, commandName, summary });
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
): WorktreeCommandsOutput {
  return { status: 'configured', worktreeId, commands, removedCommands: [] };
}

function summaryFor(output: WorktreeCommandsOutput | undefined, commandName: string) {
  return output?.status === 'configured'
    ? output.commands.find((command) => command.name === commandName)
    : undefined;
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
