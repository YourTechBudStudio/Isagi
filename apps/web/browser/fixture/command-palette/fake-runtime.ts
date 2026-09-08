import type {
  CommandLogMetadataLatestRun,
  CommandStatus,
  CommandSummary,
  ProjectPathRejectionReason,
  WorkflowCommandManifestDto,
  WorkspaceSnapshot,
  WorktreeCommandsOutput,
} from '@isagi/contracts';

import { createResponseGate, FIXTURE_PATH_TREE, suggestFromTree } from './path-world.js';
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
 * In-memory runtime behind production components, clients, and query observers.
 * The fixture app publishes these controls on window.commandPaletteFixture.
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
  /** Delay command responses; path/project ordering uses the response gates instead. */
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

  // Request arrival, mutation, and client acknowledgement are separate observations.

  /** Replace the fake directory world. Paths are in runtime spelling; see {@link ./path-world}. */
  readonly setPathTree: (paths: readonly string[]) => void;
  /**
   * Hold suggestion responses instead of answering them.
   *
   * A held suggestion captures its result at arrival, so releasing it delivers what
   * the tree said *then*. That is what makes a reversed-response test meaningful:
   * the stale answer it means to exercise cannot be quietly recomputed into the
   * fresh one.
   */
  readonly holdPathSuggestions: (held: boolean) => void;
  /** Deliver one held suggestion by request id; `releasePathSuggestions()` delivers all. */
  readonly releasePathSuggestion: (id: number) => void;
  readonly releasePathSuggestions: () => void;
  /** Fail the next suggestion request at the transport level. */
  readonly failNextSuggestion: () => void;
  /** Ordered suggestion requests the endpoint received. */
  readonly pathSuggestionRequests: () => readonly PathSuggestionRequestRecord[];

  /**
   * Reject the next add or relocate with a structured `project_path_rejected`.
   * A rejected request applies no mutation and inserts nothing.
   */
  readonly rejectNextProject: (reason: ProjectPathRejectionReason) => void;
  /**
   * Hold project mutation responses. The mutation is still applied at arrival — the
   * client is waiting for an acknowledgement of something that has already happened,
   * which is exactly the busy window a real slow runtime produces.
   */
  readonly holdProjectMutations: (held: boolean) => void;
  readonly releaseProjectMutation: (id: number) => void;
  readonly releaseProjectMutations: () => void;
  /** Ordered add requests, each carrying what it actually did. */
  readonly projectAddRequests: () => readonly ProjectAddRequestRecord[];
  /** Ordered relocate requests, kept apart from adds because they target a project. */
  readonly projectRelocateRequests: () => readonly ProjectRelocateRequestRecord[];
  /** The fixture runtime's current project list — the server-owned mutation record. */
  readonly fixtureProjects: () => readonly FixtureProject[];
  /**
   * How many workspace reads the endpoint has served.
   *
   * Reading {@link fixtureProjects} alone proves the fixture changed, not that the
   * client ever went back and looked. Counting the reads is what makes an
   * invalidation that stopped happening observable.
   */
  readonly workspaceFetchCount: () => number;
}

export interface PathSuggestionRequestRecord {
  readonly id: number;
  readonly input: string;
  readonly limit: number | undefined;
}

/**
 * What an add request actually did, named rather than inferred from a flag.
 *
 * A boolean cannot carry this. Reuse answers *successfully* and leaves the project
 * list *untouched*, so "did it succeed" and "did the world change" are different
 * questions with different answers. Collapsing them made exactly-once assertions
 * read as though they counted insertions when they counted successful responses.
 */
export type ProjectAddOutcome =
  /** Validation refused it: no mutation, nothing inserted. */
  | 'rejected'
  /** A new project was inserted. */
  | 'inserted'
  /** The root was already registered: its id came back and nothing was inserted. */
  | 'reused';

export interface ProjectAddRequestRecord {
  readonly id: number;
  readonly path: string;
  readonly outcome: ProjectAddOutcome;
  /** The project it resolved to, or `null` when rejected. */
  readonly projectId: number | null;
}

export type ProjectRelocateOutcome = 'rejected' | 'relocated' | 'project_not_found';

export interface ProjectRelocateRequestRecord {
  readonly id: number;
  readonly projectId: number;
  readonly path: string;
  readonly outcome: ProjectRelocateOutcome;
}

