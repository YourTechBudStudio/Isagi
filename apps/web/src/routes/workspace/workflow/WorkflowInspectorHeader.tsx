import { X } from 'lucide-react';

import type { WorkflowRunSummary } from '@isagi/contracts';

import { workflowCopy, workflowFailureHeadline } from '../../../copy/index.js';
import {
  workflowPresentationStatus,
  workflowReasonLine,
  workflowStopNotice,
} from '../../../lib/workspace/workflow/derive.js';
import { inspectorCopy } from './copy.js';
import { shortHash } from './dock.js';
import { formatClock, formatDuration, parseInstant } from './timing.js';

/**
 * What run this is, where it came from, and why it is where it is — in one line each.
 *
 * No controls. Not a version picker, not a run switcher, not a Dismiss. The bar is the only surface
 * that acts on a run, and the moment one action appears here that stops being true. The single
 * button is Close, which is navigation.
 *
 * The reason line is composed from recorded facts in the order that decides what a person would do
 * next, and it never softens a stop: a cancel that could not confirm everything says so.
 */
export function WorkflowInspectorHeader({
  summary,
  now,
  closeRef,
  onClose,
}: {
  readonly summary: WorkflowRunSummary;
  readonly now: number;
  readonly closeRef: React.Ref<HTMLButtonElement>;
  readonly onClose: () => void;
}) {
  const status = workflowPresentationStatus(summary);
  const started = parseInstant(summary.createdAt);
  const ended = parseInstant(summary.endedAt);
  const elapsed = started === null ? null : Math.max(0, (ended ?? now) - started);

  const facts = [
    `run #${summary.runId}`,
    `definition v${summary.pinOrdinal} · ${shortHash(summary.artifactHash)}`,
    surfaceFact(summary),
    `started ${formatClock(summary.createdAt)}`,
    ended === null
      ? elapsed === null
        ? null
        : `${formatDuration(elapsed)} so far`
      : `ended ${formatClock(summary.endedAt)} · ${elapsed === null ? '' : formatDuration(elapsed)} total`,
  ].filter((fact): fact is string => fact !== null);

  return (
    <header className="flex flex-none items-start gap-3.5 border-b border-line/26 px-4.5 pt-3 pb-2.5">
      <div className="min-w-0">
        <h2 className="font-display text-[15px] font-semibold text-fg">
          {summary.title}
          <StatusChip status={status} summary={summary} />
        </h2>
        <p className="mt-0.5 truncate font-mono text-[11.5px] text-fg-subtle">
          {facts.join(' · ')}
        </p>
        <PlacementLine summary={summary} />
        <ReasonLine summary={summary} />
      </div>
      <button
        ref={closeRef}
        type="button"
        onClick={onClose}
        aria-label={inspectorCopy.closeLabel}
        className="ml-auto flex flex-none items-center gap-1.5 rounded-lg border border-transparent px-2.5 py-1.5 text-[12.5px] text-fg-subtle transition duration-micro ease-expo hover:bg-elevated/70 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue"
      >
        <span className="font-mono text-[11px]">Esc</span>
        <X size={14} aria-hidden />
      </button>
    </header>
  );
}

/**
 * Who chose this run's environment, and what they chose — on its own line, or not at all.
 *
 * Only a run whose placement somebody decided has anything to say here, so the common case (the
 * unchanged current worktree and surface) adds nothing and the header looks exactly as it did. The
 * line wraps rather than truncating: it is the least important line in the header and the one most
 * likely to be long, and truncating it would drop the created branch first.
 *
 * Every phrase comes from the run's own retained record — the placement request, the receipts and
 * the destination the commit wrote. Nothing here re-reads a worktree or surface row, so a deleted
 * resource leaves the sentence intact rather than blanking it.
 */
function PlacementLine({ summary }: { readonly summary: WorkflowRunSummary }) {
  const line = placementFact(summary);
  if (line === null) {
    return null;
  }
  return (
    <p className="mt-0.5 font-mono text-[11.5px] wrap-break-word text-fg-subtle">
      <span className="text-fg-muted">{line.provenance}</span>
      {line.choices.map((choice) => (
        <span key={choice}> · {choice}</span>
      ))}
    </p>
  );
}

function placementFact(
  summary: WorkflowRunSummary,
): { readonly provenance: string; readonly choices: readonly string[] } | null {
  const { preparation } = summary;
  if (preparation.source === 'default') {
    return null;
  }
  return {
    provenance:
      preparation.source === 'selector'
        ? inspectorCopy.placementBySelector
        : inspectorCopy.placementByOverride,
    choices: [worktreeChoiceFact(summary), surfaceChoiceFact(summary)],
  };
}

