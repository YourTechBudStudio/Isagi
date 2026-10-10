import { WorkflowEngine } from './engine/service.js';

/** The workflows module's public services. `WorkflowEngine.layer` wires its own module dependencies. */
export const WorkflowsLayer = WorkflowEngine.layer;
