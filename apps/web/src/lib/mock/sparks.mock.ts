export type SparkStatus = "backlog" | "generating" | "triaging";

export type Spark = {
  readonly id: string;
  readonly title?: string;
  readonly rawSnippet: string;
  readonly createdAt: string;
  readonly status: SparkStatus;
  readonly waitingOnUser?: boolean;
  readonly activeStatusText?: string;
};

export const mockActiveTriages: ReadonlyArray<Spark> = [
  {
    id: "active-1",
    title: "Database schema for sparks",
    rawSnippet: "Need to figure out if we use SQLite or Postgres for this.",
    createdAt: "2024-03-10T10:00:00Z",
    status: "triaging",
    waitingOnUser: true,
    activeStatusText: "Agent proposed schema changes",
  },
  {
    id: "active-2",
    title: "Migrate away from CRA",
    rawSnippet: "Vite is much faster, let's move the dashboard over.",
    createdAt: "2024-03-09T14:30:00Z",
    status: "triaging",
    waitingOnUser: false,
    activeStatusText: "Agent is plotting...",
  },
  {
    id: "active-3",
    title: "Implement Voice Dictation",
    rawSnippet: "We need an easy way to capture sparks while walking.",
    createdAt: "2024-03-09T10:15:00Z",
    status: "triaging",
    waitingOnUser: true,
    activeStatusText: "Waiting on your reply",
  },
  {
    id: "active-4",
    title: "Add offline caching",
    rawSnippet: "Service workers are cool but tricky. Need a simple strategy.",
    createdAt: "2024-03-08T16:45:00Z",
    status: "triaging",
    waitingOnUser: false,
    activeStatusText: "Agent is reviewing code...",
  },
  {
    id: "active-5",
    title: "Design system token refresh",
    rawSnippet: "Catppuccin Macchiato feels a bit too dark in the sidebar.",
    createdAt: "2024-03-08T09:30:00Z",
    status: "triaging",
    waitingOnUser: true,
    activeStatusText: "Please approve the palette changes",
  },
];

export const mockBacklogToday: ReadonlyArray<Spark> = [
  {
    id: "backlog-1",
    status: "generating",
    rawSnippet: "Add a dark mode toggle to the sidebar, maybe bottom left?",
    createdAt: "2024-03-11T09:15:00Z",
  },
  {
    id: "backlog-2",
    title: "Implement keyboard shortcuts for command palette",
    rawSnippet: "Cmd+K should open it. Esc to close. Arrow keys to navigate.",
    createdAt: "2024-03-11T08:00:00Z",
    status: "backlog",
  },
  {
    id: "backlog-3",
    title: "Fix the weird z-index issue on modals",
    rawSnippet: "The dropdown menu is hiding behind the sticky header again.",
    createdAt: "2024-03-11T07:45:00Z",
    status: "backlog",
  },
];

export const mockBacklogThisWeek: ReadonlyArray<Spark> = [
  {
    id: "backlog-4",
    title: "Design a new empty state for the inbox",
    rawSnippet: "Make it look cool when there's nothing to do.",
    createdAt: "2024-03-08T16:20:00Z",
    status: "backlog",
  },
  {
    id: "backlog-5",
    title: "Upgrade to React 19",
    rawSnippet: "Check if the compiler breaks any of our custom hooks.",
    createdAt: "2024-03-07T11:10:00Z",
    status: "backlog",
  },
];

export const mockBacklogOlder: ReadonlyArray<Spark> = [
  {
    id: "backlog-6",
    title: "Add offline support",
    rawSnippet: "Use service workers to cache the initial payload.",
    createdAt: "2024-02-15T10:00:00Z",
    status: "backlog",
  },
  {
    id: "backlog-7",
    title: "Implement voice dictation for sparks",
    rawSnippet: "Can we use Whisper for this? Need to check API costs.",
    createdAt: "2024-02-10T14:00:00Z",
    status: "backlog",
  },
];
