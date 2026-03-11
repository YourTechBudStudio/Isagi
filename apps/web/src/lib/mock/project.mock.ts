export type TaskStatus = "todo" | "in_progress" | "done";
export type TaskPriority = "low" | "medium" | "high";
export type SessionState = "none" | "resume" | "active";

export type MockTask = {
  readonly id: string;
  readonly title: string;
  readonly status: TaskStatus;
  readonly priority: TaskPriority;
  readonly dueDate?: string;
  readonly labels: ReadonlyArray<string>;
  readonly collection?: string;
  readonly sessionState: SessionState;
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
    },
    {
      id: "t-2",
      title: "Fix ContextSidebar truncation",
      status: "todo",
      priority: "medium",
      labels: ["ui", "bug"],
      sessionState: "resume",
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
      sessionState: "none",
    },
    {
      id: "t-5",
      title: "Design terminal output streaming format",
      status: "in_progress",
      priority: "medium",
      labels: ["api", "design"],
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
