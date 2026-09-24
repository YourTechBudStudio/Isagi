import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Effect } from 'effect';

import { DatabaseError } from '../../persistence/index.js';
import type { WorkflowOperationsRepositoryService } from '../persistence/operations.repository.js';
import type { WorkflowOperationRecord } from '../persistence/records.js';
import { resolveEvidenceSource } from './source.js';

const record = (overrides: Partial<WorkflowOperationRecord> = {}) =>
  ({ id: 11, runId: 1, capability: 'run_headless_agent', ...overrides }) as WorkflowOperationRecord;

/** Only the two reads `resolveEvidenceSource` makes; everything else would be unused ceremony. */
const repository = (reads: {
  findSubmission?: (input: {
    runId: number;
    agentSessionId: number;
    submissionWatermark?: string | undefined;
  }) => Effect.Effect<WorkflowOperationRecord | null, DatabaseError>;
  findByKey?: (key: string) => Effect.Effect<WorkflowOperationRecord | null, DatabaseError>;
}) =>
  ({
    findSubmission: reads.findSubmission ?? (() => Effect.succeed(null)),
    findByKey: reads.findByKey ?? (() => Effect.succeed(null)),
  }) as unknown as WorkflowOperationsRepositoryService;

const resolve = (
  repo: WorkflowOperationsRepositoryService,
  source: Parameters<typeof resolveEvidenceSource>[2],
) => Effect.runPromise(resolveEvidenceSource(repo, 1, source));

describe('evidence source resolution', () => {
  it('records nothing when the author named no source', async () => {
    assert.deepEqual(await resolve(repository({}), null), {
      kind: 'none',
      agentSessionId: null,
      operationId: null,
      attribution: 'none',
    });
  });

  it('resolves a turn by its watermark, exactly', async () => {
    let seen: unknown = null;
    const repo = repository({
      findSubmission: (input) => {
        seen = input;
        return Effect.succeed(record({ id: 7, capability: 'send_agent_prompt' }));
      },
    });
    assert.deepEqual(await resolve(repo, { kind: 'agent_turn', agentSessionId: 3, sentAt: 'w1' }), {
      kind: 'agent_turn',
      agentSessionId: 3,
      operationId: 7,
      attribution: 'exact',
    });
    // The watermark is what makes this "which submission was this turn" rather than "the latest".
    assert.deepEqual(seen, { runId: 1, agentSessionId: 3, submissionWatermark: 'w1' });
  });

  it('omits the watermark for a session, and says the answer was inferred', async () => {
    let seen: { submissionWatermark?: string | undefined } | null = null;
    const repo = repository({
      findSubmission: (input) => {
        seen = input;
        return Effect.succeed(record({ id: 9, capability: 'send_agent_prompt' }));
      },
    });
    assert.deepEqual(await resolve(repo, { kind: 'agent_session', agentSessionId: 4 }), {
      kind: 'agent_session',
      agentSessionId: 4,
      operationId: 9,
      attribution: 'inferred_latest_operation',
    });
    assert.equal(seen!.submissionWatermark, undefined);
  });

  it('resolves a headless handle only inside this run and only for a headless launch', async () => {
    const hit = repository({ findByKey: () => Effect.succeed(record()) });
    assert.deepEqual(await resolve(hit, { kind: 'headless_operation', operationId: 'wop_1' }), {
      kind: 'headless_operation',
      agentSessionId: null,
      operationId: 11,
      attribution: 'exact',
    });

    // A handle that leaked through state into another run must not attribute this run's evidence to
    // it. A confident wrong provenance is worse than an honest gap.
    const otherRun = repository({ findByKey: () => Effect.succeed(record({ runId: 2 })) });
    assert.equal(
      (await resolve(otherRun, { kind: 'headless_operation', operationId: 'wop_1' })).attribution,
      'unresolved',
    );

    const wrongCapability = repository({
      findByKey: () => Effect.succeed(record({ capability: 'close_pane' })),
    });
    assert.equal(
      (await resolve(wrongCapability, { kind: 'headless_operation', operationId: 'wop_1' }))
        .attribution,
      'unresolved',
    );
  });

  it('records a miss as unresolved, keeping the session the author named', async () => {
    const miss = repository({});
    assert.deepEqual(await resolve(miss, { kind: 'agent_turn', agentSessionId: 5, sentAt: 'w9' }), {
      kind: 'agent_turn',
      agentSessionId: 5,
      operationId: null,
      attribution: 'unresolved',
    });
  });

  it('degrades a database error to unresolved rather than failing the capture', async () => {
    const broken = repository({
      findSubmission: () =>
        Effect.fail(new DatabaseError({ operation: 'findSubmission', cause: new Error('gone') })),
    });
    const warnings: unknown[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args);
    try {
      // Attribution is a nicety; the evidence is the point. Failing the capture over it would lose
      // the thing worth keeping in order to protect a note about where it came from.
      assert.deepEqual(
        await resolve(broken, { kind: 'agent_turn', agentSessionId: 6, sentAt: 'w1' }),
        { kind: 'agent_turn', agentSessionId: 6, operationId: null, attribution: 'unresolved' },
      );
    } finally {
      console.warn = original;
    }
    // Warned rather than swallowed: a failing database is a fact about the runtime.
    assert.equal(warnings.length, 1);
  });
});
