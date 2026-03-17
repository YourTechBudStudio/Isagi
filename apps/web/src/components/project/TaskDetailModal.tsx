import { AnimatePresence, motion } from "framer-motion";
import {
  AlignLeft,
  CalendarIcon,
  Check,
  ChevronDown,
  FlagIcon,
  Layers,
  Play,
  RefreshCw,
  TagIcon,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { CalendarPopover } from "@/components/ui/CalendarPopover";
import { IconButton } from "@/components/ui/IconButton";
import { Popover } from "@/components/ui/Popover";
import { cn } from "@/lib/cn";
import type {
  MockTask,
  TaskPriority,
  TaskStatus,
} from "@/lib/mock/project.mock";
import { getPriorityColor } from "@/lib/utils/task-utils";

// ─── Types ───────────────────────────────────────────────────

type TaskDetailModalProps = {
  readonly taskId: string | null;
  readonly tasks: ReadonlyArray<MockTask>;
  readonly collectionOptions: ReadonlyArray<string>;
  readonly onClose: () => void;
  readonly onUpdateTask: (task: MockTask) => void;
};

// ─── Constants ───────────────────────────────────────────────

const STATUS_OPTIONS: ReadonlyArray<{
  value: TaskStatus;
  label: string;
  tone: "blue" | "green" | "neutral";
}> = [
  { value: "todo", label: "To Do", tone: "neutral" },
  { value: "in_progress", label: "In Progress", tone: "blue" },
  { value: "done", label: "Done", tone: "green" },
];

const PRIORITY_OPTIONS: ReadonlyArray<{
  value: TaskPriority;
  label: string;
}> = [
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
];

// ─── Component ───────────────────────────────────────────────

export function TaskDetailModal({
  taskId,
  tasks,
  collectionOptions,
  onClose,
  onUpdateTask,
}: TaskDetailModalProps) {
  const navigate = useNavigate();
  const task = tasks.find(t => t.id === taskId);

  // Popover open states
  const [statusOpen, setStatusOpen] = useState(false);
  const [priorityOpen, setPriorityOpen] = useState(false);
  const [collectionOpen, setCollectionOpen] = useState(false);
  const [calendarOpen, setCalendarOpen] = useState(false);

  // Anchor refs for popovers
  const statusRef = useRef<HTMLButtonElement>(null);
  const priorityRef = useRef<HTMLButtonElement>(null);
  const collectionRef = useRef<HTMLButtonElement>(null);
  const dateRef = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLTextAreaElement>(null);

  // Close on escape key (only when no popover is open)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.key === "Escape" &&
        !statusOpen &&
        !priorityOpen &&
        !collectionOpen &&
        !calendarOpen
      ) {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, statusOpen, priorityOpen, collectionOpen, calendarOpen]);

  // Auto-resize the title textarea
  useEffect(() => {
    if (titleRef.current) {
      titleRef.current.style.height = "auto";
      titleRef.current.style.height = `${titleRef.current.scrollHeight}px`;
    }
  }, [task?.title]);

  // If taskId was given but task not found, bail
  if (!task && taskId) return null;

  // ─── Handlers ──────────────────────────────────────────────

  const handleTitleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    if (!task) return;
    onUpdateTask({ ...task, title: e.target.value });
  };

  const handleNotesChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    if (!task) return;
    onUpdateTask({ ...task, notes: e.target.value });
  };

  const handleStatusChange = (status: TaskStatus) => {
    if (!task) return;
    onUpdateTask({ ...task, status });
    setStatusOpen(false);
  };

  const handlePriorityChange = (priority: TaskPriority) => {
    if (!task) return;
    onUpdateTask({ ...task, priority });
    setPriorityOpen(false);
  };

  const handleCollectionChange = (collection: string | undefined) => {
    if (!task) return;
    onUpdateTask({ ...task, collection });
    setCollectionOpen(false);
  };

  const handleDueDateChange = (date: string | undefined) => {
    if (!task) return;
    onUpdateTask({ ...task, dueDate: date });
  };

  // ─── Derived state ────────────────────────────────────────

  const isDone = task?.status === "done";

  // Derive primary and secondary sessions
  const openSessions = task?.openSessions ?? [];
  const primarySession = openSessions.find(s => s.isActive) ?? openSessions[0];
  const secondarySessions = openSessions.filter(s => s !== primarySession);

  // Determine CTA label from openSessions if available, else fall back to sessionState
  const getCtaConfig = () => {
    if (openSessions.length > 0 && primarySession) {
      if (primarySession.isActive) {
        return {
          label: "Return to Active Session",
          icon: (
            <div className="bg-accent-violet h-2 w-2 animate-pulse rounded-full" />
          ),
          variant: "secondary" as const,
          sessionId: primarySession.id,
          accentClass:
            "bg-accent-violet/10 text-accent-violet border-accent-violet/20 hover:bg-accent-violet/15",
        };
      }
      return {
        label: "Resume Session",
        icon: <RefreshCw className="h-3.5 w-3.5" />,
        variant: "primary" as const,
        sessionId: primarySession.id,
        accentClass: "",
      };
    }

    // Fall back to legacy sessionState
    if (!task) return null;
    if (task.sessionState === "active") {
      return {
        label: "Return to Active Session",
        icon: (
          <div className="bg-accent-violet h-2 w-2 animate-pulse rounded-full" />
        ),
        variant: "secondary" as const,
        sessionId: task.id,
        accentClass:
          "bg-accent-violet/10 text-accent-violet border-accent-violet/20 hover:bg-accent-violet/15",
      };
    }
    if (task.sessionState === "resume") {
      return {
        label: "Resume Session",
        icon: <RefreshCw className="h-3.5 w-3.5" />,
        variant: "primary" as const,
        sessionId: task.id,
        accentClass: "",
      };
    }
    return {
      label: "Start Session",
      icon: <Play className="h-3.5 w-3.5" />,
      variant: "primary" as const,
      sessionId: task.id,
      accentClass: "",
    };
  };

  const ctaConfig = task ? getCtaConfig() : null;

  // ─── Render ────────────────────────────────────────────────

  return (
    <AnimatePresence>
      {task && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25, ease: "easeOut" }}
            className="bg-canvas/50 fixed inset-0 z-50 backdrop-blur-sm"
            onClick={onClose}
          />

          {/* Centered modal */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{
              type: "spring",
              damping: 22,
              stiffness: 260,
              mass: 0.8,
            }}
            className="bg-canvas-elevated fixed inset-0 z-50 m-auto flex h-fit max-h-[85vh] w-[520px] max-w-[calc(100vw-3rem)] flex-col overflow-hidden rounded-2xl border border-white/10 shadow-2xl"
          >
            {/* Header */}
            <div className="flex items-center justify-between border-b border-white/5 px-6 py-4">
              <div className="flex items-center gap-3">
                <span className="text-text-tertiary font-mono text-xs tracking-wider">
                  {task.id}
                </span>

                {/* Status dropdown trigger */}
                <button
                  ref={statusRef}
                  type="button"
                  onClick={() => setStatusOpen(!statusOpen)}
                  className="inline-flex cursor-pointer items-center gap-1"
                >
                  <Badge
                    tone={
                      task.status === "done"
                        ? "green"
                        : task.status === "in_progress"
                          ? "blue"
                          : "neutral"
                    }
                    className={cn(
                      "transition-colors select-none",
                      task.status === "todo" && "border-white/10 bg-white/5",
                    )}
                  >
                    {task.status.replace("_", " ")}
                  </Badge>
                  <ChevronDown className="text-text-tertiary h-3 w-3" />
                </button>

                <Popover
                  open={statusOpen}
                  onClose={() => setStatusOpen(false)}
                  anchorRef={statusRef}
                  minWidth={160}
                >
                  <div className="py-1">
                    {STATUS_OPTIONS.map(opt => (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => handleStatusChange(opt.value)}
                        className="text-text-primary flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors hover:bg-white/5"
                      >
                        <Badge tone={opt.tone} className="text-[10px]">
                          {opt.label}
                        </Badge>
                        {task.status === opt.value && (
                          <Check className="text-accent-blue ml-auto h-3.5 w-3.5" />
                        )}
                      </button>
                    ))}
                  </div>
                </Popover>
              </div>
              <IconButton
                icon={<X className="h-5 w-5" />}
                onClick={onClose}
                aria-label="Close"
              />
            </div>

            {/* Scrollable body */}
            <div className="flex-1 overflow-y-auto px-6 pt-6 pb-8">
              {/* Title (auto-sizing textarea) */}
              <textarea
                ref={titleRef}
                value={task.title}
                onChange={handleTitleChange}
                rows={1}
                className="text-text-primary placeholder:text-text-tertiary/50 font-display mb-6 w-full resize-none overflow-hidden bg-transparent text-xl leading-snug font-semibold tracking-tight outline-none"
                placeholder="Task title..."
              />

              {/* Session CTA area */}
              <div className="mb-8">
                {isDone ? (
                  <div className="bg-canvas-subtle/50 text-text-tertiary rounded-xl border border-white/5 px-4 py-3 text-center text-sm">
                    Task complete. Change status to reopen.
                  </div>
                ) : ctaConfig ? (
                  <div className="flex flex-col gap-2.5">
                    {/* Primary CTA */}
                    <Button
                      variant={ctaConfig.variant}
                      size="md"
                      className={cn("w-full", ctaConfig.accentClass)}
                      onClick={() =>
                        navigate(`/session/${ctaConfig.sessionId}`)
                      }
                    >
                      {ctaConfig.icon}
                      {ctaConfig.label}
                    </Button>

                    {/* Secondary sessions */}
                    {secondarySessions.length > 0 && (
                      <div className="flex flex-col gap-0.5 overflow-hidden rounded-xl border border-white/5">
                        {secondarySessions.map(session => (
                          <div
                            key={session.id}
                            className="flex items-center justify-between px-3.5 py-2.5 transition-colors hover:bg-white/[0.02]"
                          >
                            <span className="text-text-secondary text-sm">
                              {session.label}
                            </span>
                            <button
                              type="button"
                              onClick={() => navigate(`/session/${session.id}`)}
                              className="text-text-tertiary hover:text-text-primary flex items-center gap-1.5 text-xs font-medium transition-colors"
                            >
                              <RefreshCw className="h-3 w-3" />
                              Resume
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ) : null}
              </div>

              {/* Metadata grid */}
              <div className="mb-8 grid grid-cols-2 gap-x-4 gap-y-5">
                {/* Priority */}
                <div className="flex flex-col gap-1.5">
                  <span className="text-text-tertiary flex items-center gap-1.5 text-[11px] font-medium tracking-wider uppercase">
                    <FlagIcon className="h-3 w-3" /> Priority
                  </span>
                  <button
                    ref={priorityRef}
                    type="button"
                    onClick={() => setPriorityOpen(!priorityOpen)}
                    className="inline-flex cursor-pointer items-center gap-1 self-start"
                  >
                    <Badge
                      tone={
                        getPriorityColor(task.priority) as
                          | "red"
                          | "amber"
                          | "blue"
                          | "neutral"
                      }
                    >
                      {task.priority}
                    </Badge>
                    <ChevronDown className="text-text-tertiary h-3 w-3" />
                  </button>

                  <Popover
                    open={priorityOpen}
                    onClose={() => setPriorityOpen(false)}
                    anchorRef={priorityRef}
                    minWidth={140}
                  >
                    <div className="py-1">
                      {PRIORITY_OPTIONS.map(opt => (
                        <button
                          key={opt.value}
                          type="button"
                          onClick={() => handlePriorityChange(opt.value)}
                          className="text-text-primary flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors hover:bg-white/5"
                        >
                          <Badge
                            tone={
                              getPriorityColor(opt.value) as
                                | "red"
                                | "amber"
                                | "blue"
                                | "neutral"
                            }
                            className="text-[10px]"
                          >
                            {opt.label}
                          </Badge>
                          {task.priority === opt.value && (
                            <Check className="text-accent-blue ml-auto h-3.5 w-3.5" />
                          )}
                        </button>
                      ))}
                    </div>
                  </Popover>
                </div>

                {/* Due Date */}
                <div className="flex flex-col gap-1.5">
                  <span className="text-text-tertiary flex items-center gap-1.5 text-[11px] font-medium tracking-wider uppercase">
                    <CalendarIcon className="h-3 w-3" /> Due Date
                  </span>
                  <button
                    ref={dateRef}
                    type="button"
                    onClick={() => setCalendarOpen(!calendarOpen)}
                    className={cn(
                      "inline-flex cursor-pointer items-center gap-1.5 self-start rounded-lg px-2 py-1 text-sm transition-colors hover:bg-white/5",
                      task.dueDate
                        ? "text-text-secondary"
                        : "text-text-tertiary/50",
                    )}
                  >
                    <span className="font-mono text-[13px]">
                      {task.dueDate ?? "Set date"}
                    </span>
                    <ChevronDown className="text-text-tertiary h-3 w-3" />
                  </button>

                  <CalendarPopover
                    open={calendarOpen}
                    onClose={() => setCalendarOpen(false)}
                    anchorRef={dateRef}
                    value={task.dueDate}
                    onChange={handleDueDateChange}
                  />
                </div>

                {/* Collection */}
                <div className="flex flex-col gap-1.5">
                  <span className="text-text-tertiary flex items-center gap-1.5 text-[11px] font-medium tracking-wider uppercase">
                    <Layers className="h-3 w-3" /> Collection
                  </span>
                  <button
                    ref={collectionRef}
                    type="button"
                    onClick={() => setCollectionOpen(!collectionOpen)}
                    className={cn(
                      "inline-flex cursor-pointer items-center gap-1.5 self-start rounded-lg px-2 py-1 text-sm transition-colors hover:bg-white/5",
                      task.collection
                        ? "text-text-secondary"
                        : "text-text-tertiary/50",
                    )}
                  >
                    {task.collection ?? "No collection"}
                    <ChevronDown className="text-text-tertiary h-3 w-3" />
                  </button>

                  <Popover
                    open={collectionOpen}
                    onClose={() => setCollectionOpen(false)}
                    anchorRef={collectionRef}
                    minWidth={180}
                  >
                    <div className="py-1">
                      <button
                        type="button"
                        onClick={() => handleCollectionChange(undefined)}
                        className="text-text-tertiary flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors hover:bg-white/5"
                      >
                        None
                        {!task.collection && (
                          <Check className="text-accent-blue ml-auto h-3.5 w-3.5" />
                        )}
                      </button>
                      {collectionOptions.map(opt => (
                        <button
                          key={opt}
                          type="button"
                          onClick={() => handleCollectionChange(opt)}
                          className="text-text-primary flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors hover:bg-white/5"
                        >
                          {opt}
                          {task.collection === opt && (
                            <Check className="text-accent-blue ml-auto h-3.5 w-3.5" />
                          )}
                        </button>
                      ))}
                    </div>
                  </Popover>
                </div>

                {/* Labels (read-only for MVP) */}
                <div className="flex flex-col gap-1.5">
                  <span className="text-text-tertiary flex items-center gap-1.5 text-[11px] font-medium tracking-wider uppercase">
                    <TagIcon className="h-3 w-3" /> Labels
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {task.labels.length > 0 ? (
                      task.labels.map(label => (
                        <Badge
                          key={label}
                          tone="neutral"
                          className="border-white/10 bg-white/5"
                        >
                          {label}
                        </Badge>
                      ))
                    ) : (
                      <span className="text-text-tertiary/50 px-2 py-1 text-sm">
                        None
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {/* Notes */}
              <div className="flex flex-col gap-2.5 border-t border-white/5 pt-6">
                <span className="text-text-tertiary flex items-center gap-1.5 text-[11px] font-medium tracking-wider uppercase">
                  <AlignLeft className="h-3 w-3" /> Notes
                </span>
                <textarea
                  value={task.notes ?? ""}
                  onChange={handleNotesChange}
                  placeholder="Your future self will thank you. Or blame you. Either way, leave a note."
                  className="text-text-secondary placeholder:text-text-tertiary/40 bg-canvas-subtle focus:bg-canvas min-h-[100px] w-full resize-y rounded-xl border border-white/5 px-4 py-3 text-sm leading-relaxed transition-colors outline-none focus:border-white/10 focus:ring-1 focus:ring-white/10"
                />
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
