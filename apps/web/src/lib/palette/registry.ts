import { addProjectCommand } from './commands/add-project.js';
import type { PaletteCommand } from './types.js';

/**
 * The global command registry — config-driven and **append-only**: each command
 * lives in its own file under `commands/` and is concatenated here, so adding a
 * command never edits a shared structure (merge-conflict-friendly). Only global
 * commands register this way; the other palette groups are internal features.
 */
export const GLOBAL_COMMANDS: readonly PaletteCommand[] = [addProjectCommand];
