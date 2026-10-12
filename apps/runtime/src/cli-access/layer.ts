import { CliAccess } from './service.js';

/** The cli-access module's services for the composition root. One instance: the server publishes the URL into the same service every PTY launch reads its environment from. */
export const CliAccessLayer = CliAccess.layer;
