import { Layer } from 'effect';

import { ProjectDeletionParticipant } from '../workspace/index.js';
import { deleteRunsOfProject } from './store/runs.js';

/**
 * Project deletion's workflow participant. The workspace owns the transaction that deletes a
 * project; the workflows domain owns the SQL that erases the project's runs inside it (ADR 0008).
 * It deletes every run of the project inside the caller's open transaction (children cascade) and
 * returns the number of runs erased. Stateless, and wired only by the composition root.
 */
export const WorkflowProjectErasure = Layer.succeed(
  ProjectDeletionParticipant,
  ProjectDeletionParticipant.of({ eraseInTransaction: deleteRunsOfProject }),
);
