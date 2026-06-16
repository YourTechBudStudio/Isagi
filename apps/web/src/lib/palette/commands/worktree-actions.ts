import { Effect } from 'effect';
import { Trash2 } from 'lucide-react';

import type {
  DeleteWorktreeInput,
  DeleteWorktreeOutput,
  SurfaceDeleteWarning,
} from '@isagi/contracts';

import { worktreeActionsCopy } from '../../../copy/index.js';
import { deleteWorktreeFromPalette } from '../../workspace/queries.js';
import { preflightDeleteWorktree } from '../../workspace/runtime-data.js';
import type {
  ArgValues,
  CommandOutcome,
  CommandResultContent,
  Option,
  PaletteCommand,
  PaletteContext,
  ReviewContent,
} from '../types.js';

const DELETE_CHECKOUT = 'delete-checkout';
const CHECKOUT_ONLY = 'checkout-only';
const CHECKOUT_AND_BRANCH = 'checkout-and-branch';

export const deleteActiveWorktreeCommand: PaletteCommand = {
  id: 'delete-active-worktree',
  label: 'Delete active worktree',
  icon: Trash2,
  group: 'worktree-actions',
  feedbackSurface: 'palette',
  available: (ctx) =>
    Boolean(ctx.activeProject && ctx.activeWorktree && !ctx.activeWorktree.isRoot),
  preflight: async (ctx, values) => {
    const target = worktreeTargetFromValues(values, ctx);
    if (!target) {
      return { mode: 'unavailable' };
    }

    const preflight = await Effect.runPromise(
      preflightDeleteWorktree(target.projectId, target.worktreeId),
    );
    const nextValues = {
      projectId: String(preflight.projectId),
      worktreeId: String(preflight.worktreeId),
      path: preflight.path,
      branch: preflight.branch ?? '',
      dirty: String(preflight.dirty),
      isRoot: String(preflight.isRoot),
    };

    return preflight.isRoot
      ? { mode: 'run', values: nextValues }
      : { mode: 'palette', values: nextValues };
  },
  args: [
    {
      kind: 'review',
      key: 'dirtyCheckout',
      label: 'Confirm checkout removal',
      load: (_ctx, values) => (values.dirty === 'true' ? dirtyCheckoutReview(values.path) : null),
    },
    {
      kind: 'select',
      key: 'deleteMode',
      label: 'Delete mode',
      options: (_ctx, values) => {
        const options: Option[] = [
          {
            value: CHECKOUT_ONLY,
            label: worktreeActionsCopy.deleteWorktree.mode.checkoutOnly.label,
            hint: worktreeActionsCopy.deleteWorktree.mode.checkoutOnly.hint,
            isDefault: true,
          },
        ];
        if (values.branch) {
          options.push({
            value: CHECKOUT_AND_BRANCH,
            label: worktreeActionsCopy.deleteWorktree.mode.checkoutAndBranch.label,
            hint: worktreeActionsCopy.deleteWorktree.mode.checkoutAndBranch.hint,
            isDefault: false,
          });
        }
        return options;
      },
    },
  ],
  run: async (values, ctx) => {
    if (values.isRoot === 'true') {
      return {
        kind: 'error',
        content: {
          tone: 'danger',
          title: worktreeActionsCopy.deleteWorktree.rootNotDeletable.title,
          body: worktreeActionsCopy.deleteWorktree.rootNotDeletable.body,
        },
      } satisfies CommandOutcome;
    }

    const target = worktreeTargetFromValues(values, ctx);
    if (!target) {
      return;
    }

    const request: DeleteWorktreeInput = {
      checkoutRemovalMode: values.dirty === 'true' ? 'force' : 'normal',
      branchRemovalMode: values.deleteMode === CHECKOUT_AND_BRANCH ? 'delete_if_safe' : 'preserve',
    };
    const output = await deleteWorktreeFromPalette(target.projectId, target.worktreeId, request);
    const partialWarning = deletePartialWarning(output.branchRemoval, output.warnings);
    if (partialWarning) {
      return {
        kind: 'result',
        content: partialWarning,
      } satisfies CommandOutcome;
    }

    return { kind: 'close' };
  },
};

