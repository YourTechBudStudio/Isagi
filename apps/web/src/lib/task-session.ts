import type { MockOpenSession, MockTask } from "@/lib/mock/project.mock";

export type TaskSessionCtaConfig = {
  readonly label:
    | "Return to Active Session"
    | "Resume Session"
    | "Start Session";
  readonly variant: "secondary" | "primary";
  readonly sessionId: string;
  readonly accentClass: string;
  readonly iconKind: "active" | "resume" | "start";
};

export type TaskSessionState = {
  readonly primarySession?: MockOpenSession;
  readonly secondarySessions: ReadonlyArray<MockOpenSession>;
  readonly activeSiblingSessions: ReadonlyArray<MockOpenSession>;
  readonly ctaConfig: TaskSessionCtaConfig;
};

export function getPrimaryOpenSession(
  openSessions: ReadonlyArray<MockOpenSession>,
): MockOpenSession | undefined {
  return openSessions.find(session => session.isActive) ?? openSessions[0];
}

export function getSecondaryOpenSessions(
  openSessions: ReadonlyArray<MockOpenSession>,
  primarySession?: MockOpenSession,
): ReadonlyArray<MockOpenSession> {
  return openSessions.filter(session => session !== primarySession);
}

export function getActiveSiblingSessions(
  openSessions: ReadonlyArray<MockOpenSession>,
  primarySession?: MockOpenSession,
): ReadonlyArray<MockOpenSession> {
  return getSecondaryOpenSessions(openSessions, primarySession).filter(
    session => session.isActive,
  );
}

export function getTaskSessionCta(task: MockTask): TaskSessionCtaConfig {
  const primarySession = getPrimaryOpenSession(task.openSessions);

  if (primarySession) {
    if (primarySession.isActive) {
      return {
        label: "Return to Active Session",
        variant: "secondary",
        sessionId: primarySession.id,
        accentClass:
          "bg-accent-violet/10 text-accent-violet border-accent-violet/20 hover:bg-accent-violet/15",
        iconKind: "active",
      };
    }

    return {
      label: "Resume Session",
      variant: "primary",
      sessionId: primarySession.id,
      accentClass: "",
      iconKind: "resume",
    };
  }

  return {
    label: "Start Session",
    variant: "primary",
    sessionId: task.id,
    accentClass: "",
    iconKind: "start",
  };
}

export function getTaskSessionState(task: MockTask): TaskSessionState {
  const primarySession = getPrimaryOpenSession(task.openSessions);

  return {
    primarySession,
    secondarySessions: getSecondaryOpenSessions(
      task.openSessions,
      primarySession,
    ),
    activeSiblingSessions: getActiveSiblingSessions(
      task.openSessions,
      primarySession,
    ),
    ctaConfig: getTaskSessionCta(task),
  };
}
