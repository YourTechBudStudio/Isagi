import { Schema } from 'effect';

import { workflowRejectedErrorSchema } from '@isagi/contracts';
import type {
  ApiError,
  ProjectOrderRejectionReason,
  PtyWebSocketErrorCode,
  SurfaceOrderRejectionReason,
  WorktreeOrderRejectionReason,
} from '@isagi/contracts';

import { workflowLoadFailureReasonCopyOrFallback } from './workflows.js';

// User-facing copy for runtime failures. The runtime and contracts emit stable
// error codes (plus dry, diagnostic-only `message` strings for logs and bug
// reports); every word a person actually reads is authored here, keyed off those
// codes. Nothing in this file is rendered from a runtime-supplied string.

// Shared phrasings so the same fact reads the same way wherever it surfaces.
const projectGone = "That project isn't on Isagi's list anymore.";
const projectFilesGone = "That project's files aren't where Isagi left them.";
const worktreeGone = "Can't find that worktree. Did it get removed?";
const surfaceGone = "That surface isn't here anymore.";
const orderNotSaved = "Couldn't save that order.";
const setupConfigInvalid = "This project's .isagi setup config is malformed.";
const setupTrustMismatch = 'The setup hooks changed since you last trusted them.';
const harnessLaunchBlockCopy = {
  onboarding_incomplete: 'Harness setup is incomplete, so Isagi cannot start this session.',
  config_invalid: 'Harness configuration is invalid, so Isagi cannot start this session.',
  inventory_pending: 'Isagi is still checking this harness. Try opening the session again shortly.',
  harness_disabled: 'This harness is disabled in Isagi configuration.',
  harness_missing: 'This harness is not installed in the runtime environment.',
  harness_incompatible: 'This harness version is not compatible with Isagi.',
  harness_probe_failed: 'Isagi could not determine whether this harness is available.',
} as const;

interface CodeCopy {
  readonly summary: string;
  readonly byReason?: Readonly<Record<string, string>>;
}

/**
 * A partial reason map checked against a contract reason union. Reasons left out
 * fall through to the code's `summary` on purpose; the point of the constraint is
 * that a reason which is *listed* must actually exist, so a renamed or misspelled
 * literal fails the build instead of quietly never matching.
 */
function byReason<Reason extends string>(
  map: Partial<Record<Reason, string>>,
): Readonly<Record<string, string>> {
  // The constraint is on the argument, where it does its work. Reason lookups
  // are already treated as possibly-absent at the call site, which is exactly
  // what a partial map is.
  return map as Readonly<Record<string, string>>;
}

