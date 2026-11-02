import { Access } from './service.js';

/**
 * The access module's services for the composition root. `Access.layer` provides `ProcessTokens.layer` by reference,
 * so the guard checks the same process tokens every launch issues.
 */
export const AccessLayer = Access.layer;
