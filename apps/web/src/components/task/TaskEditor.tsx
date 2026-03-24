import {
  AlignLeft,
  CalendarIcon,
  Check,
  ChevronDown,
  FlagIcon,
  Layers,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { TaskLabelsField } from "@/components/task/TaskLabelsField";
import { Badge } from "@/components/ui/Badge";
import { CalendarPopover } from "@/components/ui/CalendarPopover";
import { IconButton } from "@/components/ui/IconButton";
import { Popover } from "@/components/ui/Popover";
import { cn } from "@/lib/cn";
import { useAutoResizeTextarea } from "@/lib/hooks/useAutoResizeTextarea";
import type {
  MockTask,
  TaskPriority,
  TaskStatus,
} from "@/lib/mock/project.mock";
import {
  formatTaskStatus,
  getTaskPriorityTone,
  getTaskStatusTone,
  TASK_PRIORITY_OPTIONS,
  TASK_STATUS_OPTIONS,
} from "@/lib/task-ui";

type TaskEditorProps = {
  readonly task: MockTask;
  readonly availableLabels: ReadonlyArray<string>;
  readonly collectionOptions: ReadonlyArray<string>;
  readonly onClose: () => void;
  readonly onUpdateTask: (task: MockTask) => void;
  readonly beforeMetadata?: ReactNode;
  readonly afterNotes?: ReactNode;
  readonly closeButtonVariant?: "ghost" | "subtle";
  readonly enableEscapeClose?: boolean;
};

export function TaskEditor({
  task,
  availableLabels,
  collectionOptions,
  onClose,
  onUpdateTask,
  beforeMetadata,
  afterNotes,
  closeButtonVariant = "ghost",
  enableEscapeClose = false,
}: TaskEditorProps) {
  const [statusOpen, setStatusOpen] = useState(false);
  const [priorityOpen, setPriorityOpen] = useState(false);
  const [collectionOpen, setCollectionOpen] = useState(false);
  const [calendarOpen, setCalendarOpen] = useState(false);

  const statusRef = useRef<HTMLButtonElement>(null);
  const priorityRef = useRef<HTMLButtonElement>(null);
  const collectionRef = useRef<HTMLButtonElement>(null);
  const dateRef = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const notesRef = useRef<HTMLTextAreaElement>(null);

  useAutoResizeTextarea(titleRef, task.title);
  useAutoResizeTextarea(notesRef, task.notes);

  useEffect(() => {
    if (!enableEscapeClose) {
      return;
    }

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
  }, [
    calendarOpen,
    collectionOpen,
    enableEscapeClose,
    onClose,
    priorityOpen,
    statusOpen,
  ]);

  const updateTask = (updates: Partial<MockTask>) => {
    onUpdateTask({ ...task, ...updates });
  };

  const handleStatusChange = (status: TaskStatus) => {
    updateTask({ status });
    setStatusOpen(false);
  };

  const handlePriorityChange = (priority: TaskPriority) => {
    updateTask({ priority });
    setPriorityOpen(false);
  };

  const handleCollectionChange = (collection: string | undefined) => {
    updateTask({ collection });
    setCollectionOpen(false);
  };

  const isDone = task.status === "done";

  return (
    <>
      <div className="flex items-center justify-between border-b border-white/5 px-6 py-4">
        <div className="flex items-center gap-3">
          <span className="text-text-tertiary font-mono text-xs tracking-wider">
            {task.id}
          </span>

          <button
            ref={statusRef}
            type="button"
            onClick={() => setStatusOpen(open => !open)}
            className="inline-flex cursor-pointer items-center gap-1"
          >
            <Badge
              tone={getTaskStatusTone(task.status)}
              className={cn(
                "transition-colors select-none",
                task.status === "todo" && "border-white/10 bg-white/5",
              )}
            >
              {formatTaskStatus(task.status)}
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
              {TASK_STATUS_OPTIONS.map(option => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => handleStatusChange(option.value)}
                  className="text-text-primary flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors hover:bg-white/5"
                >
                  <Badge tone={option.tone} className="text-[10px]">
                    {option.label}
                  </Badge>
                  {task.status === option.value && (
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
          variant={closeButtonVariant}
        />
      </div>

      <div className="flex flex-1 flex-col overflow-y-auto px-6 pt-6 pb-8">
        <textarea
          ref={titleRef}
          value={task.title}
          onChange={e => updateTask({ title: e.target.value })}
          rows={1}
          className="text-text-primary placeholder:text-text-tertiary/50 font-display mb-6 w-full resize-none overflow-hidden bg-transparent text-xl leading-snug font-semibold tracking-tight outline-none"
          placeholder="Task title..."
        />

        {beforeMetadata ? <div className="mb-8">{beforeMetadata}</div> : null}

        <div className="mb-8 grid grid-cols-2 gap-x-4 gap-y-5">
          <div className="flex flex-col gap-1.5">
            <span className="text-text-tertiary flex items-center gap-1.5 text-[11px] font-medium tracking-wider uppercase">
              <FlagIcon className="h-3 w-3" /> Priority
            </span>
            <button
              ref={priorityRef}
              type="button"
              onClick={() => setPriorityOpen(open => !open)}
              className="inline-flex cursor-pointer items-center gap-1 self-start"
            >
              <Badge tone={getTaskPriorityTone(task.priority)}>
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
                {TASK_PRIORITY_OPTIONS.map(option => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => handlePriorityChange(option.value)}
                    className="text-text-primary flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors hover:bg-white/5"
                  >
                    <Badge tone={option.tone} className="text-[10px]">
                      {option.label}
                    </Badge>
                    {task.priority === option.value && (
                      <Check className="text-accent-blue ml-auto h-3.5 w-3.5" />
                    )}
                  </button>
                ))}
              </div>
            </Popover>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-text-tertiary flex items-center gap-1.5 text-[11px] font-medium tracking-wider uppercase">
              <CalendarIcon className="h-3 w-3" /> Due Date
            </span>
            <button
              ref={dateRef}
              type="button"
              onClick={() => setCalendarOpen(open => !open)}
              className={cn(
                "inline-flex cursor-pointer items-center gap-1.5 self-start rounded-lg px-2 py-1 text-sm transition-colors hover:bg-white/5",
                task.dueDate ? "text-text-secondary" : "text-text-tertiary/50",
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
              onChange={dueDate => updateTask({ dueDate })}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-text-tertiary flex items-center gap-1.5 text-[11px] font-medium tracking-wider uppercase">
              <Layers className="h-3 w-3" /> Collection
            </span>
            <button
              ref={collectionRef}
              type="button"
              onClick={() => setCollectionOpen(open => !open)}
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

                {collectionOptions.map(option => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => handleCollectionChange(option)}
                    className="text-text-primary flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors hover:bg-white/5"
                  >
                    {option}
                    {task.collection === option && (
                      <Check className="text-accent-blue ml-auto h-3.5 w-3.5" />
                    )}
                  </button>
                ))}
              </div>
            </Popover>
          </div>

          <TaskLabelsField
            selectedLabels={task.labels}
            availableLabels={availableLabels}
            onChange={labels => updateTask({ labels })}
          />
        </div>

        <div className="flex flex-col gap-2.5 border-t border-white/5 pt-6">
          <span className="text-text-tertiary flex items-center gap-1.5 text-[11px] font-medium tracking-wider uppercase">
            <AlignLeft className="h-3 w-3" /> Notes
          </span>
          <textarea
            ref={notesRef}
            value={task.notes ?? ""}
            onChange={e => updateTask({ notes: e.target.value })}
            placeholder="Your future self will thank you. Or blame you. Either way, leave a note."
            rows={Math.max(
              isDone ? 4 : 6,
              (task.notes ?? "").split("\n").length,
            )}
            className="text-text-secondary placeholder:text-text-tertiary/40 bg-canvas-subtle focus:bg-canvas min-h-25 w-full resize-none overflow-hidden rounded-xl border border-white/5 px-4 py-3 text-sm leading-relaxed transition-colors outline-none focus:border-white/10 focus:ring-1 focus:ring-white/10"
          />
        </div>

        {afterNotes ? <div className="mt-8">{afterNotes}</div> : null}
      </div>
    </>
  );
}
