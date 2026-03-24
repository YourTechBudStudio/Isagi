export type SessionKind = "task" | "scratch" | "shaping";

export type SessionHeader = {
  readonly kind: SessionKind;
  readonly breadcrumbs: ReadonlyArray<string>;
  readonly currentContext: string;
  readonly branchName: string;
};

export type SessionComposerConfig = {
  readonly modeLabel: string;
  readonly modelLabel: string;
  readonly speedLabel: string;
  readonly placeholder: string;
  readonly disclaimer: string;
};

export type SessionProposal = {
  readonly id: string;
  readonly status: "approved" | "rejected" | "pending";
  readonly title: string;
  readonly subtitle: string;
  readonly dependencyLabel?: string;
};

export const sessionHeader: SessionHeader = {
  kind: "task",
  breadcrumbs: ["Frontend", "Spark System"],
  currentContext: "Triage: Dark mode toggle",
  branchName: "main",
};

export const sessionComposerConfig: SessionComposerConfig = {
  modeLabel: "Brainstorming",
  modelLabel: "Claude 3.5 Sonnet",
  speedLabel: "Fast",
  placeholder: "Tell me what to do... (/ for commands)",
  disclaimer:
    "Isagi can make mistakes. Verify code before deploying to production.",
};

export const sessionProposals: ReadonlyArray<SessionProposal> = [
  {
    id: "approved-theme-system",
    status: "approved",
    title: "Create Project",
    subtitle: "Theme System",
  },
  {
    id: "rejected-refactor-css",
    status: "rejected",
    title: "Create Task",
    subtitle: "Refactor global.css",
  },
  {
    id: "pending-toggle",
    status: "pending",
    title: "Create Task",
    subtitle: "Implement Dark Mode Toggle",
    dependencyLabel: 'Project "Theme System"',
  },
];