// Keyed by API error `code`. `byReason` refines on `data.reason` where the reason
// changes what the user should do; otherwise `summary` carries the whole message.
const apiErrorCopy: Readonly<Record<string, CodeCopy>> = {
  project_path_rejected: {
    summary: "Isagi can't use that path.",
    byReason: {
      path_not_found: "There's nothing at that path.",
      not_directory: "That path isn't a folder.",
      not_git_repository: "That folder isn't a Git repository.",
      not_repository_root: "That's inside a repo, but not its root. Point Isagi at the top.",
      linked_worktree_checkout:
        "That's a linked worktree, not the main checkout. Use the repo root.",
      permission_denied: "Isagi isn't allowed to read that path.",
      git_command_failed: "Git couldn't read that repository.",
    },
  },
  workspace_active_context_rejected: {
    summary: "Couldn't switch to that worktree.",
    byReason: {
      project_not_found: projectGone,
      worktree_not_found: worktreeGone,
      project_not_present: projectFilesGone,
    },
  },
  worktree_branch_list_rejected: {
    summary: "Couldn't list branches for that project.",
    byReason: {
      project_not_found: projectGone,
      project_not_present: projectFilesGone,
    },
  },
  worktree_open_rejected: {
    summary: "Couldn't open that worktree.",
    byReason: {
      project_not_found: projectGone,
      project_not_present: projectFilesGone,
      branch_not_found: "Git doesn't have that branch.",
      new_branch_requires_base: 'A new branch needs a base ref to grow from.',
      invalid_branch_name: "Git won't accept that branch name.",
      base_ref_not_found: "Couldn't find the base ref to branch from.",
      checkout_path_exists: "Something's already sitting at that checkout path.",
      checkout_path_registered: 'Another worktree already claims that checkout path.',
      checkout_parent_unavailable: "The folder that should hold this worktree isn't there.",
      worktree_not_found: worktreeGone,
      setup_config_invalid: setupConfigInvalid,
      setup_trust_required: 'These setup hooks need your OK before they can run.',
      setup_trust_mismatch: setupTrustMismatch,
    },
  },
  worktree_setup_rejected: {
    summary: "Couldn't run setup for that worktree.",
    byReason: {
      project_not_found: projectGone,
      project_not_present: projectFilesGone,
      setup_not_configured: 'This project has no setup hooks to run.',
      setup_config_invalid: setupConfigInvalid,
      setup_trust_mismatch: setupTrustMismatch,
    },
  },
  worktree_delete_rejected: {
    summary: "Couldn't delete that worktree.",
    byReason: {
      project_not_found: projectGone,
      project_not_present: projectFilesGone,
      worktree_not_found: worktreeGone,
      root_worktree_not_deletable: 'The root worktree cannot be deleted.',
      dirty_checkout_requires_force: 'That checkout has changes. Confirm checkout removal first.',
      root_worktree_not_found: "Couldn't find the root checkout to select afterward.",
      pty_teardown_failed: "Couldn't stop active sessions in that worktree.",
    },
  },
  workspace_reconcile_rejected: {
    summary: "Couldn't refresh that project.",
    byReason: {
      project_not_found: projectGone,
    },
  },
  surface_rejected: {
    summary: surfaceGone,
    byReason: {
      surface_not_found: surfaceGone,
      pane_not_found: "That pane isn't here anymore.",
      invalid_surface_title: "That surface title won't work.",
    },
  },
  worktree_environment_focus_rejected: {
    summary: "Couldn't save that focus change.",
    byReason: {
      worktree_not_found: worktreeGone,
      surface_not_found: surfaceGone,
      pane_not_found: "That pane isn't here anymore.",
    },
  },
  session_launch_rejected: {
    summary: "Couldn't start a session there.",
    byReason: {
      worktree_not_found: worktreeGone,
      ...harnessLaunchBlockCopy,
    },
  },
  workflow_rejected: {
    summary: "Isagi couldn't complete that workflow action.",
    byReason: {
      unknown_workflow_key: "Isagi doesn't recognize that workflow.",
      workflow_discovery_failed: "Couldn't read a workflow source path.",
      workflow_load_failed: "Couldn't load that workflow's code.",
      worktree_not_found: worktreeGone,
      surface_not_found: surfaceGone,
      surface_worktree_mismatch: 'That surface belongs to a different worktree.',
      pane_not_found: "That pane isn't here anymore.",
      agent_session_not_on_surface: "That agent session isn't on this surface.",
      workflow_launch_context_mismatch: "That pane and agent session don't match.",
      validation_failed: "Those answers didn't pass the workflow's checks.",
      workflow_root_surface_required: 'A workflow needs a surface to run on.',
      workflow_root_run_required: 'That action needs the main workflow run.',
      workflow_surface_busy: 'This surface already has a workflow running.',
      workflow_run_not_found: "That workflow run isn't here anymore.",
      workflow_run_not_paused: "That workflow isn't paused.",
      workflow_run_not_failed: "That workflow isn't in a failed state.",
      workflow_wait_not_satisfiable: "That workflow can't be advanced right now.",
      workflow_user_input_invalid:
        "Those answers didn't go through. Check the fields and try again.",
      workflow_event_ledger_failed: "Couldn't read the workflow's event log.",
    },
  },
  worktree_commands_rejected: {
    summary: "Isagi couldn't complete that command action.",
    byReason: {
      worktree_not_found: worktreeGone,
      command_config_invalid: "This worktree's command config is malformed.",
      command_not_found: "Isagi doesn't know that command anymore.",
      command_action_failed: "Couldn't stop that command — it may still be running.",
    },
  },
  project_relocation_rejected: {
    summary: "Couldn't move that project.",
    byReason: {
      project_not_found: projectGone,
      project_not_missing: "That project isn't missing — there's nothing to relocate.",
      project_path_already_registered: 'Another project already lives at that path.',
    },
  },
  // Sibling reorder refusals. Most of the runtime's reasons describe a client
  // that asked for something the rail cannot express — a cross-project move, or
  // the pinned root — so they are trust-boundary checks rather than states a
  // person can reach or act on, and they deliberately read as the summary. Only
  // a concurrent disappearance tells the user something they did not already
  // know, so only those get their own line.
  project_order_rejected: {
    summary: orderNotSaved,
    byReason: byReason<ProjectOrderRejectionReason>({
      project_not_found: projectGone,
      project_not_present: projectFilesGone,
      before_project_not_found: projectGone,
      before_project_not_present: projectFilesGone,
    }),
  },
  worktree_order_rejected: {
    summary: orderNotSaved,
    byReason: byReason<WorktreeOrderRejectionReason>({
      project_not_found: projectGone,
      project_not_present: projectFilesGone,
      worktree_not_found: worktreeGone,
      before_worktree_not_found: worktreeGone,
    }),
  },
  surface_order_rejected: {
    summary: orderNotSaved,
    byReason: byReason<SurfaceOrderRejectionReason>({
      worktree_not_found: worktreeGone,
      surface_not_found: surfaceGone,
      before_surface_not_found: surfaceGone,
    }),
  },
  git_command_failed: {
    summary: "A Git command didn't go through.",
  },
  runtime_database_failed: {
    summary: "Isagi's local database didn't cooperate.",
  },
  runtime_state_file_failed: {
    summary: "Isagi couldn't read or write its saved state.",
  },
  runtime_data_directory_failed: {
    summary: "Isagi couldn't prepare its data folder.",
  },
  api_request_decoding_failed: {
    summary: 'The runtime turned down a request it should have understood.',
  },
  api_request_parsing_failed: {
    summary: 'The runtime turned down a request it should have understood.',
  },
  api_response_encoding_failed: {
    summary: "The runtime's reply didn't match what Isagi expected.",
  },
  api_route_not_found: {
    summary: 'Isagi asked the runtime for something it does not offer.',
  },
  api_unhandled_error: {
    summary: 'Something went wrong inside the runtime.',
  },
};

