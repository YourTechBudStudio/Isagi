export type HomeResumeContext = {
  readonly title: string;
  readonly lastActiveLabel: string;
  readonly projectLabel: string;
};

export type HomeFocusQueueItem = {
  readonly id: string;
  readonly title: string;
  readonly project: string;
  readonly actionLabel?: string;
};

export type HomeSpark = {
  readonly id: string;
  readonly title: string;
  readonly time: string;
};

export const homeResumeContext: HomeResumeContext = {
  title: "Refactor Auth Flow",
  lastActiveLabel: "Last active 14m ago",
  projectLabel: "Project: Spark System MVP",
};

export const homeFocusQueueItems: ReadonlyArray<HomeFocusQueueItem> = [
  {
    id: "layout-shell",
    title: "Implement desktop layout shell",
    project: "Spark System MVP",
    actionLabel: "Start Session",
  },
  {
    id: "sqlite-setup",
    title: "Write setup instructions for SQLite",
    project: "Backend Foundation",
  },
];

export const homeSparks: ReadonlyArray<HomeSpark> = [
  { id: "worktree", title: "Git worktree parallelization", time: "2h ago" },
  { id: "mock", title: "New dashboard mock", time: "4h ago" },
  { id: "cra", title: "Migrate away from CRA", time: "Yesterday" },
];

export const homeInboxSparkCount = 12;
