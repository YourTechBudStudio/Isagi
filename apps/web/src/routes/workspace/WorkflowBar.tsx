import {
  Activity,
  Check,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  MessageCircle,
  Pause,
  Play,
  RotateCw,
  X,
  type LucideIcon,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';

import type {
  WorkflowEvent,
  WorkflowSurfaceStatus,
  WorkflowSurfaceSummary,
} from '@isagi/contracts';

import { Tooltip } from '../../components/Tooltip.js';
import { workflowCopy } from '../../copy/index.js';
import { surfaceTransition } from '../../lib/motion.js';
import type { PtyStreamConnectionState } from '../../lib/workspace/pty-stream/connection.js';
import { WorkflowInputFlow, type WorkflowInputAnswers } from './WorkflowInputFlow.js';

export interface WorkflowBarProps {
  readonly summary: WorkflowSurfaceSummary;
  readonly events: readonly WorkflowEvent[];
  readonly eventConnection: PtyStreamConnectionState;
  readonly logExpanded: boolean;
  readonly busyAction: WorkflowBarAction | null;
  readonly actionError: string | null;
  readonly onToggleLog: () => void;
  readonly onPause: () => void;
  readonly onResume: () => void;
  readonly onCancel: () => void;
  readonly onRetry: () => void;
  readonly onDismiss: () => void;
  readonly onAdvance: (runId: number, answers?: WorkflowInputAnswers) => void;
}

export type WorkflowBarAction = 'pause' | 'resume' | 'cancel' | 'retry' | 'dismiss' | 'advance';

const statusMeta: Record<
  WorkflowSurfaceStatus,
  {
    readonly icon: LucideIcon;
    readonly label: string;
    readonly tone: string;
    readonly signal: string;
  }
> = {
  driving: {
    icon: Activity,
    label: 'Driving',
    tone: 'text-working',
    signal: 'bg-working',
  },
  waiting_user: {
    icon: MessageCircle,
    label: 'Waiting',
    tone: 'text-waiting',
    signal: 'bg-waiting',
  },
  paused: {
    icon: Pause,
    label: 'Paused',
    tone: 'text-fg-subtle',
    signal: 'bg-idle',
  },
  failed: {
    icon: CircleAlert,
    label: 'Failed',
    tone: 'text-error',
    signal: 'bg-error',
  },
  done: {
    icon: Check,
    label: 'Done',
    tone: 'text-green',
    signal: 'bg-green',
  },
};

export function WorkflowBar({
  summary,
  events,
  eventConnection,
  logExpanded,
  busyAction,
  actionError,
  onToggleLog,
  onPause,
  onResume,
  onCancel,
  onRetry,
  onDismiss,
  onAdvance,
}: WorkflowBarProps) {
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const meta = statusMeta[summary.status];
  const StatusIcon = meta.icon;
  const heading = summary.uiFeedback?.phase ?? summary.title;
  const body = summary.uiFeedback?.message;
  const prompt = summary.status === 'waiting_user' ? summary.prompt : undefined;

  useEffect(() => {
    setConfirmingCancel(false);
  }, [summary.rootRunId, summary.status]);

  return (
    <motion.section
      key={`workflow-bar-${summary.surfaceId}`}
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
          {summary.status === 'failed' &&
            summary.error && (
              // The workflow's own thrown message — diagnostic, not a voiced line (the
              // "Failed" label above is the voiced status). Muted so it reads as the
              // raw detail a person can quote in a bug report, never as product copy.
              <p
                className="mt-0.5 min-w-0 truncate font-mono text-[10.5px] text-fg-subtle"
                title={summary.error}
              >
                {summary.error}
              </p>
            )}
        </div>
        <div className="ml-3 flex flex-none items-center gap-0.5">
          <WorkflowBarControls
            status={summary.status}
            busyAction={busyAction}
            confirmingCancel={confirmingCancel}
            onPause={onPause}
            onResume={onResume}
            onRetry={onRetry}
            onDismiss={onDismiss}
            onCancelIntent={() => setConfirmingCancel(true)}
          />
          <span aria-hidden className="mx-1 h-4 w-px bg-line/20" />
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
            busy={busyAction === 'cancel'}
            onCancel={onCancel}
            onBack={() => setConfirmingCancel(false)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {actionError && <ActionError key="action-error" message={actionError} />}
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {prompt && !confirmingCancel && (
          <WorkflowPrompt
            key="prompt"
            prompt={prompt}
            busy={busyAction === 'advance'}
            onAdvance={onAdvance}
          />
        )}
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {logExpanded && <WorkflowLogPanel key="log" events={events} connection={eventConnection} />}
      </AnimatePresence>
    </motion.section>
  );
}

function WorkflowBarControls({
  status,
  busyAction,
  confirmingCancel,
  onPause,
  onResume,
  onRetry,
  onDismiss,
  onCancelIntent,
}: {
  readonly status: WorkflowSurfaceStatus;
  readonly busyAction: WorkflowBarAction | null;
  readonly confirmingCancel: boolean;
  readonly onPause: () => void;
  readonly onResume: () => void;
  readonly onRetry: () => void;
  readonly onDismiss: () => void;
  readonly onCancelIntent: () => void;
}) {
  switch (status) {
    case 'driving':
    case 'waiting_user':
      return (
        <>
          <WorkflowBarControl
            icon={Pause}
            label="Pause"
            onClick={onPause}
            busy={busyAction === 'pause'}
          />
          <WorkflowBarControl
            icon={X}
            label="Cancel"
            onClick={onCancelIntent}
            active={confirmingCancel}
          />
        </>
      );
    case 'paused':
      return (
        <>
          <WorkflowBarControl
            icon={Play}
            label="Resume"
            onClick={onResume}
            busy={busyAction === 'resume'}
            accent
          />
          <WorkflowBarControl
            icon={X}
            label="Cancel"
            onClick={onCancelIntent}
            active={confirmingCancel}
          />
        </>
      );
    case 'failed':
      return (
        <>
          <WorkflowBarControl
            icon={RotateCw}
            label="Retry"
            onClick={onRetry}
            busy={busyAction === 'retry'}
            accent
          />
          <WorkflowBarControl
            icon={X}
            label="Dismiss"
            onClick={onDismiss}
            busy={busyAction === 'dismiss'}
          />
        </>
      );
    case 'done':
      return (
        <WorkflowBarControl
          icon={X}
          label="Dismiss"
          onClick={onDismiss}
          busy={busyAction === 'dismiss'}
        />
      );
  }
}

function WorkflowBarControl({
  icon: Icon,
  label,
  onClick,
  accent = false,
  active = false,
  busy = false,
  ariaExpanded,
}: {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly onClick?: () => void;
  readonly accent?: boolean | undefined;
  readonly active?: boolean | undefined;
  readonly busy?: boolean | undefined;
  readonly ariaExpanded?: boolean | undefined;
}) {
  return (
    <Tooltip label={label}>
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
          <span className="block font-mono text-[10.5px] text-fg-subtle">
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
  prompt,
  busy,
  onAdvance,
}: {
  readonly prompt: NonNullable<WorkflowSurfaceSummary['prompt']>;
  readonly busy: boolean;
  readonly onAdvance: (runId: number, answers?: WorkflowInputAnswers) => void;
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
        {prompt.questions.length === 0 ? (
          <div className="flex justify-end">
            <button
              type="button"
              disabled={busy}
              onClick={() => onAdvance(prompt.runId)}
              className="rounded-md bg-blue/16 px-3 py-1.5 font-mono text-[11.5px] text-blue transition duration-micro ease-expo hover:bg-blue/22 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {workflowCopy.continuePrompt}
            </button>
          </div>
        ) : (
          <WorkflowInputFlow
            questions={prompt.questions}
            disabled={busy}
            autoFocus
            onSubmit={(answers) => onAdvance(prompt.runId, answers)}
          />
        )}
      </div>
    </motion.div>
  );
}

function WorkflowLogPanel({
  events,
  connection,
}: {
  readonly events: readonly WorkflowEvent[];
  readonly connection: PtyStreamConnectionState;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [events.length]);

  return (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={surfaceTransition}
      className="overflow-hidden border-t border-line/12"
    >
      <div ref={scrollRef} className="max-h-56 overflow-y-auto px-3.5 py-2">
        {events.length === 0 ? (
          <p className="py-2 font-mono text-[11px] text-fg-subtle opacity-70">
            {connection.phase === 'connecting'
              ? workflowCopy.logConnecting
              : connection.phase === 'disconnected' || connection.phase === 'errored'
                ? workflowCopy.logDisconnected
                : workflowCopy.logEmpty}
          </p>
        ) : (
          <div className="space-y-1">
            {events.map((event, index) => (
              <WorkflowEventLine key={`${event.ts}-${event.runId}-${index}`} event={event} />
            ))}
          </div>
        )}
      </div>
    </motion.div>
  );
}

function WorkflowEventLine({ event }: { readonly event: WorkflowEvent }) {
  return (
    <p className="grid grid-cols-[4.25rem_4.5rem_1fr] gap-2 font-mono text-[10.5px] leading-relaxed">
      <span className="text-fg-subtle">{formatEventTime(event.ts)}</span>
      <span className={eventTone(event)}>{eventLabel(event)}</span>
      <span className="min-w-0 wrap-break-word text-fg-muted">{eventMessage(event)}</span>
    </p>
  );
}

function eventLabel(event: WorkflowEvent) {
  if (event.type === 'log') return event.level;
  if (event.type === 'ui_feedback') return 'feedback';
  return event.event;
}

function eventMessage(event: WorkflowEvent) {
  if (event.type === 'log') return event.message;
  if (event.type === 'ui_feedback') return event.message ?? event.phase ?? 'ui feedback';
  return `run ${event.runId}`;
}

function eventTone(event: WorkflowEvent) {
  if (event.type === 'log') {
    if (event.level === 'error') return 'text-error';
    if (event.level === 'warning') return 'text-amber';
    if (event.level === 'debug') return 'text-fg-subtle';
    return 'text-blue';
  }
  if (event.type === 'lifecycle') {
    if (event.event === 'failed') return 'text-error';
    if (event.event === 'done') return 'text-green';
    return 'text-cyan';
  }
  if (event.kind === 'error') return 'text-error';
  if (event.kind === 'warning') return 'text-amber';
  return 'text-fg-subtle';
}

function formatEventTime(ts: string) {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return ts;
  return date.toLocaleTimeString([], {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
