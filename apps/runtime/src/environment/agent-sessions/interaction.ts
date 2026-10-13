import { Context, Effect, Layer, type Scope } from 'effect';

import { FluidcastSessions, type FluidcastSessionId } from '../../fluidcast/index.js';

/** Which kind of controller an agent session is under. Absent from the map means terminal. */
export type AgentInteraction =
  | { readonly mode: 'terminal' }
  | { readonly mode: 'fluidcast'; readonly fluidcastSessionId: FluidcastSessionId };

/** The interaction joined with the Fluidcast session's execution, as status and observation read it. */
export type AgentControl =
  | { readonly mode: 'terminal' }
  | {
      readonly mode: 'fluidcast';
      readonly fluidcastSessionId: FluidcastSessionId;
      readonly since: string;
      readonly worker:
        | { readonly state: 'live' }
        | { readonly state: 'ended'; readonly reason: string };
    };

const terminal = { mode: 'terminal' } as const;

/** What a delete holds against new controllers: one worktree, or a whole project. */
export type DeletionScope = { readonly worktreeId: number } | { readonly projectId: number };

const scopeKey = (scope: DeletionScope) =>
  'worktreeId' in scope ? `worktree:${scope.worktreeId}` : `project:${scope.projectId}`;

/**
 * The agent sessions under Fluidcast control, and the deletion holds that refuse new controllers
 * to every agent of a worktree or project being deleted.
 *
 * In memory only, next to the persisted PTY pointer, which keeps pointing at the stopped PTY while
 * an agent is in Fluidcast mode: the interaction overrides it everywhere. A restart therefore
 * returns every agent to terminal mode.
 */
export class AgentSessionInteraction extends Context.Service<
  AgentSessionInteraction,
  {
    readonly get: (agentSessionId: number) => AgentInteraction;
    /** The interaction joined with `FluidcastSessions.execution`; a missing execution reads as ended. */
    readonly control: (agentSessionId: number) => AgentControl;
    readonly fluidcastAgentIds: () => ReadonlyArray<number>;
    /**
     * Mutations: `AgentSessionService` only, under the agent's entity lock. `since` is the start's,
     * kept so the control still has its interval start if the session is gone.
     */
    readonly set: (
      agentSessionId: number,
      started: { readonly fluidcastSessionId: FluidcastSessionId; readonly since: string },
    ) => void;
    readonly delete: (agentSessionId: number) => void;
    /** True while a delete holds the agent's worktree or its project. */
    readonly isHeldForDeletion: (owner: {
      readonly worktreeId: number;
      readonly projectId: number | null;
    }) => boolean;
    /**
     * Adds one token per agent for the calling scope; the scope's finalizer removes exactly those
     * tokens, so a failed delete never ends another delete's hold.
     */
    readonly holdForDeletion: (
      scopes: ReadonlyArray<DeletionScope>,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()('isagi/runtime/environment/AgentSessionInteraction') {
  static readonly layerNoDeps = Layer.effect(
    AgentSessionInteraction,
    Effect.gen(function* () {
      const fluidcast = yield* FluidcastSessions;
      const interactions = new Map<
        number,
        { readonly fluidcastSessionId: FluidcastSessionId; readonly since: string }
      >();
      const holds = new Map<string, Set<symbol>>();

      const releaseHold = (key: string, token: symbol) => {
        const tokens = holds.get(key);
        if (tokens === undefined) return;
        tokens.delete(token);
        if (tokens.size === 0) holds.delete(key);
      };

      return AgentSessionInteraction.of({
        get: (agentSessionId) => {
          const started = interactions.get(agentSessionId);
          return started === undefined
            ? terminal
            : { mode: 'fluidcast', fluidcastSessionId: started.fluidcastSessionId };
        },
        control: (agentSessionId) => {
          const started = interactions.get(agentSessionId);
          if (started === undefined) return terminal;
          const { fluidcastSessionId, since } = started;
          const execution = fluidcast.execution(fluidcastSessionId);
          return {
            mode: 'fluidcast',
            fluidcastSessionId,
            since,
            worker: execution?.worker ?? { state: 'ended', reason: 'session_missing' },
          };
        },
        fluidcastAgentIds: () => [...interactions.keys()],
        set: (agentSessionId, started) => {
          interactions.set(agentSessionId, started);
        },
        delete: (agentSessionId) => {
          interactions.delete(agentSessionId);
        },
        isHeldForDeletion: (owner) =>
          holds.has(scopeKey({ worktreeId: owner.worktreeId })) ||
          (owner.projectId !== null && holds.has(scopeKey({ projectId: owner.projectId }))),
        holdForDeletion: (scopes) =>
          Effect.acquireRelease(
            Effect.sync(() =>
              scopes.map((scope) => {
                const key = scopeKey(scope);
                const token = Symbol('deletion-hold');
                const tokens = holds.get(key) ?? new Set<symbol>();
                tokens.add(token);
                holds.set(key, tokens);
                return [key, token] as const;
              }),
            ),
            (taken) =>
              Effect.sync(() => {
                for (const [key, token] of taken) releaseHold(key, token);
              }),
          ).pipe(Effect.asVoid),
      });
    }),
  );
  static readonly layer = AgentSessionInteraction.layerNoDeps.pipe(
    Layer.provide(FluidcastSessions.layer),
  );
}
