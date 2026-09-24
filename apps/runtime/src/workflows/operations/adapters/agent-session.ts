/**
 * The real agent-session adapter: owner calls only.
 *
 * Every timing constant, the observer-initialization wait, the startup-output wait, the settle
 * window, the quiescence guard and the bracketed-paste submit sequence are carried over unchanged
 * from the capability implementation this replaces. They are load-bearing against real harness TUIs
 * and this phase deliberately changes none of them; what changed is that a durable marker now
 * brackets the write rather than following it.
 */

import { statSync } from 'node:fs';

import { Effect } from 'effect';

import type { SurfaceLayoutNode, SplitPaneDirection } from '@isagi/contracts';

import { getConversationHistory as readConversationHistory } from '../../../agent-sessions/harness/conversation.js';
import type { AgentSessionArtifactsService } from '../../../agent-sessions/harness/ledger.js';
import {
  HarnessLedgerObserver,
  type HarnessLedgerObserverService,
} from '../../../agent-sessions/harness/observer.service.js';
import type { AgentSessionService as AgentSessionServiceShape } from '../../../agent-sessions/index.js';
import { diagnosticPhase } from '../../../diagnostics/phase.js';
import type { PtyServiceShape } from '../../../pty-processes/index.js';
import type { SurfaceServiceShape } from '../../../surfaces/index.js';
import { hasInFlightTurn, type WorkflowObservedTurnEdge } from '../../waits/conditions.js';
import type { AgentSessionOperationAdapter } from './types.js';

export const spawnTimeoutMs = 10_000;
const metadataInitialDelayMs = 100;
const metadataMaxDelayMs = 1_000;
// Seed-prompt timing uses fixed delays rather than waiting for the TUI to quiesce.
// Animated harness TUIs (spinners, status lines) never go quiet, so a quiescence
// wait either stalled the dispatcher or burned the whole spawn timeout. Instead we
// wait for the first startup output, let the TUI settle for a fixed window, send
// the seed, then submit. The path is backstopped: awaitSeedAcknowledgement re-sends
// Enter and times out into a visible failure if the harness never accepts the
// seed, so a too-early submit fails loudly instead of silently mis-seeding.
const startupPollMs = 100; // Poll interval while waiting for the first PTY output.
const startupSettleMs = 500; // Settle window once the first output appears.
const spawnSeedPromptDelayMs = 500; // Further settle after startup output, before the seed.
const promptSubmitDelayMs = 250; // Gap between the bracketed paste and the submit Enter.
const submitRetryIntervalMs = 1_500;
const submitRetryLimit = 2;

export interface AgentSessionAdapterDependencies {
  readonly agents: AgentSessionServiceShape;
  readonly surfaces: SurfaceServiceShape;
  readonly pty: PtyServiceShape;
  readonly artifacts: AgentSessionArtifactsService;
  readonly observer: HarnessLedgerObserverService;
}

