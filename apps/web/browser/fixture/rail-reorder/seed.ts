import type { RailModel } from './model.js';

/**
 * Enough rail to make the variant question answerable. The comparison is about
 * *height and nesting*, so the shape matters more than the names: one tall
 * project whose active worktree is expanded to four surfaces, a second present
 * project with its own non-root worktrees, a third short one to prove a project
 * can be dropped at either end, and a Disconnected section to hover illegally.
 *
 * All names, paths and branches are invented. Nothing here is real workspace
 * data and nothing here is loaded from the runtime.
 */
export const SEED: RailModel = {
  projects: [
    {
      id: 1,
      name: 'isagi',
      glyph: 'IS',
      accent: 'blue',
      worktrees: [
        {
          id: 11,
          title: 'main',
          path: '~/work/isagi',
          branch: 'main',
          isRoot: true,
          parked: false,
          attention: 'idle',
          surfaces: [{ id: 111, title: 'shell', paneKind: 'terminal_session', attention: 'idle' }],
        },
        {
          id: 12,
          title: 'rail drag reordering',
          path: '~/work/.isagi/wt/rail-drag',
          branch: 'feat/draggable-sidebar-items',
          isRoot: false,
          parked: false,
          attention: 'working',
          surfaces: [
            { id: 121, title: 'plan review', paneKind: 'agent_session', attention: 'working' },
            { id: 122, title: 'fixture', paneKind: 'agent_session', attention: 'waiting' },
            { id: 123, title: 'pnpm check', paneKind: 'terminal_session', attention: 'idle' },
            { id: 124, title: 'scratch', paneKind: null, attention: 'idle' },
          ],
        },
        {
          id: 13,
          title: 'update footer polish',
          path: '~/work/.isagi/wt/update-footer',
          branch: 'fix/footer-metrics',
          isRoot: false,
          parked: false,
          attention: 'waiting',
          surfaces: [{ id: 131, title: 'agent', paneKind: 'agent_session', attention: 'waiting' }],
        },
        {
          id: 14,
          title: 'linux packaging',
          path: '~/work/.isagi/wt/linux-pkg',
          branch: 'fix/linux-icons',
          isRoot: false,
          parked: true,
          attention: 'idle',
          surfaces: [],
        },
        {
          id: 15,
          title: 'harness ledger',
          path: '~/work/.isagi/wt/harness-ledger',
          branch: 'feat/ledger',
          isRoot: false,
          parked: false,
          attention: 'error',
          surfaces: [{ id: 151, title: 'agent', paneKind: 'agent_session', attention: 'error' }],
        },
      ],
    },
    {
      id: 2,
      name: 'toph',
      glyph: 'TO',
      accent: 'violet',
      worktrees: [
        {
          id: 21,
          title: 'main',
          path: '~/work/toph',
          branch: 'main',
          isRoot: true,
          parked: false,
          attention: 'idle',
          surfaces: [],
        },
        {
          id: 22,
          title: 'streaming rewrite',
          path: '~/work/.toph/wt/streaming',
          branch: 'feat/streaming',
          isRoot: false,
          parked: false,
          attention: 'idle',
          surfaces: [],
        },
        {
          id: 23,
          title: 'docs pass',
          path: '~/work/.toph/wt/docs',
          branch: 'chore/docs',
          isRoot: false,
          parked: false,
          attention: 'idle',
          surfaces: [],
        },
      ],
    },
    {
      id: 3,
      name: 'sketchbook',
      glyph: 'SK',
      accent: 'green',
      worktrees: [
        {
          id: 31,
          title: 'main',
          path: '~/work/sketchbook',
          branch: 'main',
          isRoot: true,
          parked: false,
          attention: 'idle',
          surfaces: [],
        },
      ],
    },
  ],
  missing: [
    { id: 8, name: 'archive-2025', glyph: 'AR' },
    { id: 9, name: 'old-runtime', glyph: 'OL' },
  ],
};

/** The worktree the fixture opens expanded — the tall case the variants are judged against. */
export const SEED_ACTIVE_WORKTREE_ID = 12;
