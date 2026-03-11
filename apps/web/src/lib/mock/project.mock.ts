export type TaskStatus = "todo" | "in_progress" | "done";
export type TaskPriority = "low" | "medium" | "high";
export type SessionState = "none" | "resume" | "active";

export type MockOpenSession = {
  readonly id: string;
  readonly label: string;
  readonly isActive: boolean;
};

export type MockTask = {
  readonly id: string;
  readonly title: string;
  readonly status: TaskStatus;
  readonly priority: TaskPriority;
  readonly dueDate?: string;
  readonly labels: ReadonlyArray<string>;
  readonly collection?: string;
  readonly sessionState: SessionState;
  readonly notes?: string;
  readonly openSessions?: ReadonlyArray<MockOpenSession>;
};

export type MockProjectData = {
  readonly id: string;
  readonly name: string;
  readonly tasks: ReadonlyArray<MockTask>;
};

export const mockProjectCore: MockProjectData = {
  id: "proj-core",
  name: "Isagi Core Engine",
  tasks: [
    {
      id: "t-1",
      title: "Implement parallel git worktrees",
      status: "in_progress",
      priority: "high",
      labels: ["core", "git"],
      collection: "Q1 Milestones",
      sessionState: "active",
      dueDate: "2026-03-15",
      notes:
        "Need to make sure we don't clobber the primary index. Look into `git worktree add` and how it handles detached HEAD states. Might need to write a custom wrapper script for the agents.",
      openSessions: [
        { id: "s-1a", label: "Session #3 — 12 min ago", isActive: true },
        { id: "s-1b", label: "Session #2 — 2h ago", isActive: false },
        { id: "s-1c", label: "Session #1 — yesterday", isActive: false },
      ],
    },
    {
      id: "t-2",
      title: "Fix ContextSidebar truncation",
      status: "todo",
      priority: "medium",
      labels: ["ui", "bug"],
      sessionState: "resume",
      notes:
        "The project titles are bleeding over the edge on 13-inch displays. Probably just needs a `truncate` utility class and `min-w-0` on the flex child.",
    },
    {
      id: "t-3",
      title: "Audit package.json dependencies",
      status: "todo",
      priority: "low",
      labels: ["maintenance"],
      sessionState: "none",
      dueDate: "2026-03-20",
    },
    {
      id: "t-4",
      title: "Setup SSE for real-time spark updates",
      status: "done",
      priority: "high",
      labels: ["api", "realtime"],
      collection: "Realtime Infrastructure",
      sessionState: "none",
    },
    {
      id: "t-5",
      title: "Design terminal output streaming format",
      status: "in_progress",
      priority: "medium",
      labels: ["api", "design"],
      collection: "Realtime Infrastructure",
      sessionState: "none",
    },
    {
      id: "t-6",
      title: "Add SQLite caching layer for sparks",
      status: "todo",
      priority: "high",
      labels: ["core", "db"],
      collection: "Q1 Milestones",
      sessionState: "none",
    },
  ],
};

export const mockProjectEmpty: MockProjectData = {
  id: "proj-new",
  name: "Greenfield Project",
  tasks: [],
};

// Simple lookup helper
export const getMockProject = (id: string): MockProjectData | undefined => {
  if (id === "proj-core") return mockProjectCore;
  if (id === "proj-new") return mockProjectEmpty;
  // Default to core for random IDs to avoid empty states by mistake
  return { ...mockProjectCore, id, name: `Project ${id}` };
};