export function makeAgentSessionAdapter(
  dependencies: AgentSessionAdapterDependencies,
): AgentSessionOperationAdapter {
  const { agents, surfaces, pty, artifacts, observer } = dependencies;

  const asError = <A>(effect: Effect.Effect<A, unknown>): Effect.Effect<A, Error> =>
    effect.pipe(
      Effect.mapError((cause) => (cause instanceof Error ? cause : new Error(String(cause)))),
    );

  return {
    prepareSend: (input) =>
      asError(
        Effect.gen(function* () {
          yield* agents.get(input.agentSessionId);
          yield* waitForObserverInitialization(observer, input.agentSessionId);
          if (yield* isTurnInFlight(observer, input.agentSessionId)) {
            return yield* Effect.fail(
              new Error(
                `Cannot send an agent prompt into session ${input.agentSessionId}: a turn is already in flight.`,
              ),
            );
          }
          const ptyProcessId = yield* agents.activePtyProcessId(input.agentSessionId);
          return { agentSessionId: input.agentSessionId, ptyProcessId };
        }),
      ),

    createKeyedSession: (input) =>
      asError(
        Effect.gen(function* () {
          const phaseContext = { surfaceId: input.surfaceId, harness: input.harness };
          const surface = yield* diagnosticPhase(
            'workflow.spawn.get_surface',
            phaseContext,
            surfaces.getSurfaceDetail(input.surfaceId),
          );
          const split = chooseSpawnSplit(surface.layout);
          yield* diagnosticPhase(
            'workflow.spawn.split_pane',
            { ...phaseContext, sourcePaneId: split.sourcePaneId, direction: split.direction },
            surfaces.splitPane({
              worktreeId: input.worktreeId,
              split: {
                paneId: split.sourcePaneId,
                direction: split.direction,
                newPane: { kind: 'agent_session', harness: input.harness },
              },
              creationKey: input.creationKey,
            }),
          );
          // Read back through the key rather than through the returned layout: the key is what names
          // this compound, and a re-entered call that adopted an existing pane must resolve to the
          // same session the first call created.
          const keyed = yield* surfaces.findByCreationKey(input.creationKey);
          if (keyed.kind !== 'complete') {
            return yield* Effect.fail(
              new Error(
                `Keyed agent session ${input.creationKey} resolved to "${keyed.kind}" after a completed split.`,
              ),
            );
          }
          return {
            surfaceId: keyed.surfaceId,
            paneId: keyed.paneId,
            agentSessionId: keyed.session.sessionId,
          };
        }),
      ),

    prepareSeed: (input) =>
      asError(
        Effect.gen(function* () {
          const sessionContext = { agentSessionId: input.agentSessionId };
          const ptyProcessId = yield* diagnosticPhase(
            'workflow.spawn.ensure_pty',
            sessionContext,
            agents
              .ensureActivePtyProcess(input.agentSessionId, {
                model: input.model,
                effort: input.effort,
              })
              .pipe(
                Effect.timeoutFail({
                  duration: `${spawnTimeoutMs} millis`,
                  onTimeout: () =>
                    new Error(
                      `Timed out waiting for workflow agent session ${input.agentSessionId} PTY to become live.`,
                    ),
                }),
              ),
          );
          yield* waitForObserverInitialization(observer, input.agentSessionId);
          yield* diagnosticPhase(
            'workflow.spawn.await_startup_output',
            { ...sessionContext, ptyProcessId },
            waitForPtyStartupOutput(pty, ptyProcessId).pipe(
              Effect.timeoutFail({
                duration: `${spawnTimeoutMs} millis`,
                onTimeout: () =>
                  new Error(
                    `Timed out waiting for workflow agent session ${input.agentSessionId} PTY startup output.`,
                  ),
              }),
            ),
          );
          // Fixed settle window before the seed prompt — see the seed-timing note above.
          yield* Effect.sleep(`${spawnSeedPromptDelayMs} millis`);
          if (yield* isTurnInFlight(observer, input.agentSessionId)) {
            return yield* Effect.fail(
              new Error(
                `Cannot seed agent session ${input.agentSessionId}: a turn is already in flight.`,
              ),
            );
          }
          return { agentSessionId: input.agentSessionId, ptyProcessId };
        }),
      ),

    submitPrompt: (input) =>
      asError(
        Effect.gen(function* () {
          const normalized = input.text.replace(/\r\n/g, '\n');
          yield* pty.writeInput({
            ptyProcessId: input.ptyProcessId,
            data: `\x1b[200~${normalized}\x1b[201~`,
          });
          yield* Effect.sleep(`${promptSubmitDelayMs} millis`);
          yield* pty.writeInput({ ptyProcessId: input.ptyProcessId, data: '\r' });
        }),
      ),

    awaitSeedAcknowledgement: (input) =>
      asError(
        diagnosticPhase(
          'workflow.spawn.await_harness_session_id',
          { agentSessionId: input.agentSessionId, ptyProcessId: input.ptyProcessId },
          waitForHarnessSessionId({ artifacts, pty, ...input }).pipe(
            Effect.timeoutFail({
              duration: `${spawnTimeoutMs} millis`,
              onTimeout: () =>
                new Error(
                  `Timed out waiting for workflow agent session ${input.agentSessionId} harness session id.`,
                ),
            }),
          ),
        ),
      ),

    sessionFacts: (agentSessionId) =>
      asError(
        Effect.map(agents.get(agentSessionId), (session) => ({
          harness: session.harness,
          cwd: session.cwd,
        })),
      ),

    turnEdges: (agentSessionId) =>
      asError(observer.getTurnEdges(agentSessionId)) as Effect.Effect<
        readonly WorkflowObservedTurnEdge[],
        Error
      >,

    conversationHistory: (agentSessionId, turn) =>
      asError(
        Effect.gen(function* () {
          const session = yield* agents.get(agentSessionId);
          const harnessSessionId = yield* harnessSessionIdForAgentSession(
            artifacts,
            agentSessionId,
          );
          return yield* readConversationHistory({ ...session, harnessSessionId }, turn).pipe(
            Effect.provideService(HarnessLedgerObserver, observer),
          );
        }),
      ),
  };
}

export function chooseSpawnSplit(layout: SurfaceLayoutNode): {
  readonly sourcePaneId: number;
  readonly direction: SplitPaneDirection;
} {
  if (layout.kind === 'leaf') {
    return { sourcePaneId: layout.paneId, direction: 'right' };
  }
  return { sourcePaneId: lastLeafPaneId(layout), direction: 'down' };
}