const genericApiError = 'The runtime ran into a problem.';
const transportError = "Couldn't reach the runtime. Is it still running?";
const decodeError = "The runtime sent something Isagi couldn't read.";
const unknownError = 'Something went wrong.';

function readReason(data: unknown): string | undefined {
  if (data && typeof data === 'object' && 'reason' in data) {
    const reason = (data as { readonly reason?: unknown }).reason;
    return typeof reason === 'string' ? reason : undefined;
  }
  return undefined;
}

export const runtimeErrorCopy = {
  // The human-readable line for a structured API error, chosen by code + reason.
  fromApiError: (apiError: ApiError): string => {
    const entry = apiErrorCopy[apiError.code];
    if (!entry) {
      return genericApiError;
    }
    const reason = readReason(apiError.data);
    if (reason === 'workflow_load_failed' && Schema.is(workflowRejectedErrorSchema)(apiError)) {
      const loadReason = apiError.data.workflowLoadFailureReason;
      if (loadReason) return workflowLoadFailureReasonCopyOrFallback(loadReason);
    }
    return (reason && entry.byReason?.[reason]) || entry.summary;
  },
  // Compact diagnostic suffix so early users can quote something in a bug report.
  diagnostic: (apiError: ApiError): string => `${apiError.code} · request ${apiError.requestId}`,
  transport: transportError,
  decode: decodeError,
  unknown: unknownError,
} as const;

