/** Mock data for the home screen. Swap for real API calls later. */

export interface ResumeItem {
  readonly workItemTitle: string;
  readonly agentSnippet: string;
  readonly updatedAgo: string;
}

export interface FocusQueueItem {
  readonly id: string;
  readonly type: "waiting" | "suggested";
  readonly title: string;
  readonly subtitle: string;
  readonly updatedAgo: string;
}

export interface SparkItem {
  readonly id: string;
  readonly text: string;
  readonly capturedAgo: string;
}

export interface BacklogMetrics {
  readonly storylinesReady: number;
  readonly draftsReady: number;
  readonly sparksAwaiting: number;
  readonly waitingOnYou: number;
}

// ── Resume ──

export const MOCK_RESUME: ResumeItem = {
  workItemTitle: "Refactor notification batching",
  agentSnippet:
    "I drafted three batching strategies. Want to compare trade-offs?",
  updatedAgo: "12m ago",
};

// ── Focus Queue ──

export const MOCK_FOCUS_QUEUE: readonly FocusQueueItem[] = [
  {
    id: "fq-1",
    type: "waiting",
    title: "API rate-limit strategy",
    subtitle: "Agent needs your call: token bucket vs leaky bucket",
    updatedAgo: "4m ago",
  },
  {
    id: "fq-2",
    type: "waiting",
    title: "Onboarding copy review",
    subtitle: "Three variants ready. Pick your favorite (or roast them all)",
    updatedAgo: "23m ago",
  },
  {
    id: "fq-3",
    type: "suggested",
    title: "Tighten error handling in capture flow",
    subtitle: "Quick win — estimated 5 min on phone",
    updatedAgo: "1h ago",
  },
  {
    id: "fq-4",
    type: "suggested",
    title: "Review spark: 'offline-first sync queue'",
    subtitle: "Triager wants to break this into sub-tasks",
    updatedAgo: "3h ago",
  },
];

// ── Sparks awaiting triage ──

export const MOCK_SPARKS: readonly SparkItem[] = [
  {
    id: "sp-1",
    text: "What if we let users bookmark agent suggestions mid-conversation?",
    capturedAgo: "2h ago",
  },
  {
    id: "sp-2",
    text: "Explore edge caching for STT results",
    capturedAgo: "5h ago",
  },
  {
    id: "sp-3",
    text: "Dark mode should respect system theme AND have manual override",
    capturedAgo: "1d ago",
  },
];

// ── Backlog Health ──

export const MOCK_BACKLOG: BacklogMetrics = {
  storylinesReady: 3,
  draftsReady: 7,
  sparksAwaiting: 12,
  waitingOnYou: 2,
};

// ── Workstreams & Containers ──

export interface Workstream {
  readonly id: string;
  readonly label: string;
  readonly color: string;
}

export interface Container {
  readonly id: string;
  readonly label: string;
  /** If set, this container is scoped to a specific workstream. Null = global. */
  readonly workstreamId: string | null;
}

export const MOCK_WORKSTREAMS: readonly Workstream[] = [
  { id: "ws-yt", label: "YouTube", color: "#ed8796" },
  { id: "ws-social", label: "Social Marketing", color: "#8aadf4" },
  { id: "ws-product", label: "Product Development", color: "#a6da95" },
];

export const MOCK_CONTAINERS: readonly Container[] = [
  // YouTube-scoped
  {
    id: "ct-hook",
    label: "Video: Hook Framework",
    workstreamId: "ws-yt",
  },
  {
    id: "ct-ai-deep",
    label: "Video: AI Agents Deep Dive",
    workstreamId: "ws-yt",
  },
  // Product Development-scoped
  {
    id: "ct-isagi",
    label: "Isagi MVP",
    workstreamId: "ws-product",
  },
  {
    id: "ct-widget",
    label: "Capture Widget",
    workstreamId: "ws-product",
  },
  // Global (no workstream scope)
  {
    id: "ct-ideas",
    label: "Parking Lot",
    workstreamId: null,
  },
  {
    id: "ct-reading",
    label: "Reading List",
    workstreamId: null,
  },
];