function lastLeafPaneId(layout: SurfaceLayoutNode): number {
  if (layout.kind === 'leaf') return layout.paneId;
  const last = layout.children.at(-1);
  if (!last) {
    throw new Error(`Cannot choose workflow spawn split from an empty layout split.`);
  }
  return lastLeafPaneId(last);
}

function harnessSessionIdForAgentSession(
  artifacts: AgentSessionArtifactsService,
  agentSessionId: number,
) {
  return artifacts.readMetadata(agentSessionId).pipe(
    Effect.flatMap((metadata) => {
      if (metadata.status === 'missing') {
        return Effect.fail(
          new Error(`Agent session ${agentSessionId} has no captured harness metadata yet.`),
        );
      }
      if (metadata.status === 'invalid') {
        return Effect.fail(
          new Error(
            `Agent session ${agentSessionId} has invalid harness metadata: ${metadata.diagnostic}`,
          ),
        );
      }
      if (!metadata.metadata.harnessSessionId) {
        return Effect.fail(
          new Error(
            `Agent session ${agentSessionId} does not have a captured harness session id yet.`,
          ),
        );
      }
      return Effect.succeed(metadata.metadata.harnessSessionId);
    }),
  );
}

function isTurnInFlight(observer: HarnessLedgerObserverService, agentSessionId: number) {
  return Effect.gen(function* () {
    const edges = yield* observer.getTurnEdges(agentSessionId);
    return hasInFlightTurn(edges);
  });
}

function waitForObserverInitialization(
  observer: HarnessLedgerObserverService,
  agentSessionId: number,
): Effect.Effect<void, unknown, never> {
  return Effect.gen(function* () {
    if ((yield* observer.getProjection(agentSessionId)) !== undefined) return;
    yield* Effect.sleep(`${startupPollMs} millis`);
    return yield* waitForObserverInitialization(observer, agentSessionId);
  });
}

function waitForPtyStartupOutput(
  pty: PtyServiceShape,
  ptyProcessId: number,
): Effect.Effect<void, unknown, never> {
  return Effect.gen(function* () {
    const bytes = yield* ptyOutputBytes(pty, ptyProcessId);
    if (bytes > 0) {
      yield* Effect.sleep(`${startupSettleMs} millis`);
      return;
    }
    yield* Effect.sleep(`${startupPollMs} millis`);
    return yield* waitForPtyStartupOutput(pty, ptyProcessId);
  });
}

function ptyOutputBytes(pty: PtyServiceShape, ptyProcessId: number) {
  return Effect.gen(function* () {
    const plan = yield* pty.getAttachmentPlan({ ptyProcessId });
    if (plan.session.logPath) {
      return yield* Effect.try({
        try: () => statSync(plan.session.logPath ?? '').size,
        catch: () => 0,
      });
    }
    return plan.replayBytes ?? 0;
  });
}

/**
 * Poll for the harness session id, re-sending the submit key within its existing bounds.
 *
 * The retries belong to this one live submission procedure and end with it. Recovery never reaches
 * this function: after a crash we cannot tell whether the prompt is sitting unsubmitted or was
 * submitted and produced no observable start, and a bare `\r` is a PTY write either way.
 */
function waitForHarnessSessionId(
  input: {
    readonly artifacts: AgentSessionArtifactsService;
    readonly pty: PtyServiceShape;
    readonly ptyProcessId: number;
    readonly agentSessionId: number;
  },
  delayMs = metadataInitialDelayMs,
  elapsedMs = 0,
  submitRetryCount = 0,
): Effect.Effect<string, unknown, never> {
  return Effect.gen(function* () {
    const metadata = yield* input.artifacts.readMetadata(input.agentSessionId);
    if (metadata.status === 'valid' && metadata.metadata.harnessSessionId) {
      return metadata.metadata.harnessSessionId;
    }
    yield* Effect.sleep(`${delayMs} millis`);
    const nextElapsedMs = elapsedMs + delayMs;
    const shouldRetrySubmit =
      submitRetryCount < submitRetryLimit &&
      nextElapsedMs >= (submitRetryCount + 1) * submitRetryIntervalMs;
    if (shouldRetrySubmit) {
      yield* input.pty.writeInput({ ptyProcessId: input.ptyProcessId, data: '\r' });
    }
    return yield* waitForHarnessSessionId(
      input,
      Math.min(delayMs * 2, metadataMaxDelayMs),
      nextElapsedMs,
      shouldRetrySubmit ? submitRetryCount + 1 : submitRetryCount,
    );
  });
}