/**
 * Structured diagnostic detail for a workflow rejection: framed absolute source
 * and package paths above the stable `code · request` line. Paths are diagnostic
 * facts, never primary copy. Sections are omitted (not left as empty labels) when
 * their optional contract fields are absent, and shadowed-package order is
 * preserved. A non-`workflow_rejected` error (or one carrying no path fields)
 * degrades to the plain `code · request` line. Rendered in a `whitespace-pre-wrap`
 * mono panel, so newlines are meaningful.
 */
export function apiErrorDiagnostic(apiError: ApiError): string {
  const lines: string[] = [];
  if (Schema.is(workflowRejectedErrorSchema)(apiError)) {
    const { data } = apiError;
    if (data.workflowSourceDirectory) {
      lines.push(`Source directory: ${data.workflowSourceDirectory}`);
    }
    if (data.workflowPackageDirectory) {
      lines.push(`Workflow package: ${data.workflowPackageDirectory}`);
    }
    for (const shadowed of data.shadowedWorkflowPackageDirectories ?? []) {
      lines.push(`Shadowed package: ${shadowed}`);
    }
  }
  const trailing = runtimeErrorCopy.diagnostic(apiError);
  return lines.length > 0 ? `${lines.join('\n')}\n\n${trailing}` : trailing;
}

export function endpointDiagnostic(endpointId: string): string {
  return `Endpoint: ${endpointId}`;
}

// Local pseudo-codes for socket conditions the client detects itself (the runtime
// never reports them), folded into the same registry so PTY copy reads as one set.
export type PtySocketErrorReason =
  | PtyWebSocketErrorCode
  | 'socket_unavailable'
  | 'socket_disconnected';

const ptySocketErrorByReason: Readonly<Record<PtySocketErrorReason, string>> = {
  invalid_session_id: "That isn't a session Isagi recognizes.",
  invalid_message: "Isagi couldn't read that terminal message.",
  session_not_found: "That session's gone — looks like it already wrapped up.",
  session_not_running: "This session isn't running anymore.",
  active_process_missing: 'This session has no active process to attach to yet.',
  active_process_not_running: "This session's active process is not running.",
  harness_metadata_missing:
    'The harness session record is missing, so this pane needs a replacement.',
  harness_metadata_invalid:
    'The harness session record is unreadable, so this pane needs a replacement.',
  unsupported_harness: 'This harness is not wired into Isagi yet.',
  ...harnessLaunchBlockCopy,
  session_already_attached: 'This session is already attached in another pane.',
  session_attachment_moved: 'This session moved to another pane.',
  stream_superseded: 'This stream opened somewhere else.',
  attach_token_missing: 'This pane needs to claim the session before attaching.',
  attach_token_invalid: 'This pane no longer has the current attach claim.',
  attach_token_expired: 'This attach claim expired. Claim the session again.',
  log_read_failed: "Couldn't replay this session's history.",
  backend_unavailable: "This session's backend isn't available.",
  backend_session_missing: "This session's backend is gone.",
  backend_attach_failed: "Couldn't attach to this session.",
  pty_write_failed: "The session wouldn't take that input.",
  pty_state_load_failed: "Couldn't load this session's state.",
  unknown: 'The terminal connection gave out.',
  socket_unavailable: 'Lost the terminal connection.',
  socket_disconnected: 'Terminal connection dropped.',
};

export const ptySocketErrorCopy = {
  byReason: (reason: PtySocketErrorReason): string => ptySocketErrorByReason[reason],
  /**
   * The line a terminal shows in its own buffer when the attach never happened.
   * `detail` is the already-formatted, web-owned failure line (summary plus its
   * diagnostic `code · request` suffix) — never a runtime-authored message.
   */
  connectFailed: (detail: string) => `\r\n${detail}\r\n`,
} as const;
