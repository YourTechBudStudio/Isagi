import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  complete,
  createGraph,
  defineWorkflow,
  edge,
  eventGuards,
  operation,
  outcome,
  reduce,
  subgraph,
  suspend,
  wait,
  type AgentSessionHandle,
  type WorkflowInputs,
} from '@yourtechbudstudio/isagi-workflow-sdk';

import { latestAssistantText, OncePerRun } from '../authoring.js';

/**
 * Building a solution walkthrough, keeping every step that the original threw away.
 *
 * Adapted from the authored `solution-walkthrough-story`. That package mutates a single
 * `walkthrough.html` in place across sessions, regenerating and deleting its planning files when
 * validation fails, and preserves no intermediate state at all — so the question "what did the
 * fourth neighborhood actually produce?" has no answer a week later. It is the clearest example in
 * the repository of a flow that destroys exactly what story #45 exists to keep.
 *
 * What is preserved from it: planning files reused across runs, a **fresh** agent session per
 * neighborhood whose pane is closed when it is done, pure deterministic validation of what the
 * agent produced, and one assembled HTML presentation at the end. What is corrected: each of those
 * is now captured, so the mutable file on disk stops being the only record.
 *
 * Every file this reads or writes is author-owned Node IO under `ctx.worktreePath` — which is the
 * point. The runtime records nothing about those reads, so `captureEvidence` is the only thing that
 * makes any of it durable.
 */

/** Variant state that must misbehave exactly once per run. See `OncePerRun` for why it is keyed. */
const once = new OncePerRun();

/**
 * Clears the per-run variant state. **Required between tests, not hygiene.**
 *
 * Called by `publishSolutionWalkthrough`, so no test has to remember it. Each harness builds its own database
 * and run ids restart at `1`, so two tests reaching the same marker are both "run 1" against
 * one module-level map; without this, the second silently takes the already-used branch.
 */
export function resetSolutionWalkthroughState(): void {
  once.reset();
}

export interface SolutionWalkthroughVariant {
  /**
   * Overwrites and then deletes the assembled HTML after its capture returned.
   *
   * The source file is gone before the node even finishes, so anything a reader can still retrieve
   * came from the content store rather than from the worktree.
   */
  readonly mutateAfterCapture?: boolean | undefined;
  /**
   * Fails `assemble` once per run, after the capture and after the file is gone.
   *
   * The repaired callback must get its reference back without going near the filesystem — which is
   * only observable *because* the file it named no longer exists.
   */
  readonly failAfterCapture?: boolean | undefined;
}

// --- neighborhood -------------------------------------------------------------------------------

interface NeighborhoodState {
  readonly entry: string;
  readonly index: number;
  readonly builder: AgentSessionHandle | null;
  readonly pending: string | null;
}

export interface NeighborhoodParameters {
  readonly entry: string;
  readonly index: number;
}

export interface NeighborhoodOutput {
  readonly entry: string;
  readonly moments: number;
}

export function makeNeighborhoodGraph() {
  return createGraph<NeighborhoodState, {}, NeighborhoodParameters, NeighborhoodOutput>({
    key: 'neighborhood',
    title: 'Neighborhood',
    intent: 'operational',
    label: (parameters) => `neighborhood: ${parameters.entry}`,
    init: (_destination, parameters) => ({
      entry: parameters.entry,
      index: parameters.index,
      builder: null,
      pending: null,
    }),
    state: {
      entry: reduce.replace<string>(),
      index: reduce.replace<number>(),
      builder: reduce.replace<AgentSessionHandle | null>(),
      pending: reduce.replace<string | null>(),
    },
    entry: 'build',
    nodes: {
      build: operation(
        async (ctx, state) => {
          // A fresh session per neighborhood, exactly as the authored source does: nothing carries
          // over, so each one's output stands on its own.
          const builder = await ctx.spawnAgentSession({
            harness: 'claude',
            prompt: `Build the ${state.entry} neighborhood of the walkthrough.`,
          });
          return suspend({ update: { builder }, wait: wait.agentTurn(builder) });
        },
        { title: 'Build the neighborhood' },
      ),
      keepBuilder: operation(
        async (ctx, state) => {
          const builder = state.builder!;
          const history = await ctx.getConversationHistory(builder.agentSessionId);
          const response = latestAssistantText(history);
          await ctx.captureEvidence({
            title: `Builder response: ${state.entry}`,
            role: 'builder-response',
            labels: { neighborhood: state.entry, index: state.index },
            content: { kind: 'text', text: response },
            source: { kind: 'agent_turn', target: builder },
          });
          return complete({ update: { pending: response } });
        },
        { title: 'Keep the builder response' },
      ),
      validate: operation(
        async (ctx, state) => {
          // Pure, deterministic and computed over the same string that was just captured — so the
          // validation and the thing it validates are two records that can never disagree.
          const report = validateNeighborhood(state.entry, state.pending ?? '');
          await ctx.captureEvidence({
            title: `Validation: ${state.entry}`,
            role: 'validation',
            labels: { neighborhood: state.entry, index: state.index },
            content: { kind: 'json', value: report },
          });
          const builder = state.builder!;
          await ctx.closePane(builder.paneId);
          return complete({ update: { pending: null } });
        },
        { title: 'Validate and close the pane' },
      ),
    },
    edges: {
      'build-out': edge({
        from: 'build',
        to: ['keepBuilder', 'unavailable'],
        choose: (_state, event) =>
          eventGuards.isAgentTurn(event) && event.outcome === 'ended'
            ? { to: 'keepBuilder' }
            : { to: 'unavailable' },
      }),
      'keep-out': edge({
        from: 'keepBuilder',
        to: ['validate'],
        choose: () => ({ to: 'validate' }),
      }),
      'validate-out': edge({ from: 'validate', to: ['built'], choose: () => ({ to: 'built' }) }),
    },
    outcomes: {
      built: outcome({
        kind: 'success',
        output: (state) => ({ entry: state.entry, moments: state.index }),
      }),
      unavailable: outcome({
        kind: 'failure',
        reason: 'builder_unavailable',
        output: (state) => ({ entry: state.entry, moments: 0 }),
      }),
    },
  });
}

