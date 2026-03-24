import type { MockTask, TaskPriority } from "@/lib/mock/project.mock";
import type {
  ProjectPriorityFilter,
  ProjectSortKey,
} from "@/lib/project-detail-storage";
import { getTaskPriorityTone } from "@/lib/task-ui";

const priorityWeight = {
  high: 0,
  medium: 1,
  low: 2,
} as const;

export function getPriorityColor(priority: TaskPriority) {
  return getTaskPriorityTone(priority);
}

export function getDueDateColor(dueDate?: string) {
  if (!dueDate) return "text-text-tertiary";

  const due = new Date(dueDate);
  const now = new Date();

  // Set times to midnight to only compare dates
  due.setHours(0, 0, 0, 0);
  now.setHours(0, 0, 0, 0);

  const diffTime = due.getTime() - now.getTime();
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

  if (diffDays < 0) {
    return "text-accent-red"; // Overdue
  } else if (diffDays <= 2) {
    return "text-accent-amber"; // Due today, tomorrow, or day after
  } else {
    return "text-text-tertiary"; // Due in future
  }
}

export function filterProjectTasks(
  tasks: ReadonlyArray<MockTask>,
  {
    searchQuery,
    priorityFilter,
    collectionFilter,
  }: {
    readonly searchQuery: string;
    readonly priorityFilter: ProjectPriorityFilter;
    readonly collectionFilter: string;
  },
): Array<MockTask> {
  const normalizedQuery = searchQuery.trim().toLowerCase();

  return tasks.filter(task => {
    const searchableText = [
      task.title,
      task.labels.join(" "),
      task.collection ?? "",
    ]
      .join(" ")
      .toLowerCase();

    const matchesSearch =
      normalizedQuery.length === 0 || searchableText.includes(normalizedQuery);
    const matchesPriority =
      priorityFilter === "all" || task.priority === priorityFilter;
    const matchesCollection =
      collectionFilter === "all" || task.collection === collectionFilter;

    return matchesSearch && matchesPriority && matchesCollection;
  });
}

export function sortProjectTasks(
  tasks: ReadonlyArray<MockTask>,
  sortKey: ProjectSortKey,
): Array<MockTask> {
  return [...tasks].sort((left, right) => {
    if (sortKey === "priority") {
      return priorityWeight[left.priority] - priorityWeight[right.priority];
    }

    if (left.dueDate && right.dueDate) {
      if (left.dueDate !== right.dueDate) {
        return left.dueDate.localeCompare(right.dueDate);
      }
    } else if (left.dueDate) {
      return -1;
    } else if (right.dueDate) {
      return 1;
    }

    return priorityWeight[left.priority] - priorityWeight[right.priority];
  });
}
