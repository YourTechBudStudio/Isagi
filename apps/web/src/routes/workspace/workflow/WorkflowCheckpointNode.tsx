import type { ElementAggregate } from './aggregate.js';
import { inspectorCopy } from './copy.js';

/**
 * A checkpoint node's two marks on the declared canvas.
 *
 * Both are drawn from data the canvas already holds — the static descriptor and the visits' status
 * and summaries — so a checkpoint never makes the canvas fetch anything. What each capture saved and
 * warned about belongs to the dock, not to a card on a graph.
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
 * What a checkpoint's visits did, in one line.
 *
 * The latest visit speaks first. A Cancel ends its attempt while the visit itself can still read as
 * running, so a cancelled latest attempt is checked before anything else: it saved a checkpoint or
 * it saved nothing, and it is never still capturing. Otherwise a live capture reads as capturing and
 * a failed one as failed, even after earlier visits saved. What remains counts the visits that
 * actually saved a checkpoint — a failed visit saved nothing, so it is not a capture. The static
 * title is the only name here; a visit's own title belongs to the dock.
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
  const captures = aggregate.visits.filter((visit) => visit.checkpoint !== null).length;
  const saved = () => (
    <>
      {captures === 1
        ? withTitle(inspectorCopy.checkpointCaptured)
        : inspectorCopy.checkpointCaptures(captures)}
    </>
  );
  if (latest.latestAttempt?.status === 'cancelled') {
    return latest.checkpoint === null ? <>{inspectorCopy.checkpointNothingSaved}</> : saved();
  }
  if (aggregate.status === 'running') {
    return <span className="text-fg-muted">{inspectorCopy.checkpointCapturing}</span>;
  }
  if (aggregate.status === 'failed') {
    return <span className="text-error">{inspectorCopy.checkpointFailed}</span>;
  }
  if (captures === 0) return <>{inspectorCopy.checkpointNothingSaved}</>;
  return saved();
}