function worktreeChoiceFact(summary: WorkflowRunSummary): string {
  const choice = summary.preparation.request.worktree;
  if (choice.kind === 'current') {
    return 'current worktree';
  }
  if (choice.kind === 'existing') {
    // The path is what the commit wrote, so it is there for every run that reaches the inspector;
    // the id is a last resort that names something rather than rendering a blank phrase.
    const path = summary.destination.worktreePath;
    return `existing worktree ${path === null ? `#${choice.worktreeId}` : folderName(path)}`;
  }
  const baseCommit = summary.preparation.baseCommit;
  const from = `from ${choice.fromRef}${baseCommit === null ? '' : ` @ ${shortHash(baseCommit)}`}`;
  return `new worktree ${choice.branch} ${from}`;
}

/**
 * The surface axis of the choice.
 *
 * An existing surface is named by its id in the request and nothing else: the summary carries no
 * title for a surface this launch did not create, and reading one out of live workspace state would
 * put a deletable fact inside a line that is otherwise retained history. "existing surface" is the
 * true and complete statement of what was asked for.
 */
function surfaceChoiceFact(summary: WorkflowRunSummary): string {
  const choice = summary.preparation.request.surface;
  if (choice.kind === 'current') {
    return 'current surface';
  }
  if (choice.kind === 'existing') {
    return 'existing surface';
  }
  // The receipt's title is what the surface is actually called: the owner may trim or disambiguate
  // what was asked for, and the header should say what exists.
  return `new surface "${summary.preparation.surface?.title ?? choice.title}"`;
}

function folderName(path: string): string {
  return path.split('/').at(-1) || path;
}

/**
 * Why the run is where it is, in one sentence.
 *
 * Reuses the bar's own derivation so the two surfaces cannot disagree about what is blocking a run,
 * and adds only what the inspector has room to say: the failed segment a Retry would act on, and the
 * honest account of a stop that could not be completed.
 */
function ReasonLine({ summary }: { readonly summary: WorkflowRunSummary }) {
  const reason = workflowReasonLine(summary);
  const stop = workflowStopNotice(summary);
  const failure = summary.failure;

  if (failure) {
    return (
      <p className="mt-1 text-[12.5px] leading-snug text-fg-muted">
        <Tag tone="text-error">failed</Tag>
        {workflowFailureHeadline(failure.code)}{' '}
        <span className="font-mono text-[11px] text-fg-subtle">
          {failure.segmentKind} · {failure.code} · {failure.message}
        </span>
      </p>
    );
  }
  if (reason) {
    return (
      <p className="mt-1 text-[12.5px] leading-snug text-fg-muted">
        <Tag tone={stop ? 'text-amber' : 'text-waiting'}>
          {summary.status === 'cancelled' ? 'cancelled' : 'holding'}
        </Tag>
        {reason}
      </p>
    );
  }
  if (summary.outcome?.kind === 'failure') {
    return (
      <p className="mt-1 text-[12.5px] leading-snug text-fg-muted">
        <Tag tone="text-error">outcome</Tag>
        {summary.outcome.reason ?? workflowCopy.outcomeFailure}
      </p>
    );
  }
  return null;
}

function Tag({ tone, children }: { readonly tone: string; readonly children: string }) {
  return (
    <span className={`mr-2 font-mono text-[11px] tracking-[0.04em] uppercase ${tone}`}>
      {children}
    </span>
  );
}

function StatusChip({
  status,
  summary,
}: {
  readonly status: ReturnType<typeof workflowPresentationStatus>;
  readonly summary: WorkflowRunSummary;
}) {
  const label =
    status === 'driving'
      ? summary.status
      : status === 'waiting_user'
        ? 'waiting on you'
        : status.replace('_', ' ');
  const tone =
    status === 'done'
      ? 'border-green/30 bg-green/14 text-green'
      : status === 'failed' || status === 'blocked'
        ? 'border-error/30 bg-error/14 text-error'
        : status === 'waiting_user'
          ? 'border-waiting/32 bg-waiting/14 text-waiting'
          : status === 'driving'
            ? 'border-working/32 bg-working/14 text-working'
            : 'border-line/35 bg-line/16 text-fg-subtle';
  return (
    <span
      className={`ml-2.5 inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 align-[2px] text-[11.5px] font-semibold ${tone}`}
    >
      {label}
    </span>
  );
}

/**
 * Where the run's work is placed, kept distinct from where it was launched from.
 *
 * Both are retained descriptive facts and either may name a worktree somebody has since deleted,
 * which is why this states availability rather than assuming it.
 */
function surfaceFact(summary: WorkflowRunSummary): string {
  const path = summary.destination.worktreePath;
  const name = path === null ? 'no worktree' : folderName(path);
  return summary.destination.available ? `surface ${name}` : `surface ${name} · unavailable`;
}