export interface FixtureProject {
  readonly id: number;
  readonly name: string;
  readonly rootPath: string;
  readonly status: 'present' | 'missing';
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

  // Deep-copied, never the shared seed: two page loads in one browser session must
  // not inherit each other's registrations, and a spec that inserts a project must
  // not change what the next spec starts from.
  const projects: FixtureMutableProject[] = structuredClone(
    FIXTURE_SNAPSHOT.projects,
  ) as FixtureMutableProject[];
  let pathTree = FIXTURE_PATH_TREE;
  let failNextSuggestion = false;
  let rejectNextProjectReason: ProjectPathRejectionReason | null = null;
  let nextRequestId = 1;
  let nextProjectId = Math.max(0, ...projects.map((project) => project.id)) + 1;
  let nextWorktreeId = 9000;
  const suggestionGate = createResponseGate();
  const mutationGate = createResponseGate();
  const suggestionRequests: PathSuggestionRequestRecord[] = [];
  let workspaceFetches = 0;
  const addRequests: ProjectAddRequestRecord[] = [];
  const relocateRequests: ProjectRelocateRequestRecord[] = [];

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

    setPathTree: (paths) => {
      pathTree = [...paths];
    },
    holdPathSuggestions: (held) => {
      suggestionGate.hold(held);
    },
    releasePathSuggestion: (id) => {
      suggestionGate.release(id);
    },
    releasePathSuggestions: () => {
      suggestionGate.releaseAll();
    },
    failNextSuggestion: () => {
      failNextSuggestion = true;
    },
    pathSuggestionRequests: () => [...suggestionRequests],

