import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect } from 'effect';

import { SurfaceError, SurfaceService } from '../index.js';
import { insertWorktree, testLayer } from './test-support.js';

test('environment focus persists active pane only when it belongs to the active surface', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-surfaces-focus-'));
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const surfaces = yield* SurfaceService;
        const first = yield* surfaces.createSinglePaneSurface({
          worktreeId,

          titleBase: 'Terminal',
        });
        const second = yield* surfaces.createSinglePaneSurface({
          worktreeId,

          titleBase: 'Terminal',
        });

        yield* surfaces.setWorktreeEnvironmentFocus({
          worktreeId,
          focus: { activeSurfaceId: first.surfaceId, activePaneId: first.paneId },
        });

        return {
          firstDetail: yield* surfaces.getSurfaceDetail(first.surfaceId),
          secondDetail: yield* surfaces.getSurfaceDetail(second.surfaceId),
        };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.equal(output.firstDetail.activePaneId, output.firstDetail.panes[0]?.id);
    assert.equal(output.secondDetail.activePaneId, null);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('environment focus rejects panes that do not belong to the selected surface', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-surfaces-invalid-focus-'));
  try {
    const error = await Effect.runPromise(
      Effect.flip(
        Effect.gen(function* () {
          const worktreeId = yield* insertWorktree('/repo/isagi');
          const surfaces = yield* SurfaceService;
          const first = yield* surfaces.createSinglePaneSurface({
            worktreeId,

            titleBase: 'Terminal',
          });
          const second = yield* surfaces.createSinglePaneSurface({
            worktreeId,

            titleBase: 'Terminal',
          });

          return yield* surfaces.setWorktreeEnvironmentFocus({
            worktreeId,
            focus: { activeSurfaceId: first.surfaceId, activePaneId: second.paneId },
          });
        }).pipe(Effect.provide(testLayer(dataRoot))),
      ),
    );

    assert.ok(error instanceof SurfaceError);
    assert.equal(error.code, 'pane_not_found');
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