export const worktreeActionCommands: readonly PaletteCommand[] = [deleteActiveWorktreeCommand];

function worktreeTargetFromValues(values: ArgValues, ctx: PaletteContext) {
  const projectId = Number(values.projectId);
  const worktreeId = Number(values.worktreeId);
  if (Number.isInteger(projectId) && Number.isInteger(worktreeId)) {
    return { projectId, worktreeId };
  }
  if (!ctx.activeProject || !ctx.activeWorktree) {
    return null;
  }
  return { projectId: ctx.activeProject.id, worktreeId: ctx.activeWorktree.id };
}

function dirtyCheckoutReview(path: string | undefined): ReviewContent {
  return {
    title: worktreeActionsCopy.deleteWorktree.dirtyReview.title,
    body: worktreeActionsCopy.deleteWorktree.dirtyReview.body,
    items: path
      ? [{ label: worktreeActionsCopy.deleteWorktree.dirtyReview.checkoutLabel, detail: path }]
      : [],
    choices: [
      {
        value: DELETE_CHECKOUT,
        label: worktreeActionsCopy.deleteWorktree.dirtyReview.confirm,
        intent: 'danger',
      },
      {
        value: 'cancel',
        label: worktreeActionsCopy.deleteWorktree.dirtyReview.cancel,
        intent: 'cancel',
      },
    ],
  };
}

function cleanupWarningDetail(warnings: readonly SurfaceDeleteWarning[]) {
  return warnings
    .map((warning) => {
      const pane = `pane ${warning.paneId}`;
      const session =
        warning.session.kind === 'agent_session'
          ? `agent session ${warning.session.agentSessionId}`
          : `terminal session ${warning.session.terminalSessionId}`;
      return `${warning.code}: ${pane}, ${session}`;
    })
    .join('\n');
}

function deletePartialWarning(
  branchRemoval: DeleteWorktreeOutput['branchRemoval'],
  warnings: readonly SurfaceDeleteWarning[],
): CommandResultContent | null {
  if (branchRemoval.status === 'failed' && warnings.length > 0) {
    return {
      tone: 'warning',
      title: worktreeActionsCopy.deleteWorktree.partialWarning.title,
      body: worktreeActionsCopy.deleteWorktree.partialWarning.body,
      diagnostic: {
        label: worktreeActionsCopy.deleteWorktree.partialWarning.diagnosticLabel,
        detail: [
          `${worktreeActionsCopy.deleteWorktree.branchDeleteFailed.diagnosticLabel}:`,
          branchRemoval.diagnostic,
          '',
          `${worktreeActionsCopy.deleteWorktree.cleanupWarning.diagnosticLabel}:`,
          cleanupWarningDetail(warnings),
        ].join('\n'),
      },
    };
  }

  if (branchRemoval.status === 'failed') {
    return {
      tone: 'warning',
      title: worktreeActionsCopy.deleteWorktree.branchDeleteFailed.title,
      body: worktreeActionsCopy.deleteWorktree.branchDeleteFailed.body,
      diagnostic: {
        label: worktreeActionsCopy.deleteWorktree.branchDeleteFailed.diagnosticLabel,
        detail: branchRemoval.diagnostic,
      },
    };
  }

  if (warnings.length > 0) {
    return {
      tone: 'warning',
      title: worktreeActionsCopy.deleteWorktree.cleanupWarning.title,
      body: worktreeActionsCopy.deleteWorktree.cleanupWarning.body,
      diagnostic: {
        label: worktreeActionsCopy.deleteWorktree.cleanupWarning.diagnosticLabel,
        detail: cleanupWarningDetail(warnings),
      },
    };
  }

  return null;
}
