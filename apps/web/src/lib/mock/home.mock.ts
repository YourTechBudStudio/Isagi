export type HomeResumeContext = {
  readonly title: string;
  readonly lastActiveLabel: string;
  readonly projectLabel: string;
};

export type HomeProject = {
  readonly id: string;
  readonly name: string;
};

export type HomeOpenSession = {
  readonly id: string;
  readonly title: string;
  readonly project: string;
  readonly actionLabel?: string;
};

export type HomeCandidateTask = {
  readonly id: string;
  readonly title: string;
  readonly project: string;
};

export type HomeSpark = {
  readonly id: string;
  readonly title: string;
  readonly time: string;
};

export type HomeScreenData = {
  readonly projects: ReadonlyArray<HomeProject>;
  readonly resumeContext: HomeResumeContext | null;
  readonly openSessions: ReadonlyArray<HomeOpenSession>;
  readonly candidateTasks: ReadonlyArray<HomeCandidateTask>;
};

export const homeProjects: ReadonlyArray<HomeProject> = [
  { id: "project-spark-system", name: "Spark System MVP" },
  { id: "project-backend-foundation", name: "Backend Foundation" },
  { id: "project-tooling", name: "Tooling" },
];

export const homeResumeContext: HomeResumeContext | null = {
  title: "Refactor Auth Flow",
  lastActiveLabel: "Last active 14m ago",
  projectLabel: "Project: Spark System MVP",
};

export const homeOpenSessions: ReadonlyArray<HomeOpenSession> = [
  {
    id: "layout-shell",
    title: "Implement desktop layout shell",
    project: "Spark System MVP",
    actionLabel: "Resume",
  },
  {
    id: "sqlite-setup",
    title: "Write setup instructions for SQLite",
    project: "Backend Foundation",
    actionLabel: "Resume",
  },
];

export const homeCandidateTasks: ReadonlyArray<HomeCandidateTask> = [
  {
    id: "task-1",
    title: "Setup Vitest for shared packages",
    project: "Tooling",
  },
  {
    id: "task-2",
    title: "Migrate remaining CRA apps to Vite",
    project: "Web SPA",
  },
  {
    id: "task-3",
    title: "Design generic error boundary component",
    project: "Spark System MVP",
  },
];

export const homeScreenData: HomeScreenData = {
  projects: homeProjects,
  resumeContext: homeResumeContext,
  openSessions: homeOpenSessions,
  candidateTasks: homeCandidateTasks,
};

export const homeSparks: ReadonlyArray<HomeSpark> = [
  { id: "worktree", title: "Git worktree parallelization", time: "2h ago" },
  { id: "mock", title: "New dashboard mock", time: "4h ago" },
  { id: "cra", title: "Migrate away from CRA", time: "Yesterday" },
];

export const homeInboxSparkCount = 12;
