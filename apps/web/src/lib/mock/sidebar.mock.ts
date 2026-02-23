export type SessionState = "waiting" | "active" | "idle";

export type SidebarSession = {
  readonly id: string;
  readonly title: string; // The Task name serves as the session label
  readonly state: SessionState;
  readonly statusText?: string; // Optional short chip text like "Plotting..."
  readonly isActiveRoute?: boolean; // Is this the currently focused page?
};

export type SidebarProject = {
  readonly id: string;
  readonly name: string;
  readonly sessions: ReadonlyArray<SidebarSession>;
};

export type SidebarTriage = {
  readonly id: string;
  readonly title: string;
  readonly state: SessionState;
  // CRITICAL: Only show triage sessions if the user has interacted with them.
  // This prevents the sidebar from becoming cluttered with untouched auto-proposals.
  readonly hasInteracted: boolean;
  readonly isActiveRoute?: boolean;
};

// --- Mock Data ---

export const mockSidebarTriage: ReadonlyArray<SidebarTriage> = [
  {
    id: "tr-1",
    title: 'Triage: "Dark mode toggle"',
    state: "waiting",
    hasInteracted: true, // Should show
  },
  {
    id: "tr-2",
    title: 'Triage: "Add a database layer"',
    state: "idle",
    hasInteracted: false, // Should NOT show
  },
  {
    id: "tr-3",
    title: 'Triage: "Fix login bug"',
    state: "active",
    hasInteracted: true, // Should show
    isActiveRoute: true, // Mocking this as the active page
  },
];

export const mockSidebarProjects: ReadonlyArray<SidebarProject> = [
  {
    id: "proj-core",
    name: "Isagi Core Engine",
    sessions: [
      {
        id: "sess-1",
        title: "Implement parallel git worktrees",
        state: "active",
        statusText: "Rebasing...",
      },
      {
        id: "sess-2",
        title: "Fix ContextSidebar truncation",
        state: "waiting",
        statusText: "Needs approval",
      },
      {
        id: "sess-3",
        title: "Audit package.json dependencies",
        state: "idle",
      },
    ],
  },
  {
    id: "proj-design",
    name: "Frontend Design Polish",
    sessions: [
      // Mocking > 5 sessions to test the "Show More" expansion logic
      {
        id: "sess-4",
        title: "Refactor Apple-inspired motion",
        state: "active",
        statusText: "Plotting...",
      },
      {
        id: "sess-5",
        title: "Implement Catppuccin palette",
        state: "waiting",
        statusText: "Review",
      },
      { id: "sess-6", title: "Add Sora display font", state: "idle" },
      { id: "sess-7", title: "Redesign empty states", state: "idle" },
      { id: "sess-8", title: "Add subtle gradients", state: "idle" },
      { id: "sess-9", title: "Refactor card components", state: "idle" },
      { id: "sess-10", title: "Optimize scrollbars", state: "idle" },
    ],
  },
];
