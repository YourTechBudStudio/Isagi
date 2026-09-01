import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { worktreeMenuCommandIds } from './worktree-menu.js';

describe('worktree rail context menu', () => {
  it('offers Open editor alongside the session actions when the runtime supports it', () => {
    assert.deepEqual(worktreeMenuCommandIds({ editorAvailable: true, isRoot: false }), [
      'start-terminal-session',
      'start-agent-session',
      'open-editor',
      'delete-active-worktree',
    ]);
  });

  it('hides Open editor when the runtime cannot open one', () => {
    assert.deepEqual(worktreeMenuCommandIds({ editorAvailable: false, isRoot: false }), [
      'start-terminal-session',
      'start-agent-session',
      'delete-active-worktree',
    ]);
  });

  it('offers Open editor for the root worktree without offering delete', () => {
    assert.deepEqual(worktreeMenuCommandIds({ editorAvailable: true, isRoot: true }), [
      'start-terminal-session',
      'start-agent-session',
      'open-editor',
    ]);
  });
});
