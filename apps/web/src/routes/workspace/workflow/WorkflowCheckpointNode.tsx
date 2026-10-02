import { inspectorCopy } from './copy.js';

/**
 * A checkpoint node's mark on the declared canvas, in the cyan the canvas uses for kept things.
 *
 * Drawn from the static descriptor alone, so a checkpoint never makes the canvas fetch anything.
 * What each capture saved belongs to the dock, not to a card on a graph.
 */
export function CheckpointKindTag() {
  return (
    <span className="flex-none font-mono text-[10px] tracking-[0.07em] text-cyan uppercase opacity-85">
      {inspectorCopy.checkpointKind}
    </span>
  );
}