    rejectNextProject: (reason) => {
      rejectNextProjectReason = reason;
    },
    holdProjectMutations: (held) => {
      mutationGate.hold(held);
    },
    releaseProjectMutation: (id) => {
      mutationGate.release(id);
    },
    releaseProjectMutations: () => {
      mutationGate.releaseAll();
    },
    projectAddRequests: () => [...addRequests],
    projectRelocateRequests: () => [...relocateRequests],
    workspaceFetchCount: () => workspaceFetches,
    fixtureProjects: () =>
      projects.map((project) => ({
        id: project.id,
        name: project.name,
        rootPath: project.rootPath,
        status: project.status,
      })),
  };

  /** One-shot, and shared by add and relocate: whichever mutation comes next is rejected. */
  function takeProjectRejection(): ProjectPathRejectionReason | null {
    const reason = rejectNextProjectReason;
    rejectNextProjectReason = null;
    return reason;
  }

  const realFetch = window.fetch.bind(window);

  window.fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      window.location.origin,
    );
    if (url.origin !== RUNTIME_ORIGIN) return realFetch(input as RequestInfo, init);

    const method = init?.method ?? 'GET';
    const path = url.pathname.replace('/api/v1', '');

    // Served from the mutable list, so a workspace read *after* a registration
    // converges on it. Palette closure alone would only prove the client stopped
    // waiting, not that anything was registered.
    if (method === 'GET' && path === '/workspace') {
      workspaceFetches += 1;
      return success({ projects });
    }
    if (method === 'GET' && path === '/control-plane') return success(FIXTURE_CONTROL_PLANE);

    // A successful add schedules this through `commitAddProjectSuccess`. Without
    // the route the fixture's deliberate no-route branch would log an error on
    // every successful registration and the reconcile would report a failure the
    // app never had. The fixture has nothing to reconcile, so: no findings.
    if (method === 'POST' && path === '/workspace/reconcile') return success({ findings: [] });

    if (method === 'POST' && path === '/paths/suggestions') {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        input?: string;
        limit?: number;
      };
      const id = nextRequestId++;
      // Named apart from the fetch stub's own `input` parameter, which is the URL.
      const suggestionInput = body.input ?? '';
      suggestionRequests.push({ id, input: suggestionInput, limit: body.limit });

      // The response is decided here, at arrival, and the gate only delays its
      // delivery. A later `setPathTree` therefore cannot rewrite an answer that has
      // already been given — which is the whole point when a test is proving that a
      // stale response cannot overwrite a fresher one.
      if (failNextSuggestion) {
        failNextSuggestion = false;
        return suggestionGate.arrive(id, () =>
          failure(500, 'runtime_state_file_failed', 'The fixture runtime cannot list paths.', {
            operation: 'paths.suggestions',
          }),
        );
      }
      const output = suggestFromTree(pathTree, suggestionInput, body.limit);
      return suggestionGate.arrive(id, () => success(output));
    }

    if (method === 'POST' && path === '/projects') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { path?: string };
      const id = nextRequestId++;
      const requestedPath = body.path ?? '';

      const rejection = takeProjectRejection();
      if (rejection) {
        addRequests.push({ id, path: requestedPath, outcome: 'rejected', projectId: null });
        return mutationGate.arrive(id, () => projectPathRejection(rejection, requestedPath));
      }

      // Applied now, acknowledged later. Reuse is a real runtime behaviour and is
      // modelled as one: an already-registered root answers with its existing id
      // and inserts nothing, so a duplicate submission is invisible in the project
      // list and visible only in this request log.
      const existing = projects.find((project) => project.rootPath === requestedPath);
      const projectId = existing?.id ?? nextProjectId++;
      if (!existing) {
        projects.push(registeredProject(projectId, requestedPath, nextWorktreeId++));
      }
      addRequests.push({
        id,
        path: requestedPath,
        outcome: existing ? 'reused' : 'inserted',
        projectId,
      });
      return mutationGate.arrive(id, () =>
        success({ projectId, alreadyExisted: existing !== undefined }),
      );
    }

    const relocate = /^\/projects\/(\d+)\/relocate$/.exec(path);
    if (method === 'POST' && relocate) {
      const projectId = Number(relocate[1]);
      const body = JSON.parse(String(init?.body ?? '{}')) as { path?: string };
      const id = nextRequestId++;
      const requestedPath = body.path ?? '';

      const rejection = takeProjectRejection();
      if (rejection) {
        relocateRequests.push({ id, projectId, path: requestedPath, outcome: 'rejected' });
        return mutationGate.arrive(id, () => projectPathRejection(rejection, requestedPath));
      }

      // Relocation moves an existing project. Inserting one here instead would let
      // a spec pass while the palette registered a *new* project under the guise of
      // fixing a missing one — the exact confusion this route exists to rule out.
      const index = projects.findIndex((project) => project.id === projectId);
      if (index === -1) {
        relocateRequests.push({
          id,
          projectId,
          path: requestedPath,
          outcome: 'project_not_found',
        });
        return mutationGate.arrive(id, () =>
          failure(400, 'project_relocation_rejected', 'No such project in the fixture.', {
            reason: 'project_not_found',
            projectId,
          }),
        );
      }
      const current = projects[index]!;
      projects[index] = {
        id: current.id,
        name: current.name,
        rootPath: requestedPath,
        status: 'present',
        worktrees: current.worktrees,
      };
      relocateRequests.push({ id, projectId, path: requestedPath, outcome: 'relocated' });
      return mutationGate.arrive(id, () => success({ projectId, findings: [] }));
    }
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

    // Apply status changes so subsequent reads expose the mutation to the client.
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

/** The snapshot's project variant, mutable so registration and relocation can change it. */
type FixtureMutableProject = WorkspaceSnapshot['projects'][number];

/**
 * A newly registered project, as the runtime would report it on the next read: the
 * last path segment for a name, and a root worktree, because a project with no
 * worktrees at all is not a shape the workspace ever produces.
 */
function registeredProject(
  projectId: number,
  rootPath: string,
  worktreeId: number,
): FixtureMutableProject {
  return {
    id: projectId,
    name: rootPath.split('/').filter(Boolean).at(-1) ?? rootPath,
    rootPath,
    status: 'present',
    worktrees: [
      {
        id: worktreeId,
        projectId,
        title: 'main',
        path: rootPath,
        branch: 'main',
        head: 'abc1234',
        isRoot: true,
        parked: false,
        surfaces: [],
        activeSurfaceId: null,
      },
    ],
  };
}

/**
 * The real 400 the runtime returns when `validateProjectRoot` refuses a path. The
 * web decodes this into its own copy from `apps/web/src/copy/errors.ts`; the
 * fixture supplies only the code and reason, never a user-facing sentence.
 *
 * A fake rejection proves the *frontend's* handling of one. It proves nothing about
 * when or in what order the runtime actually validates — that lives in
 * `WorkspaceService.registerProject` and its own tests.
 */
function projectPathRejection(reason: ProjectPathRejectionReason, path: string) {
  return failure(400, 'project_path_rejected', 'The fixture runtime refused this path.', {
    reason,
    path,
  });
}

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
