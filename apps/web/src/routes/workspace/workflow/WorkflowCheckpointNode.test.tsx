import assert from 'node:assert/strict';
import test from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';

import { inspectorCopy } from './copy.js';
import { CheckpointKindTag } from './WorkflowCheckpointNode.js';

test('the checkpoint kind tag is the cyan uppercase word', () => {
  const markup = renderToStaticMarkup(<CheckpointKindTag />);
  assert.match(markup, /text-cyan/);
  assert.match(markup, new RegExp(`>${inspectorCopy.checkpointKind}<`));
});
