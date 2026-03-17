import { GitBranch, GitFork, MessageSquareMore, Workflow } from "lucide-react";

import type {
  EditableStatus,
  GitMode,
  StatusBucket,
} from "@/components/project/settings/projectSettings.types";

export const GIT_MODE_OPTIONS: ReadonlyArray<{
  value: GitMode;
  label: string;
  description: string;
  icon: typeof GitBranch;
  activeColor: string;
}> = [
  {
    value: "same_branch",
    label: "Same branch",
    description: "Stay on the currently checked-out branch.",
    icon: GitBranch,
    activeColor: "text-accent-blue",
  },
  {
    value: "managed_worktree",
    label: "Managed worktree",
    description: "Auto-create an isolated worktree per session.",
    icon: GitFork,
    activeColor: "text-accent-green",
  },
  {
    value: "ask_each_time",
    label: "Ask each time",
    description: "Prompt for the git strategy at session start.",
    icon: MessageSquareMore,
    activeColor: "text-accent-amber",
  },
  {
    value: "global_default",
    label: "Use global default",
    description: "Inherit from your global Isagi configuration.",
    icon: Workflow,
    activeColor: "text-accent-cyan",
  },
];

export const INITIAL_STATUSES: Array<EditableStatus> = [
  { id: "todo", name: "To Do", bucket: "todo" },
  { id: "in_progress", name: "In Progress", bucket: "in_progress" },
  { id: "in_review", name: "In Review", bucket: "in_progress" },
  { id: "done", name: "Done", bucket: "done" },
];

export function getBucketTone(
  bucket: StatusBucket,
): "neutral" | "blue" | "green" {
  if (bucket === "in_progress") {
    return "blue";
  }

  if (bucket === "done") {
    return "green";
  }

  return "neutral";
}

export function getBucketLabel(bucket: StatusBucket): string {
  if (bucket === "in_progress") {
    return "In Progress";
  }

  if (bucket === "done") {
    return "Done";
  }

  return "To Do";
}

export function getInitialRepoPath(projectName: string): string {
  const slug = projectName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return `/home/yourtechbud/work/projects/${slug.replace(/^-|-$/g, "")}`;
}
