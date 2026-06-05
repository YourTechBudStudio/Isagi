import { oc } from '@orpc/contract';

import {
  addProjectInputSchema,
  setActiveContextInputSchema,
  workspaceSnapshotSchema,
} from './types.js';

export const workspaceContract = {
  get: oc.output(workspaceSnapshotSchema),
  setActiveContext: oc.input(setActiveContextInputSchema).output(workspaceSnapshotSchema),
};

export const projectsContract = {
  add: oc.input(addProjectInputSchema).output(workspaceSnapshotSchema),
};
