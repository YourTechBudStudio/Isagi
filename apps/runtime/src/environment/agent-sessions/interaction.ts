import { Context, Effect, Layer, type Scope } from 'effect';

import type { FluidcastHandoffFailure } from '@isagi/contracts';

import { FluidcastSessions, type FluidcastSessionId } from '../../fluidcast/index.js';

/**
 * The interaction record's generation: it increases on every change of the record and never
 * repeats within one runtime. A restart starts every agent at 0.
 */
type Generation = { readonly generation: number };

/**
 * Which kind of controller an agent session is under. `fluidcast_failed` is a switch to Fluidcast
 * that began cleanup but left no Fluidcast session running.
 */
export type AgentInteraction = Generation &
  (
    | { readonly mode: 'terminal' }
    | { readonly mode: 'fluidcast'; readonly fluidcastSessionId: FluidcastSessionId }
    | { readonly mode: 'fluidcast_failed'; readonly failure: FluidcastHandoffFailure }
  );

/** The interaction joined with the Fluidcast session's execution, as status and observation read it. */
export type AgentControl = Generation &
  (
    | { readonly mode: 'terminal' }
    | {
        readonly mode: 'fluidcast';
        readonly fluidcastSessionId: FluidcastSessionId;
        readonly since: string;
        readonly worker:
          | { readonly state: 'live' }
          | { readonly state: 'ended'; readonly reason: string };
      }
    | { readonly mode: 'fluidcast_failed'; readonly failure: FluidcastHandoffFailure }
  );

type Entry =
  | {
      readonly mode: 'fluidcast';
      readonly fluidcastSessionId: FluidcastSessionId;
      readonly since: string;
    }
  | { readonly mode: 'fluidcast_failed'; readonly failure: FluidcastHandoffFailure };

/** What a delete holds against new controllers: one worktree, or a whole project. */
export type DeletionScope = { readonly worktreeId: number } | { readonly projectId: number };

const scopeKey = (scope: DeletionScope) =>
  'worktreeId' in scope ? `worktree:${scope.worktreeId}` : `project:${scope.projectId}`;

/**
 * The agent sessions under Fluidcast control or whose switch to Fluidcast failed, each agent's
 * interaction generation, and the deletion holds that refuse new controllers to every agent of a
 * worktree or project being deleted.
 *
 * In memory only, next to the persisted PTY pointer, which keeps pointing at the stopped PTY while
 * an agent is not in terminal mode: the interaction overrides it everywhere. A restart therefore
 * returns every agent to terminal mode at generation 0.
 */
export class AgentSessionInteraction extends Context.Service<
  AgentSessionInteraction,
  {
    readonly get: (agentSessionId: number) => AgentInteraction;
    /** The interaction joined with `FluidcastSessions.execution`; a missing execution reads as ended. */
    readonly control: (agentSessionId: number) => AgentControl;
    /** The agents in `fluidcast` mode; a failed switch has no SDK execution to tail. */
    readonly fluidcastAgentIds: () => ReadonlyArray<number>;
    /**
     * Mutations: `AgentSessionService` only, under the agent's entity lock. Each one that changes
     * the record increases the generation and returns it. `since` is the start's, kept so the
     * control still has its interval start if the session is gone.
     */
    readonly setFluidcast: (
      agentSessionId: number,
      started: { readonly fluidcastSessionId: FluidcastSessionId; readonly since: string },
    ) => number;
    /** Records a failed switch to Fluidcast, replacing any earlier failure. */
    readonly setFailed: (agentSessionId: number, failure: FluidcastHandoffFailure) => number;
    /** Returns the agent to terminal mode; a no-op, keeping the generation, when it already is. */
    readonly setTerminal: (agentSessionId: number) => void;
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
      // Absent from `entries` means terminal. Generations are never deleted, so a value never
      // repeats within one runtime.
      const entries = new Map<number, Entry>();
      const generations = new Map<number, number>();
      const generationOf = (agentSessionId: number) => generations.get(agentSessionId) ?? 0;
      const advance = (agentSessionId: number) => {
        const generation = generationOf(agentSessionId) + 1;
        generations.set(agentSessionId, generation);
        return generation;
      };
      const holds = new Map<string, Set<symbol>>();

      const releaseHold = (key: string, token: symbol) => {
        const tokens = holds.get(key);
        if (tokens === undefined) return;
        tokens.delete(token);
        if (tokens.size === 0) holds.delete(key);
      };

      return AgentSessionInteraction.of({
        get: (agentSessionId) => {
          const generation = generationOf(agentSessionId);
          const entry = entries.get(agentSessionId);
          if (entry === undefined) return { mode: 'terminal', generation };
          return entry.mode === 'fluidcast'
            ? { mode: 'fluidcast', generation, fluidcastSessionId: entry.fluidcastSessionId }
            : { mode: 'fluidcast_failed', generation, failure: entry.failure };
        },
        control: (agentSessionId) => {
          const generation = generationOf(agentSessionId);
          const entry = entries.get(agentSessionId);
          if (entry === undefined) return { mode: 'terminal', generation };
          if (entry.mode === 'fluidcast_failed')
            return { mode: 'fluidcast_failed', generation, failure: entry.failure };
          const { fluidcastSessionId, since } = entry;
          const execution = fluidcast.execution(fluidcastSessionId);
          return {
            mode: 'fluidcast',
            generation,
            fluidcastSessionId,
            since,
            worker: execution?.worker ?? { state: 'ended', reason: 'session_missing' },
          };
        },
        fluidcastAgentIds: () =>
          [...entries].flatMap(([agentSessionId, entry]) =>
            entry.mode === 'fluidcast' ? [agentSessionId] : [],
          ),
        setFluidcast: (agentSessionId, started) => {
          entries.set(agentSessionId, { mode: 'fluidcast', ...started });
          return advance(agentSessionId);
        },
        setFailed: (agentSessionId, failure) => {
          entries.set(agentSessionId, { mode: 'fluidcast_failed', failure });
          return advance(agentSessionId);
        },
        setTerminal: (agentSessionId) => {
          if (entries.delete(agentSessionId)) advance(agentSessionId);
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
