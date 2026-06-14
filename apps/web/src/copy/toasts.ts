import type { ReconciliationFinding } from '@isagi/contracts';

type MissingProjectFinding = Extract<ReconciliationFinding, { readonly kind: 'project_missing' }>;
type MissingWorktreeFinding = Extract<ReconciliationFinding, { readonly kind: 'worktree_missing' }>;

export const toastCopy = {
  activeContextLoadFailed: {
    title: 'Could not restore the last active worktree.',
    subtitle: 'Opening the first available worktree instead.',
  },
  activeWorktreeRecovered: {
    title: 'Active worktree is no longer available. Switched to the root checkout.',
    subtitle: 'The selected checkout is no longer reported by Git.',
  },
  projectDeleteFailed: {
    title: 'Could not remove the project.',
  },
  workbenchCommandFailed: {
    title: 'Could not run that command.',
  },
  paneCleanupPending: {
    title: 'Pane deleted.',
    subtitle: 'Cleanup will retry in the background.',
  },
  surfaceCleanupPending: {
    title: 'Surface deleted.',
    subtitle: 'Cleanup will retry in the background.',
  },
  surfaceFocusPersistFailed: {
    title: 'Could not save the active surface.',
    subtitle: 'This switch is local; restart may reopen another surface.',
  },
  activeContextPersistFailed: {
    title: 'Could not save the last active worktree.',
    subtitle: 'This session is fine; restart may reopen elsewhere.',
  },
  reconciliation: {
    missingProjectsTitle: (findings: readonly MissingProjectFinding[]) =>
      findings.length === 1 ? 'Project unavailable.' : `${findings.length} projects unavailable.`,
    missingProjectsSubtitle: (findings: readonly MissingProjectFinding[]) =>
      `${summarizeFindings(findings, (finding) => finding.path)} \u2014 open the row to fix or remove it.`,
    missingWorktreesTitle: (findings: readonly MissingWorktreeFinding[]) => {
      if (findings.length === 1 && findings[0]?.branch) {
        return `Worktree missing: ${findings[0].branch}.`;
      }
      if (findings.length === 1) {
        return 'Worktree missing.';
      }
      return `${findings.length} worktrees missing.`;
    },
    missingWorktreesSubtitle: (findings: readonly MissingWorktreeFinding[]) =>
      `${summarizeFindings(findings, describeWorktreeFinding)} \u2014 gone from Git.`,
  },
} as const;

function describeWorktreeFinding(finding: MissingWorktreeFinding) {
  return finding.branch ? `${finding.branch} at ${finding.path}` : finding.path;
}

function summarizeFindings<Finding>(
  findings: readonly Finding[],
  describeFinding: (finding: Finding) => string,
) {
  const first = findings[0];
  if (!first) {
    return 'nothing';
  }

  const summary = describeFinding(first);
  const remaining = findings.length - 1;
  return remaining > 0 ? `${summary} (+${remaining} more)` : summary;
}
