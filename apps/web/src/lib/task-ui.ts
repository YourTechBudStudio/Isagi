import type {
  MockOpenSession,
  TaskPriority,
  TaskStatus,
} from "@/lib/mock/project.mock";

export type TaskBadgeTone =
  | "blue"
  | "green"
  | "violet"
  | "amber"
  | "red"
  | "cyan"
  | "neutral";

export const TASK_STATUS_META: Record<
  TaskStatus,
  { readonly label: string; readonly tone: TaskBadgeTone }
> = {
  todo: { label: "To Do", tone: "neutral" },
  in_progress: { label: "In Progress", tone: "blue" },
  done: { label: "Done", tone: "green" },
};

export const TASK_PRIORITY_META: Record<
  TaskPriority,
  { readonly label: string; readonly tone: TaskBadgeTone }
> = {
  high: { label: "High", tone: "red" },
  medium: { label: "Medium", tone: "amber" },
  low: { label: "Low", tone: "blue" },
};

export const TASK_STATUS_OPTIONS = Object.entries(TASK_STATUS_META).map(
  ([value, meta]) => ({
    value: value as TaskStatus,
    label: meta.label,
    tone: meta.tone,
  }),
);

export const TASK_PRIORITY_OPTIONS = Object.entries(TASK_PRIORITY_META).map(
  ([value, meta]) => ({
    value: value as TaskPriority,
    label: meta.label,
    tone: meta.tone,
  }),
);

export function formatTaskStatus(status: TaskStatus): string {
  return TASK_STATUS_META[status].label;
}

export function formatTaskPriority(priority: TaskPriority): string {
  return TASK_PRIORITY_META[priority].label;
}

export function getTaskPriorityTone(priority: TaskPriority): TaskBadgeTone {
  return TASK_PRIORITY_META[priority].tone;
}

export function getTaskStatusTone(status: TaskStatus): TaskBadgeTone {
  return TASK_STATUS_META[status].tone;
}

export function getOpenSessionLabel(session: MockOpenSession): string {
  return session.label;
}
