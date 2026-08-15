import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';

import type { Surface, Worktree } from '../../lib/workspace/types.js';
import { ProjectHeaderBody } from './ProjectGroup.js';
import { RailOrderFailureLine } from './RailOrderNotice.js';
import { SurfaceRowBody, WorktreeRowBody } from './WorktreeBlock.js';

/**
 * The two rail-drag invariants that are cheap to prove from markup and expensive
 * to notice by eye.
 *
 * The first is that the bodies shared with the travelling drag preview stay
 * presentational. The preview is `aria-hidden` and non-interactive, so a control
 * or a shared `layoutId` reaching it would put either a second copy of an action
 * or a second claimant on one Motion identity on screen — neither of which shows
 * up as a failure, only as strange behaviour.
 *
 * The second is where a refused reorder is allowed to appear. Everything about
 * how a drag *feels* lives in the browser fixture instead; this harness renders
 * to static markup and has no pointer.
 */

const worktree: Worktree = {
  id: 12,
  projectId: 1,
  title: 'rail drag reordering',
  path: '/work/.isagi/wt/rail-drag',
  branch: 'feat/rail-drag',
  head: 'abc1234',
  isRoot: false,
  parked: false,
  attention: 'idle',
  activeSurfaceId: 121,
  surfaces: [],
};

const surface: Surface = {
  id: 121,
  title: 'plan review',
  paneKinds: ['agent_session'],
  attention: 'waiting',
};

const project = {
  id: 1,
  name: 'isagi',
  rootPath: '/work/isagi',
  status: 'present',
  glyph: 'IS',
  accent: 'blue',
  worktrees: [],
} as const;

describe('drag preview bodies', () => {
  it('carries a worktree row without its button or menu', () => {
    const markup = renderToStaticMarkup(<WorktreeRowBody worktree={worktree} active={false} />);

    assert.match(markup, /rail drag reordering/);
    assert.match(markup, /feat\/rail-drag/);
    assert.doesNotMatch(markup, /<button/);
  });

  it('carries a surface row without the selected lift', () => {
    // The lift is a shared-`layoutId` element in the real row. Duplicating it
    // into the preview would give Motion two elements claiming one identity.
    const markup = renderToStaticMarkup(<SurfaceRowBody surface={surface} active />);

    assert.match(markup, /plan review/);
    assert.doesNotMatch(markup, /<button/);
    assert.doesNotMatch(markup, /bg-white\/8/);
  });

  it('carries a project header with no action unless one is given', () => {
    const bare = renderToStaticMarkup(<ProjectHeaderBody project={project} />);
    assert.match(bare, /isagi/);
    assert.doesNotMatch(bare, /<button/);

    const withAction = renderToStaticMarkup(
      <ProjectHeaderBody project={project} action={<button type="button">Open worktree</button>} />,
    );
    assert.match(withAction, /Open worktree/);
  });
});

describe('rail order failure line', () => {
  it('states the refusal, stays dismissible, and never reads as destruction', () => {
    const markup = renderToStaticMarkup(
      <RailOrderFailureLine
        scopeKey="surfaces:12"
        message="Couldn't save that order."
        onDismiss={() => {}}
      />,
    );

    assert.match(markup, /Couldn&#x27;t save that order\./);
    assert.match(markup, /data-rail-order-failure="surfaces:12"/);
    // Announced politely rather than asserted over whatever the user is doing.
    assert.match(markup, /role="status"/);
    // The whole notice is excluded from drag activation, not only its dismiss
    // control: it sits inside the *enclosing* list's drag source, so pulling on
    // the message text would otherwise pick up a scope the refusal is not about.
    assert.match(markup, /data-rail-order-failure="surfaces:12" data-no-drag/);
    assert.match(markup, /aria-label="Dismiss"/);
    // Amber: the move was declined and has already been undone, so nothing was
    // destroyed and there is nothing to reverse.
    assert.match(markup, /amber/);
    assert.doesNotMatch(markup, /error|text-red|bg-red/);
  });
});
