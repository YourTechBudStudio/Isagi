import { WorkspaceService } from './service.js';

/**
 * The workspace module's public services. `WorkspaceService.layer` wires its own module dependencies; its
 * `ProjectDeletionParticipant` port and `StateFile` (a platform service) stay open for the composition root.
 */
export const WorkspaceLayer = WorkspaceService.layer;
