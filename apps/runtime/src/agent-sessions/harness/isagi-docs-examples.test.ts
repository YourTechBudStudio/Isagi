import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import type {
  AgentTurnTarget,
  OperationContext,
  OperationNode,
  WorkflowConversationMessage,
} from '@yourtechbudstudio/isagi-workflow-sdk';

import { isagiDocsPackageFiles } from './isagi-docs.js';

test('generated skill TypeScript examples compile against the public SDK', () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-docs-examples-'));
  try {
    // Resolve through the runtime's installed dependencies, just as a consumer package would.
    symlinkSync(
      fileURLToPath(new URL('../../../node_modules', import.meta.url)),
      join(root, 'node_modules'),
      'dir',
    );
    writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
    writeFileSync(
      join(root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2024',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          types: ['node'],
        },
        include: ['*.ts'],
      }),
    );
    const examples: string[] = [];
    for (const [path, source] of isagiDocsPackageFiles('/example/isagi')) {
      if (!path.endsWith('.md')) continue;
      let index = 0;
      for (const match of source.matchAll(/^```(?:ts|typescript)\r?\n([\s\S]*?)^```\s*$/gm)) {
        const name = `${path.replaceAll('/', '-').replace(/\.md$/, '')}-${++index}.ts`;
        examples.push(name);
        // Each fence is a separate module, so repeated example-local type names cannot collide.
        writeFileSync(join(root, name), `${match[1]}\nexport {};\n`);
      }
    }
    assert.ok(examples.length > 0, 'expected TypeScript examples in the generated skill');
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('./bin/tsc', import.meta.resolve('typescript/package.json'))),
        '--project',
        join(root, 'tsconfig.json'),
      ],
      { encoding: 'utf8', timeout: 60_000 },
    );
    assert.ifError(result.error);
    assert.equal(
      result.status,
      0,
      `Skill examples failed typechecking:\n${result.stdout}\n${result.stderr}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('evidence recipe judges the saved response after capture and judgment retries', async () => {
  const source = isagiDocsPackageFiles('/example/isagi').get('references/workflow-evidence.md')!;
  const example = /^```ts\n([\s\S]*?)^```/m.exec(source)?.[1];
  assert.ok(example, 'missing evidence recipe');
  const sdk = '@yourtechbudstudio/isagi-workflow-sdk';
  const javascript = stripTypeScriptTypes(example).replaceAll(
    `'${sdk}'`,
    JSON.stringify(import.meta.resolve(sdk)),
  );
  type State = {
    reviewer: AgentTurnTarget;
    round: number;
    pending: string | null;
    evidenceId: string | null;
  };
  const { reviewSteps } = (await import(
    `data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`
  )) as {
    reviewSteps: (
      select: (messages: readonly WorkflowConversationMessage[]) => string,
    ) => Record<'observe' | 'capture' | 'judge', OperationNode<State, State>>;
  };
  const steps = reviewSteps((messages) => messages[0]!.parts[0]!.text);
  let response = 'original review';
  let reads = 0;
  let captured: string | undefined;
  let prompt: string | undefined;
  const ctx = {
    getConversationHistory: async () => {
      reads += 1;
      return [{ role: 'assistant', parts: [{ type: 'text', text: response, state: 'done' }] }];
    },
    captureEvidence: async (input) => {
      assert.equal(input.content.kind, 'text');
      if (input.content.kind !== 'text') throw new Error('Expected text');
      if (captured === undefined) {
        captured = input.content.text;
        throw new Error('Interrupted after capture committed');
      }
      assert.equal(input.content.text, captured);
      return { evidenceId: 'saved-evidence' };
    },
    runHeadlessAgent: async (input) => {
      if (prompt === undefined) {
        prompt = input.prompt;
        throw new Error('Interrupted after judgment submitted');
      }
      assert.equal(input.prompt, prompt);
      return { operationId: 'saved-judgment' };
    },
  } satisfies Partial<OperationContext>;
  let state: State = {
    reviewer: { agentSessionId: 1, sentAt: '2026-09-26T00:00:00.000Z' },
    round: 1,
    pending: null,
    evidenceId: null,
  };
  const run = async (node: OperationNode<State, State>) => {
    const result = await node.run(ctx as unknown as OperationContext, state);
    state = { ...state, ...result.update };
    return result;
  };
  await run(steps.observe);
  await assert.rejects(run(steps.capture), /Interrupted after capture/);
  response = 'newer review';
  await run(steps.capture);
  await assert.rejects(run(steps.judge), /Interrupted after judgment/);
  const result = await run(steps.judge);
  assert.equal(reads, 1, 'capture and judgment must not reread the conversation');
  assert.equal(captured, 'original review');
  assert.equal(prompt, `Does this review approve the work?\n\n${captured}`);
  assert.equal(state.evidenceId, 'saved-evidence');
  assert.equal(state.pending, null);
  assert.equal(result.type, 'suspend');
});