// --- walkthrough --------------------------------------------------------------------------------

interface WalkthroughState {
  readonly curriculumPath: string;
  readonly deckPlanPath: string;
  readonly outputPath: string;
  /** Planned neighborhood ids. Identifiers from the plan, not content the plan contained. */
  readonly entries: readonly string[];
  readonly entryIndex: number;
  readonly presentationEvidenceId: string | null;
}

export interface WalkthroughOutput {
  readonly neighborhoods: number;
  readonly presentationEvidenceId: string | null;
}

export function makeWalkthroughGraph(variant: SolutionWalkthroughVariant) {
  const NeighborhoodGraph = makeNeighborhoodGraph();
  return createGraph<
    WalkthroughState,
    { readonly entryIndex: number },
    WorkflowInputs,
    WalkthroughOutput
  >({
    key: 'walkthrough',
    title: 'Solution walkthrough',
    intent: 'business',
    init: (_destination, inputs) => ({
      curriculumPath: String(inputs.curriculumPath ?? 'plan/curriculum.json'),
      deckPlanPath: String(inputs.deckPlanPath ?? 'plan/deck-plan.json'),
      outputPath: String(inputs.outputPath ?? 'walkthrough.html'),
      entries: [],
      entryIndex: 0,
      presentationEvidenceId: null,
    }),
    state: {
      curriculumPath: reduce.replace<string>(),
      deckPlanPath: reduce.replace<string>(),
      outputPath: reduce.replace<string>(),
      entries: reduce.replace<readonly string[]>(),
      entryIndex: reduce.add(),
      presentationEvidenceId: reduce.replace<string | null>(),
    },
    entry: 'capturePlans',
    nodes: {
      capturePlans: operation(
        async (ctx, state) => {
          // Author-owned IO: the runtime records nothing about these reads, which is exactly why
          // the planning files have to be captured rather than merely referenced by path.
          const curriculum = readJson(ctx.worktreePath, state.curriculumPath);
          const deckPlan = readJson(ctx.worktreePath, state.deckPlanPath);
          await ctx.captureEvidence({
            title: 'Curriculum',
            role: 'curriculum',
            content: { kind: 'json', value: curriculum },
          });
          await ctx.captureEvidence({
            title: 'Deck plan',
            role: 'deck-plan',
            content: { kind: 'json', value: deckPlan },
          });
          return complete({ update: { entries: plannedNeighborhoods(deckPlan) } });
        },
        { title: 'Capture the plans' },
      ),
      neighborhood: subgraph({
        graph: NeighborhoodGraph,
        title: 'Neighborhood',
        parameters: (parent: WalkthroughState): NeighborhoodParameters => ({
          entry: parent.entries[parent.entryIndex] ?? 'unplanned',
          index: parent.entryIndex + 1,
        }),
        onResult: () => ({ entryIndex: 1 }),
      }),
      assemble: operation(
        async (ctx, state) => {
          const html = renderPresentation(state.entries);
          const absolute = join(ctx.worktreePath, state.outputPath);
          // Written once per run, not once per entry. A repaired callback re-enters from the top,
          // and rewriting the file here would hand the reused capture a source to read — making
          // "reuse never touches the filesystem" unobservable, because a re-read would produce the
          // same bytes and the same digest. Skipping the write cannot change the call's identity:
          // a `file` capture is fingerprinted on `{kind, path}` and never on the bytes.
          if (once.firstTime('assemble-write', ctx.invocation.runId)) {
            writeFileSync(absolute, html, 'utf8');
          }

          const kept = await ctx.captureEvidence({
            title: 'The walkthrough',
            role: 'presentation',
            content: { kind: 'file', path: state.outputPath, mediaType: 'text/html' },
          });

          if (variant.mutateAfterCapture) {
            // What the authored source does every run, compressed into two lines: the one file is
            // rewritten and then goes away entirely. Nothing below should notice.
            writeFileSync(absolute, '<!doctype html><p>overwritten</p>', 'utf8');
            rmSync(absolute, { force: true });
          }
          if (variant.failAfterCapture) {
            once.failOnce('assemble', ctx.invocation.runId);
          }

          // Computed over the same string that was written and captured, never re-read from disk.
          await ctx.captureEvidence({
            title: 'Presentation metrics',
            role: 'metrics',
            content: { kind: 'json', value: presentationMetrics(state.entries, html) },
          });
          // A rendered cover, kept as raw bytes: a capture that is neither text nor a file on disk,
          // and the reason the content store had to stop being a JSON payload store.
          await ctx.captureEvidence({
            title: 'Cover image',
            role: 'cover',
            content: { kind: 'bytes', bytes: renderCover(state.entries), mediaType: 'image/png' },
          });
          return complete({ update: { presentationEvidenceId: kept.evidenceId } });
        },
        { title: 'Assemble the walkthrough' },
      ),
    },
    edges: {
      'plans-out': edge({
        from: 'capturePlans',
        to: ['neighborhood', 'assemble'],
        choose: (state) => (state.entries.length > 0 ? { to: 'neighborhood' } : { to: 'assemble' }),
      }),
      'neighborhood-out': edge({
        from: 'neighborhood',
        to: ['neighborhood', 'assemble', 'incomplete'],
        choose: (state, event) => {
          if (!eventGuards.isSubgraph(event)) return { to: 'incomplete' };
          if (event.result.outcomeKind === 'failure') return { to: 'incomplete' };
          return state.entryIndex >= state.entries.length
            ? { to: 'assemble' }
            : { to: 'neighborhood' };
        },
      }),
      'assemble-out': edge({
        from: 'assemble',
        to: ['published'],
        choose: () => ({ to: 'published' }),
      }),
    },
    outcomes: {
      published: outcome({
        kind: 'success',
        output: (state) => ({
          neighborhoods: state.entryIndex,
          presentationEvidenceId: state.presentationEvidenceId,
        }),
      }),
      incomplete: outcome({
        kind: 'failure',
        reason: 'neighborhood_incomplete',
        output: (state) => ({
          neighborhoods: state.entryIndex,
          presentationEvidenceId: state.presentationEvidenceId,
        }),
      }),
    },
  });
}

