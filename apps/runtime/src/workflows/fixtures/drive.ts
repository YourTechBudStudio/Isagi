import { eq } from 'drizzle-orm';

import type { WorkflowUserInputAnswers, WorkflowWaitDto } from '@isagi/contracts';

import { workflowOperations, workflowRuns } from '../../persistence/schema.js';
import type { EngineHarness } from '../engine/test-support.js';

/**
 * Driving a fixture workflow to wherever it stops, by answering whatever the run waits on.
 *
 * The world is a set of answers keyed by what was asked: an agent turn is answered by the prompt
 * that started it, a headless job by its prompt, a user wait by the wait itself. Returning `'fail'`
 * for an agent turn fails that turn instead of ending it.
 */
export interface FixtureWorld {
  readonly reply?: (prompt: string) => string | 'fail';
  readonly judge?: (prompt: string) => { readonly output: string; readonly exitCode?: number };
  /** May first act as the person would, such as continuing an agent by hand. */
  readonly answer?: (
    wait: Extract<WorkflowWaitDto, { kind: 'user_continue' | 'user_input' }>,
  ) =>
    | WorkflowUserInputAnswers
    | undefined
    | 'leave'
    | Promise<WorkflowUserInputAnswers | undefined | 'leave'>;
}

export async function driveRun(
  harness: EngineHarness,
  runId: number,
  world: FixtureWorld,
  maxSteps = 100,
) {
  for (let step = 0; step < maxSteps; step += 1) {
    await harness.settle();
    const detail = await harness.run(harness.engine.getRun(runId));
    const current = detail.run.current;
    if (detail.run.status !== 'waiting' || !current?.wait) return detail.run;
    const wait = current.wait;
    switch (wait.kind) {
      case 'agent_turn': {
        const sent = harness.agents.prompts.find(
          (prompt) =>
            prompt.agentSessionId === wait.target.agentSessionId &&
            prompt.sentAt === wait.target.sentAt,
        );
        const reply = world.reply?.(sent?.prompt ?? '') ?? 'Done.';
        if (reply === 'fail') await harness.agents.failTurn(wait.target.agentSessionId);
        else await harness.agents.endTurn(wait.target.agentSessionId, reply);
        break;
      }
      case 'headless_agent': {
        for (const handle of wait.operations) {
          const operation = harness.db
            .select()
            .from(workflowOperations)
            .where(eq(workflowOperations.id, Number(handle.operationId)))
            .get();
          if (!operation || operation.status !== 'running') continue;
          const prompt = (JSON.parse(operation.requestJson) as { prompt: string }).prompt;
          const ptyProcessId = harness.headless.runningWithPrompt(prompt);
          const judged = world.judge?.(prompt) ?? { output: 'ok' };
          if (ptyProcessId !== null) {
            await harness.headless.finish(ptyProcessId, judged.output, judged.exitCode ?? 0);
          }
        }
        break;
      }
      case 'user_continue':
      case 'user_input': {
        const answers = await world.answer?.(wait);
        if (answers === 'leave') return detail.run;
        await harness.run(
          harness.engine.advance({ runId, executionId: current.executionId, answers }),
        );
        break;
      }
    }
  }
  throw new Error(`Run ${runId} did not stop within ${maxSteps} steps.`);
}

export function runStatus(harness: EngineHarness, runId: number) {
  return harness.db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).get()!.status;
}
