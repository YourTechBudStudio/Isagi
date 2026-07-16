import { paletteCopy } from '../../copy/index.js';
import type { CommandErrorContent, CommandOutcomeAction, CommandResultContent } from './types.js';

export function outcomeActions(content: CommandResultContent | CommandErrorContent) {
  return content.actions?.length
    ? content.actions
    : [{ value: 'close', label: paletteCopy.outcome.close } satisfies CommandOutcomeAction];
}