export function makeSolutionWalkthroughWorkflow(variant: SolutionWalkthroughVariant = {}) {
  return defineWorkflow({
    command: () => ({
      title: 'Solution walkthrough',
      description: 'Build a walkthrough neighborhood by neighborhood and keep what each produced.',
      inputs: [{ kind: 'text', key: 'deckPlanPath', label: 'Deck plan path' }],
    }),
    validate: (_origin, inputs) => {
      if (typeof inputs.deckPlanPath !== 'string' || inputs.deckPlanPath.length === 0) {
        throw new Error('A deck plan path is required.');
      }
    },
    graph: makeWalkthroughGraph(variant),
  });
}

export const solutionWalkthroughWorkflow = makeSolutionWalkthroughWorkflow();

// --- the pure parts -----------------------------------------------------------------------------

function readJson(worktreePath: string, relative: string): unknown {
  return JSON.parse(readFileSync(join(worktreePath, relative), 'utf8')) as unknown;
}

function plannedNeighborhoods(deckPlan: unknown): readonly string[] {
  const plan = deckPlan as { readonly neighborhoods?: readonly { readonly id?: unknown }[] };
  return (plan.neighborhoods ?? [])
    .map((entry) => entry.id)
    .filter((id): id is string => typeof id === 'string');
}

/** Deterministic, and deliberately dull: the point is that it is reproducible, not that it is clever. */
export function validateNeighborhood(entry: string, response: string) {
  return {
    entry,
    characters: response.length,
    mentionsEntry: response.toLowerCase().includes(entry.toLowerCase()),
  };
}

export function renderPresentation(entries: readonly string[]): string {
  const slides = entries
    .map((entry) => `  <section data-moment="${entry}"><h2>${entry}</h2></section>`)
    .join('\n');
  return `<!doctype html>\n<html>\n<body>\n${slides}\n</body>\n</html>\n`;
}

/**
 * A one-pixel PNG with the neighborhood count written into its trailing bytes.
 *
 * Not a real encoder — it only has to be bytes that are not text and not a file, and that differ
 * when the deck does, so a test can tell one run's cover from another's.
 */
export function renderCover(entries: readonly string[]): Uint8Array {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return new Uint8Array([...signature, entries.length]);
}

/**
 * The authored source's `validatePresentation`, reduced to what a fixture can honestly assert.
 *
 * Counts realized content moments in the rendered HTML and compares them with what was planned,
 * which is the one thing that flow computed and then let the next session overwrite.
 */
export function presentationMetrics(entries: readonly string[], html: string) {
  const realized = [...html.matchAll(/data-moment="([^"]+)"/g)].map((match) => match[1]!);
  return {
    planned: entries.length,
    realized: realized.length,
    missing: entries.filter((entry) => !realized.includes(entry)),
    bytes: Buffer.byteLength(html, 'utf8'),
  };
}
