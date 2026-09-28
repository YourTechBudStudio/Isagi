import {
  Activity,
  Check,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  CircleSlash,
  MessageCircle,
  Network,
  Pause,
  Play,
  RotateCw,
  X,
  type LucideIcon,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';

import type { WorkflowRunSummary, WorkflowWaitDto } from '@isagi/contracts';

import { Tooltip } from '../../components/Tooltip.js';
import { workflowCopy, workflowErrorStageHeadline } from '../../copy/index.js';
import { surfaceTransition } from '../../lib/motion.js';
import {
  canAnswer,
  userWait,
  workflowPresentationStatus,
  workflowReasonLine,
  type WorkflowPresentationStatus,
} from '../../lib/workspace/workflow/derive.js';
import type { WorkflowLogLine } from '../../lib/workspace/workflow/log.js';
import type { WorkflowLogView } from '../../lib/workspace/workflow/queries.js';
import type { RuntimeConnectionPhase } from '../../lib/workspace/workflow/signals.js';
import { inspectorCopy } from './workflow/copy.js';
import { WorkflowInputFlow, type WorkflowInputAnswers } from './WorkflowInputFlow.js';

export interface WorkflowBarProps {
  readonly summary: WorkflowRunSummary;
  readonly log: WorkflowLogView;
  readonly connection: RuntimeConnectionPhase;
  readonly logExpanded: boolean;
  readonly inspectorOpen: boolean;
  /**
   * The bar's own element.
   *
   * The inspector overlay stops above the bar rather than covering it, which it can only do if
   * somebody measures how tall the bar currently is — and it changes, because the log panel and the
   * question form both grow it. A person answering a question while the inspector is open is the
   * whole reason this is not a modal.
   */
  readonly sectionRef?: React.Ref<HTMLElement> | undefined;
  /**
   * True while any control mutation is in flight.
   *
   * The whole cluster waits, not just the button that was pressed. These are run-level controls and
   * issuing two at once means nothing, while leaving the others live let a fast action clear the
   * indicator with a slower one still outstanding.
   */
  readonly actionsLocked: boolean;
  readonly actionError: string | null;
  readonly onToggleLog: () => void;
  readonly onToggleInspector: () => void;
  readonly onPause: () => void;
  readonly onResume: () => void;
  readonly onCancel: () => void;
  readonly onRetry: () => void;
  readonly onDismiss: () => void;
  /** Answers the user wait of the named waiting execution. */
  readonly onAdvance: (executionId: number, answers?: WorkflowInputAnswers) => void;
}

const statusMeta: Record<
  WorkflowPresentationStatus,
  {
    readonly icon: LucideIcon;
    readonly label: string;
    readonly tone: string;
    readonly signal: string;
  }
> = {
  preparing: { icon: Activity, label: 'Preparing', tone: 'text-working', signal: 'bg-working' },
  driving: { icon: Activity, label: 'Driving', tone: 'text-working', signal: 'bg-working' },
  waiting_user: {
    icon: MessageCircle,
    label: 'Waiting',
    tone: 'text-waiting',
    signal: 'bg-waiting',
  },
  paused: { icon: Pause, label: 'Paused', tone: 'text-fg-subtle', signal: 'bg-idle' },
  failed: { icon: CircleAlert, label: 'Failed', tone: 'text-error', signal: 'bg-error' },
  cancelled: {
    icon: CircleSlash,
    label: 'Cancelled',
    tone: 'text-fg-subtle',
    signal: 'bg-idle',
  },
  done: { icon: Check, label: 'Done', tone: 'text-green', signal: 'bg-green' },
};

export function WorkflowBar({
  summary,
  log,
  connection,
  logExpanded,
  inspectorOpen,
  sectionRef,
  actionsLocked,
  actionError,
  onToggleLog,
  onToggleInspector,
  onPause,
  onResume,
  onCancel,
  onRetry,
  onDismiss,
  onAdvance,
}: WorkflowBarProps) {
  /**
   * Which run the person confirmed cancelling — not merely that they confirmed something.
   *
   * The bar is one component across run swaps, so a boolean here outlives the run it was raised
   * for. A committed render could then show run 77's confirmation while `onCancel` already pointed
   * at run 88, and a click in that frame would cancel a workflow nobody confirmed. Comparing the id
   * during render closes the window; an effect cannot, because it runs a paint too late.
   */
  const [confirmingCancelRunId, setConfirmingCancelRunId] = useState<number | null>(null);
  const presentationStatus = workflowPresentationStatus(summary);
  const meta = statusMeta[presentationStatus];
  const StatusIcon = meta.icon;
  const heading = summary.uiFeedback?.phase ?? summary.title;
  const body = summary.uiFeedback?.message;
  const reason = workflowReasonLine(summary);
  // A paused run still accepts an answer, and showing the form then is honest as long as it does
  // not imply the graph resumed.
  const wait = userWait(summary);
  const prompt =
    canAnswer(summary) && wait !== null && summary.current !== null
      ? { wait, executionId: summary.current.executionId }
      : null;

  const confirmingCancel = confirmingCancelRunId === summary.runId;

  useEffect(() => {
    // A run that moved on has nothing left to confirm; the render-time comparison already hides it,
    // and this clears the stale id so it cannot match again if the same run returns.
    setConfirmingCancelRunId(null);
  }, [summary.runId, presentationStatus]);

  return (
    <motion.section
      ref={sectionRef}
      key={`workflow-bar-${summary.runId}`}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 10 }}
      transition={surfaceTransition}
      className="relative z-10 flex flex-none flex-col overflow-hidden border-t border-line/15 bg-elevated/65 backdrop-blur-md"
      aria-label="Workflow"
    >
      <span aria-hidden className={`absolute inset-x-0 top-0 h-px ${meta.signal}`} />
      <div className="flex min-h-16 flex-none items-center gap-2.5 px-3.5 py-2">
        <StatusIcon size={13} className={meta.tone} aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className={`truncate font-mono text-[11px] ${meta.tone}`}>{heading}</span>
            <span className="truncate font-mono text-[10.5px] text-fg-subtle">{meta.label}</span>
          </div>
          {body && <p className="mt-0.5 text-[13.5px] leading-snug text-fg">{body}</p>}
          {reason && <p className="mt-0.5 text-[12.5px] leading-snug text-fg-muted">{reason}</p>}
          <WorkflowOutcomeLine summary={summary} />
        </div>
        <div className="ml-3 flex flex-none items-center gap-0.5">
          <WorkflowBarControls
            summary={summary}
            actionsLocked={actionsLocked}
            confirmingCancel={confirmingCancel}
            onPause={onPause}
            onResume={onResume}
            onRetry={onRetry}
            onDismiss={onDismiss}
            onCancelIntent={() => setConfirmingCancelRunId(summary.runId)}
          />
          <span aria-hidden className="mx-1 h-4 w-px bg-line/20" />
          {/* Inspection is a read, so it sits after the separator with the log toggle rather than
              among the controls that change the run. */}
          <WorkflowBarControl
            icon={Network}
            label={inspectorCopy.inspectLabel}
            onClick={onToggleInspector}
            active={inspectorOpen}
            ariaExpanded={inspectorOpen}
          />
          <WorkflowBarControl
            icon={logExpanded ? ChevronDown : ChevronUp}
            label={logExpanded ? 'Hide log' : 'Show log'}
            onClick={onToggleLog}
            active={logExpanded}
            ariaExpanded={logExpanded}
          />
        </div>
      </div>

      <AnimatePresence initial={false}>
        {confirmingCancel && (
          <CancelConfirm
            key="cancel-confirm"
            busy={actionsLocked}
            onCancel={onCancel}
            onBack={() => setConfirmingCancelRunId(null)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {actionError && <ActionError key="action-error" message={actionError} />}
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {prompt && !confirmingCancel && (
          <WorkflowPrompt
            // One prompt node, deliberately not keyed by wait. Keying it would leave the previous
            // wait's form on screen — and editable — for the length of its exit animation, which is
            // a form a person can still type into for a question the run has already left. The
            // draft's own identity (`draftKey`) is what resets the fields when the wait changes.
            key="prompt"
            wait={prompt.wait}
            executionId={prompt.executionId}
            paused={summary.status === 'paused'}
            busy={actionsLocked}
            onAdvance={onAdvance}
          />
        )}
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {logExpanded && <WorkflowLogPanel key="log" log={log} connection={connection} />}
      </AnimatePresence>
    </motion.section>
  );
}

/**
 * The two different things "failed" can mean, kept apart.
 *
 * A workflow that declared a failure outcome finished on purpose and has nothing to repair; a
 * step that threw stopped mid-run and is what a Retry would act on. Presenting them the same way
 * would tell a person to retry something that already ran to completion.
 */
function WorkflowOutcomeLine({ summary }: { readonly summary: WorkflowRunSummary }) {
  if (summary.outcome?.kind === 'failure') {
    return (
      <p className="mt-0.5 text-[12.5px] leading-snug text-fg-muted">
        {summary.outcome.reason ?? workflowCopy.outcomeFailure}
      </p>
    );
  }
  const error = summary.error;
  if (!error) return null;
  const where = [error.graphKey, error.nodeId].filter(Boolean).join('/');
  return (
    <>
      <p className="mt-0.5 text-[12.5px] leading-snug text-fg-muted">
        {workflowErrorStageHeadline(error.stage)}
      </p>
      {/* The runtime's own text and stable stage: diagnostic facts to quote in a bug report, framed
          as such and never voiced as product copy. */}
      <p
        className="mt-0.5 min-w-0 truncate font-mono text-[10.5px] text-fg-subtle"
        title={`${error.stage}${where ? ` ${where}` : ''}: ${error.message}`}
      >
        {error.stage}
        {where ? ` ${where}` : ''} · {error.message}
      </p>
    </>
  );
}

/**
 * Availability comes from the runtime, not from the presentation status.
 *
 * The summary's `controls` are rechecked at mutation time, so offering exactly what they permit is
 * what stops the bar from showing a button the runtime is guaranteed to refuse.
 */
function WorkflowBarControls({
  summary,
  actionsLocked,
  confirmingCancel,
  onPause,
  onResume,
  onRetry,
  onDismiss,
  onCancelIntent,
}: {
  readonly summary: WorkflowRunSummary;
  readonly actionsLocked: boolean;
  readonly confirmingCancel: boolean;
  readonly onPause: () => void;
  readonly onResume: () => void;
  readonly onRetry: () => void;
  readonly onDismiss: () => void;
  readonly onCancelIntent: () => void;
}) {
  const controls = summary.controls;
  return (
    <>
      {controls.pause && (
        <WorkflowBarControl icon={Pause} label="Pause" onClick={onPause} busy={actionsLocked} />
      )}
      {controls.resume && (
        <WorkflowBarControl
          icon={Play}
          label="Resume"
          onClick={onResume}
          busy={actionsLocked}
          accent
        />
      )}
      {controls.retry && (
        <WorkflowBarControl
          icon={RotateCw}
          label="Retry"
          hint={workflowCopy.retryPinNote}
          onClick={onRetry}
          busy={actionsLocked}
          accent
        />
      )}
      {controls.cancel && (
        <WorkflowBarControl
          icon={X}
          label="Cancel"
          onClick={onCancelIntent}
          busy={actionsLocked}
          active={confirmingCancel}
        />
      )}
      {controls.dismiss && (
        <WorkflowBarControl
          icon={X}
          label={workflowCopy.dismissLabel}
          hint={workflowCopy.dismissDetail}
          onClick={onDismiss}
          busy={actionsLocked}
        />
      )}
    </>
  );
}

function WorkflowBarControl({
  icon: Icon,
  label,
  hint,
  onClick,
  accent = false,
  active = false,
  busy = false,
  ariaExpanded,
}: {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly hint?: string | undefined;
  readonly onClick?: () => void;
  readonly accent?: boolean | undefined;
  readonly active?: boolean | undefined;
  readonly busy?: boolean | undefined;
  readonly ariaExpanded?: boolean | undefined;
}) {
  return (
    <Tooltip label={hint ? `${label} — ${hint}` : label}>
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        disabled={busy}
        aria-expanded={ariaExpanded}
        aria-pressed={active || undefined}
        className={`grid size-7 place-items-center rounded-md transition duration-micro ease-expo disabled:cursor-not-allowed disabled:opacity-55 ${
          accent
            ? 'text-blue hover:bg-blue/12'
            : active
              ? 'bg-white/8 text-fg'
              : 'text-fg-muted hover:bg-white/6 hover:text-fg'
        }`}
      >
        <Icon size={14} aria-hidden />
      </button>
    </Tooltip>
  );
}

function CancelConfirm({
  busy,
  onCancel,
  onBack,
}: {
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onBack: () => void;
}) {
  return (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={surfaceTransition}
      className="overflow-hidden border-t border-error/18"
    >
      <div className="flex flex-wrap items-center gap-3 px-3.5 py-3">
        <span className="min-w-0 flex-1">
          <span className="block font-mono text-[12px] text-error">
            {workflowCopy.cancelConfirm}
          </span>
          <span className="block text-[12px] leading-snug text-fg-muted">
            {workflowCopy.cancelConfirmDetail}
          </span>
        </span>
        <button
          type="button"
          onClick={onBack}
          disabled={busy}
          className="rounded-md bg-white/6 px-3 py-1.5 font-mono text-[11.5px] text-fg-muted transition duration-micro ease-expo hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-55"
        >
          {workflowCopy.cancelConfirmBack}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded-md bg-error/14 px-3 py-1.5 font-mono text-[11.5px] text-error transition duration-micro ease-expo hover:bg-error/20 disabled:cursor-not-allowed disabled:opacity-55"
        >
          {workflowCopy.cancelConfirmAction}
        </button>
      </div>
    </motion.div>
  );
}

function ActionError({ message }: { readonly message: string }) {
  return (
    <motion.p
      role="status"
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={surfaceTransition}
      className="overflow-hidden border-t border-amber/18 px-3.5 py-2 font-mono text-[11px] text-amber"
    >
      {message}
    </motion.p>
  );
}

function WorkflowPrompt({
  wait,
  executionId,
  paused,
  busy,
  onAdvance,
}: {
  readonly wait: Extract<WorkflowWaitDto, { readonly kind: 'user_continue' | 'user_input' }>;
  readonly executionId: number;
  readonly paused: boolean;
  readonly busy: boolean;
  readonly onAdvance: (executionId: number, answers?: WorkflowInputAnswers) => void;
}) {
  return (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={surfaceTransition}
      className="overflow-hidden border-t border-line/12"
    >
      <div className="px-3.5 py-3">
        {wait.kind === 'user_continue' && wait.label && (
          <p className="mb-2 text-[13px] leading-snug text-fg">{wait.label}</p>
        )}
        {paused && (
          // Answering while paused records the answer; it does not start the graph moving again.
          <p className="mb-2 font-mono text-[10.5px] text-fg-subtle">
            {workflowCopy.pausedAnswerNote}
          </p>
        )}
        {wait.kind === 'user_continue' || wait.questions.length === 0 ? (
          <div className="flex justify-end">
            <button
              type="button"
              disabled={busy}
              onClick={() => onAdvance(executionId)}
              className="rounded-md bg-blue/16 px-3 py-1.5 font-mono text-[11.5px] text-blue transition duration-micro ease-expo hover:bg-blue/22 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {workflowCopy.continuePrompt}
            </button>
          </div>
        ) : (
          <WorkflowInputFlow
            questions={wait.questions}
            // The draft belongs to one wait. Keying it means a question that changes under a person
            // mid-sentence resets the form instead of submitting yesterday's answer to today's
            // question.
            draftKey={executionId}
            disabled={busy}
            autoFocus
            onSubmit={(answers) => onAdvance(executionId, answers)}
          />
        )}
      </div>
    </motion.div>
  );
}

function WorkflowLogPanel({
  log,
  connection,
}: {
  readonly log: WorkflowLogView;
  readonly connection: RuntimeConnectionPhase;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [log.lines.length]);

  return (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={surfaceTransition}
      className="overflow-hidden border-t border-line/12"
    >
      <div ref={scrollRef} className="max-h-56 overflow-y-auto px-3.5 py-2">
        {log.error !== null && log.error !== undefined ? (
          // A read that failed is not an empty history. Saying "nothing recorded yet" here would be
          // the panel inventing a fact about the run out of its own inability to read one.
          <p
            role="status"
            className="flex items-center gap-2 py-2 font-mono text-[11px] text-error"
          >
            {workflowCopy.logReadFailed}
            <button
              type="button"
              onClick={log.retry}
              className="rounded-md px-1.5 py-0.5 text-blue transition duration-micro ease-expo hover:bg-blue/12"
            >
              {workflowCopy.logRetry}
            </button>
          </p>
        ) : log.lines.length === 0 ? (
          <p className="py-2 font-mono text-[11px] text-fg-subtle opacity-70">
            {log.isLoading || connection === 'connecting'
              ? workflowCopy.logConnecting
              : connection === 'disconnected'
                ? workflowCopy.logDisconnected
                : workflowCopy.logEmpty}
          </p>
        ) : (
          <div className="space-y-1">
            {log.lines.map((line) => (
              <WorkflowLogLineView key={line.eventId} line={line} />
            ))}
          </div>
        )}
      </div>
    </motion.div>
  );
}

const logToneClass: Record<WorkflowLogLine['tone'], string> = {
  debug: 'text-fg-subtle',
  info: 'text-blue',
  warning: 'text-amber',
  error: 'text-error',
};

function WorkflowLogLineView({ line }: { readonly line: WorkflowLogLine }) {
  return (
    <p className="grid grid-cols-[4.25rem_4.5rem_1fr] gap-2 font-mono text-[10.5px] leading-relaxed">
      <span className="text-fg-subtle">{formatLogTime(line.at)}</span>
      <span className={logToneClass[line.tone]}>{line.label}</span>
      <span className="min-w-0 wrap-break-word text-fg-muted">{line.body}</span>
    </p>
  );
}

function formatLogTime(ts: string) {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return ts;
  return date.toLocaleTimeString([], {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
