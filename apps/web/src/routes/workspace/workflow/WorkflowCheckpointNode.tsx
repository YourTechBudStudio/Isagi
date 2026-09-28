import type { ElementAggregate } from './aggregate.js';
import { inspectorCopy } from './copy.js';

/**
 * A checkpoint node's two marks on the declared canvas.
 *
 * Both are drawn from data the canvas already holds — the static descriptor and the executions'
 * summaries — so a checkpoint never makes the canvas fetch anything. What each capture saved belongs
 * to the dock, not to a card on a graph.
 */

/** The slot a subgraph's violet tag takes, in the cyan the canvas uses for kept things. */
export function CheckpointKindTag() {
  return (
    <span className="flex-none font-mono text-[10px] tracking-[0.07em] text-cyan uppercase opacity-85">
      {inspectorCopy.checkpointKind}
    </span>
  );
}

/**
 * What a checkpoint's executions did, in one line.
 *
 * The latest execution speaks first: a live capture reads as capturing and a failed one as failed,
 * even after earlier executions saved. What remains counts the executions that actually saved a
 * checkpoint — a failed one saved nothing, so it is not a capture. The static title is the only
 * name here; an execution's own title belongs to the dock.
 */
export function CheckpointSubline({
  title,
  aggregate,
}: {
  readonly title: string | undefined;
  readonly aggregate: ElementAggregate;
}) {
  const withTitle = (text: string) => (title ? `${text} · ${title}` : text);
  const latest = aggregate.visits.at(-1);
  if (latest === undefined) return <>{withTitle(inspectorCopy.notVisited)}</>;
  // A Retry copies the checkpoint it retries, so count checkpoints rather than executions.
  const captures = new Set(
    aggregate.visits.flatMap((visit) => (visit.checkpointId === null ? [] : [visit.checkpointId])),
  ).size;
  if (latest.checkpointId === null) {
    if (latest.status === 'running') {
      return <span className="text-fg-muted">{inspectorCopy.checkpointCapturing}</span>;
    }
    if (latest.status === 'failed' || latest.status === 'interrupted') {
      return <span className="text-error">{inspectorCopy.checkpointFailed}</span>;
    }
  }
  if (captures === 0) return <>{inspectorCopy.checkpointNothingSaved}</>;
  return (
    <>
      {captures === 1
        ? withTitle(inspectorCopy.checkpointCaptured)
        : inspectorCopy.checkpointCaptures(captures)}
    </>
  );
}
