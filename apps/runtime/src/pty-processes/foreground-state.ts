import { Context, Effect, Layer } from 'effect';

import type { PtyForegroundCommandState } from './types.js';

export interface PtyForegroundStateService {
  readonly set: (ptyProcessId: number, state: PtyForegroundCommandState) => Effect.Effect<boolean>;
  readonly clear: (ptyProcessId: number) => Effect.Effect<boolean>;
  readonly isWorking: (ptyProcessId: number) => boolean;
}

export const PtyForegroundState = Context.GenericTag<PtyForegroundStateService>(
  'isagi/PtyForegroundState',
);

export const PtyForegroundStateLive = Layer.sync(PtyForegroundState, () => {
  const workingProcesses = new Set<number>();

  return {
    set: (ptyProcessId, state) =>
      Effect.sync(() => {
        const wasWorking = workingProcesses.has(ptyProcessId);
        if (state === 'working') {
          workingProcesses.add(ptyProcessId);
        } else {
          workingProcesses.delete(ptyProcessId);
        }
        return wasWorking !== workingProcesses.has(ptyProcessId);
      }),
    clear: (ptyProcessId) =>
      Effect.sync(() => {
        const existed = workingProcesses.delete(ptyProcessId);
        return existed;
      }),
    isWorking: (ptyProcessId) => workingProcesses.has(ptyProcessId),
  } satisfies PtyForegroundStateService;
});
