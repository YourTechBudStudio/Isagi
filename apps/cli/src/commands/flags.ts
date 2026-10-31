import { Flag } from 'effect/cli';

import { flag, pageLimit, positiveInteger } from './values.js';

/** Flags several client commands share, with one description each. */

export const cursorFlag = flag(
  'cursor',
  positiveInteger('cursor'),
  "Continue from a previous page's nextCursor.",
).pipe(Flag.optional);

export const limitFlag = flag(
  'limit',
  pageLimit,
  'Page size (1–500; the runtime defaults to 100).',
).pipe(Flag.optional);

export const runFlag = flag('run', positiveInteger('runId'), 'The run the record belongs to.');

export const originWorktreeFlag = flag(
  'worktree',
  positiveInteger('worktreeId'),
  'Launch origin worktree. Defaults to the worktree containing the current directory. Without --surface the origin has no surface.',
).pipe(Flag.optional);

export const originSurfaceFlag = flag(
  'surface',
  positiveInteger('surfaceId'),
  "Launch origin surface. Defaults to that worktree's focused surface, if any; give with --worktree.",
).pipe(Flag.optional);
