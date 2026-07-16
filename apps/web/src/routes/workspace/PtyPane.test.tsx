import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';

import { paneHasSharedActions } from '../../lib/workspace/pane-session/presentation.js';
import { BlockedPanePrompt } from './BlockedPanePrompt.js';

describe('BlockedPanePrompt', () => {
  it('identifies the harness and renders exactly one close action', () => {
    const markup = renderToStaticMarkup(
      <BlockedPanePrompt harness="codex" reason="harness_disabled" onClose={() => undefined} />,
    );

    assert.match(markup, /Codex · Disabled/);
    assert.match(markup, />Close pane</);
    assert.equal(markup.match(/<button\b/g)?.length, 1);
    assert.doesNotMatch(markup, /Split pane|Delete pane|Check again|Retry|Resume|Start a fresh/);
    assert.equal(paneHasSharedActions('blocked'), false);
  });
});
