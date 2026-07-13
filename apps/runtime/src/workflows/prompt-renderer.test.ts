import assert from 'node:assert/strict';
import test from 'node:test';

import type { WorkflowPromptInput } from '@yourtechbudstudio/isagi-workflow-sdk';

import { renderWorkflowPrompt, WorkflowPromptInputError } from './prompt-renderer.js';

const render = (
  harness: 'pi' | 'opencode' | 'claude' | 'codex',
  promptInput: WorkflowPromptInput,
) => renderWorkflowPrompt({ harness, promptInput, operation: 'send_agent_prompt' });

test('renders harness-native skill and command tokens', () => {
  const cases = [
    ['pi', '/skill:isagi-docs', '/isagi-docs'],
    ['opencode', '/isagi-docs', '/isagi-docs'],
    ['claude', '/isagi-docs', '/isagi-docs'],
    ['codex', '$isagi-docs', '$isagi-docs'],
  ] as const;
  for (const [harness, skill, command] of cases) {
    assert.equal(render(harness, { modifiers: [{ kind: 'skill', name: 'isagi-docs' }] }), skill);
    assert.equal(
      render(harness, { modifiers: [{ kind: 'command', name: 'isagi-docs' }] }),
      command,
    );
  }
});

test('composes ordered skills and preserves a present prompt verbatim', () => {
  assert.equal(
    render('pi', {
      modifiers: [
        { kind: 'skill', name: 'plugin:first' },
        { kind: 'skill', name: 'second' },
      ],
      prompt: '  task\nnext  ',
    }),
    '/skill:plugin:first /skill:second   task\nnext  ',
  );
  assert.equal(render('codex', { prompt: '\t task  ' }), '\t task  ');
});

test('treats omitted modifiers as empty and whitespace-only prompts as absent', () => {
  assert.equal(render('opencode', { prompt: 'task' }), 'task');
  assert.equal(
    render('opencode', {
      modifiers: [{ kind: 'skill', name: 'review' }],
      prompt: ' \n\t ',
    }),
    '/review',
  );
});

test('accepts unknown modifier properties without changing known semantics', () => {
  assert.equal(
    render('claude', {
      modifiers: [{ kind: 'skill', name: 'review', future: true }] as never,
    }),
    '/review',
  );
});

test('reports only the three coarse validation reasons', () => {
  const cases: readonly [WorkflowPromptInput, WorkflowPromptInputError['reason']][] = [
    [{ prompt: 42 as never }, 'invalid_prompt'],
    [{ modifiers: 'review' as never }, 'invalid_modifier'],
    [{ modifiers: [undefined] as never }, 'invalid_modifier'],
    [{ modifiers: [{ kind: 'skill' }] as never }, 'invalid_modifier'],
    [{ modifiers: [{ kind: 'other', name: 'review' }] as never }, 'invalid_modifier'],
    [{ modifiers: [{ kind: 'skill', name: '' }] }, 'invalid_modifier'],
    [{ modifiers: [{ kind: 'skill', name: 'two words' }] }, 'invalid_modifier'],
    [{ modifiers: [{ kind: 'skill', name: 'zero\u200bwidth' }] }, 'invalid_modifier'],
    [{ modifiers: [{ kind: 'skill', name: 'bidi\u2066name' }] }, 'invalid_modifier'],
    [{ modifiers: [{ kind: 'skill', name: '/review' }] }, 'invalid_modifier'],
    [
      {
        modifiers: [
          { kind: 'command', name: 'review' },
          { kind: 'skill', name: 'typescript' },
        ] as never,
      },
      'invalid_modifier',
    ],
    [
      {
        modifiers: [
          { kind: 'command', name: 'review' },
          { kind: 'command', name: 'test' },
        ] as never,
      },
      'invalid_modifier',
    ],
    [{}, 'empty_input'],
    [{ modifiers: [], prompt: ' \n ' }, 'empty_input'],
  ];

  const sparse = new Array(1) as WorkflowPromptInput['modifiers'];
  const allCases: readonly [WorkflowPromptInput, WorkflowPromptInputError['reason']][] = [
    ...cases,
    [{ modifiers: sparse }, 'invalid_modifier'],
  ];
  for (const [promptInput, reason] of allCases) {
    assert.throws(
      () => render('pi', promptInput),
      (error) => {
        assert.ok(error instanceof WorkflowPromptInputError);
        assert.equal(error.reason, reason);
        assert.equal(error.harness, 'pi');
        assert.equal(error.operation, 'send_agent_prompt');
        return true;
      },
    );
  }
});

test('does not normalize author-controlled Unicode modifier names', () => {
  assert.equal(
    render('codex', { modifiers: [{ kind: 'skill', name: 'cafe\u0301' }] }),
    '$cafe\u0301',
  );
});
