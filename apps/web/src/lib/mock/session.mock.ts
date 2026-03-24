import { mockProjectCore } from "@/lib/mock/project.mock";

export type SessionKind = "task" | "scratch" | "shaping";
export type SessionProposalStatus = "open" | "accepted" | "rejected";
export type SessionExecutionMode = "repo_root" | "managed_worktree";
export type SessionExecutionActionId =
  | "switch_execution_root"
  | "change_git_mode"
  | "rebind_session";

export type SessionComposerConfig = {
  readonly modeLabel: string;
  readonly modelLabel: string;
  readonly speedLabel: string;
  readonly placeholder: string;
  readonly disclaimer: string;
};

export type SessionProposal = {
  readonly id: string;
  readonly status: SessionProposalStatus;
  readonly title: string;
  readonly subtitle: string;
  readonly dependencyLabel?: string;
};

export type SessionExecutionAction = {
  readonly id: SessionExecutionActionId;
  readonly label: string;
};

export type SessionExecutionState = {
  readonly branchName: string;
  readonly mode: SessionExecutionMode;
  readonly hasUncommittedChanges: boolean;
  readonly actions: ReadonlyArray<SessionExecutionAction>;
};

type SessionScreenBase = {
  readonly id: string;
  readonly kind: SessionKind;
  readonly breadcrumbs: ReadonlyArray<string>;
  readonly currentContext: string;
  readonly composer: SessionComposerConfig;
  readonly execution: SessionExecutionState;
};

export type TaskSessionScreenData = SessionScreenBase & {
  readonly kind: "task";
  readonly task: (typeof mockProjectCore.tasks)[number];
  readonly availableLabels: ReadonlyArray<string>;
  readonly collectionOptions: ReadonlyArray<string>;
};

export type ScratchSessionScreenData = SessionScreenBase & {
  readonly kind: "scratch";
};

export type ShapingSessionScreenData = SessionScreenBase & {
  readonly kind: "shaping";
  readonly proposals: ReadonlyArray<SessionProposal>;
};

export type SessionScreenData =
  | TaskSessionScreenData
  | ScratchSessionScreenData
  | ShapingSessionScreenData;

export function sessionHasCompanionPanel(session: SessionScreenData): boolean {
  return session.kind !== "scratch";
}

const sharedComposer: SessionComposerConfig = {
  modeLabel: "Brainstorming",
  modelLabel: "Claude 3.5 Sonnet",
  speedLabel: "Fast",
  placeholder: "Tell me what to do... (/ for commands)",
  disclaimer:
    "Isagi can make mistakes. Verify code before deploying to production.",
};

const sharedExecution: SessionExecutionState = {
  branchName: "main",
  mode: "repo_root",
  hasUncommittedChanges: true,
  actions: [
    { id: "switch_execution_root", label: "Switch Execution Root" },
    { id: "change_git_mode", label: "Change Git Mode" },
    { id: "rebind_session", label: "Rebind Session" },
  ],
};

export const mockSessionScreen: SessionScreenData = {
  id: "session-dark-mode-triage",
  kind: "task",
  breadcrumbs: ["Frontend", "Spark System"],
  currentContext: "Triage: Dark mode toggle",
  composer: sharedComposer,
  execution: sharedExecution,
  task: mockProjectCore.tasks[0],
  availableLabels: ["core", "git", "ui", "bug", "api"],
  collectionOptions: ["Q1 Milestones", "Realtime Infrastructure"],
};

export const mockScratchSessionScreen: ScratchSessionScreenData = {
  id: "session-scratch-exploration",
  kind: "scratch",
  breadcrumbs: ["Frontend", "Spark System"],
  currentContext: "Scratch: Theme research",
  composer: sharedComposer,
  execution: sharedExecution,
};

export const mockShapingProposals: ReadonlyArray<SessionProposal> = [
  {
    id: "accepted-theme-system",
    status: "accepted",
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
    id: "open-toggle",
    status: "open",
    title: "Create Task",
    subtitle: "Implement Dark Mode Toggle",
    dependencyLabel: 'Project "Theme System"',
  },
];

export const mockShapingSessionScreen: ShapingSessionScreenData = {
  id: "session-shaping-theme-plan",
  kind: "shaping",
  breadcrumbs: ["Frontend", "Spark System"],
  currentContext: "Shaping: Theme system backlog",
  composer: sharedComposer,
  execution: sharedExecution,
  proposals: mockShapingProposals,
};
