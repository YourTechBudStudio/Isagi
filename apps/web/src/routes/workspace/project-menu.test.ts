import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ArgValues } from '../../lib/palette/types.js';
import { projectMenuItems } from './project-menu.js';

describe('project rail context menu', () => {
  it('offers one destructive Delete project… item', () => {
    const items = projectMenuItems(7, async () => {});
    assert.deepEqual(
      items.map(({ label, danger }) => ({ label, danger })),
      [{ label: 'Delete project…', danger: true }],
    );
  });

  // Present headers and disconnected rows build the same menu from their own id.
  for (const projectId of [7, 9]) {
    it(`dispatches delete-project for project ${projectId}, not the active one`, () => {
      const dispatched: Array<[string, ArgValues]> = [];
      const [item] = projectMenuItems(projectId, async (entryId, values) => {
        dispatched.push([entryId, values]);
      });
      item?.onSelect();
      assert.deepEqual(dispatched, [['delete-project', { projectId: String(projectId) }]]);
    });
  }
});
