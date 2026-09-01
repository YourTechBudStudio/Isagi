import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';

import type { EditorContextFacts } from '@isagi/contracts';

import { editorAttemptBanner, editorPaneView } from '../../lib/editor/view.js';
import { EditorPane, type EditorDiagnosticsState, type EditorPaneActions } from './EditorPane.js';

const base: EditorContextFacts = {
  id: 7,
  worktreeId: 3,
  activePtyProcessId: null,
  attempt: { state: 'none' },
  processStatus: null,
  processDiagnostic: null,
  processDiagnosticDetail: null,
  workbenchReadiness: null,
  readinessDetail: null,
  endpoint: null,
  hasDiagnostics: false,
  createdAt: '2026-08-31T09:00:00.000Z',
  updatedAt: '2026-08-31T09:00:00.000Z',
};

const live = {
  activePtyProcessId: 48120,
  processStatus: 'running',
  endpoint: { host: '127.0.0.1', port: 41287, url: 'http://127.0.0.1:41287' },
} as const;

function render(
  overrides: Partial<EditorContextFacts>,
  options: {
    readonly notice?: string | null;
    readonly diagnostics?: EditorDiagnosticsState;
    readonly actions?: EditorPaneActions;
  } = {},
): string {
  const context = { ...base, ...overrides };
  return renderToStaticMarkup(
    <EditorPane
      title="isagi · feat/embedded-editor"
      view={editorPaneView(context)}
      banner={editorAttemptBanner(context)}
      notice={options.notice ?? null}
      activePtyProcessId={context.activePtyProcessId}
      hasDiagnostics={context.hasDiagnostics}
      focused={false}
      onFocus={() => undefined}
      starting={false}
      onStart={() => undefined}
      diagnostics={options.diagnostics ?? { kind: 'closed' }}
      onToggleDiagnostics={() => undefined}
      onRetryDiagnostics={() => undefined}
      actions={options.actions ?? null}
    />,
  );
}

describe('EditorPane state rendering', () => {
  it('offers a calm start and no retry when nothing has ever run', () => {
    const markup = render({});

    assert.match(markup, /No editor running for this worktree yet\./);
    assert.match(markup, />Start editor</);
    assert.doesNotMatch(markup, />Retry</);
    assert.doesNotMatch(markup, /border-error/);
  });

  it('offers no action at all while a launch or a probe is running', () => {
    for (const context of [
      { attempt: { state: 'in_progress', startedAt: 'now' } } as const,
      { ...live, workbenchReadiness: 'pending' } as const,
    ]) {
      const markup = render(context);
      assert.doesNotMatch(markup, /<button/);
      // Ambient, never a spinner.
      assert.match(markup, /command-sweep/);
      assert.match(markup, /animate-breathe/);
    }
  });

  it('frames the workbench only when the runtime says ready, and covers it until it loads', () => {
    const markup = render({ ...live, workbenchReadiness: 'ready' });

    assert.match(markup, /<iframe[^>]+src="http:\/\/127\.0\.0\.1:41287"/);
    assert.match(markup, /allow=""/);
    assert.match(markup, /referrerpolicy="no-referrer"/i);
    assert.doesNotMatch(markup, /sandbox=/);
    assert.match(markup, /Loading the workbench…/);
  });

  it('reports a failed attempt with its reason, its detail, and a retry', () => {
    const markup = render({
      attempt: { state: 'failed', reason: 'port_allocation_failed', detail: 'no free port' },
    });

    assert.match(markup, /Couldn&#x27;t reserve a local port for the editor\./);
    // The runtime's own string, labelled with the code it failed under rather
    // than run into our sentence — a reader has to be able to tell the two apart.
    assert.match(markup, /port_allocation_failed<\/span> · no free port/);
    assert.match(markup, />Retry</);
    assert.match(markup, /border-error/);
  });

  it('offers an explicit restart when the editor process has stopped', () => {
    const markup = render({
      activePtyProcessId: 48120,
      processStatus: 'killed',
      processDiagnostic: 'killed',
      processDiagnosticDetail: 'runtime_shutdown',
    });

    assert.match(markup, /The editor process was killed\./);
    assert.match(markup, />Restart editor</);
    assert.doesNotMatch(markup, />Retry</);
  });

  it("keeps a refused replacement's raw detail out of the sentence that explains it", () => {
    const markup = render({
      ...live,
      workbenchReadiness: 'pending',
      attempt: {
        state: 'failed',
        reason: 'previous_incarnation_not_stopped',
        detail: 'pid 48120 still listening after SIGTERM',
      },
    });

    // Two elements, not one run-on line: ours, then the runtime's under its code.
    assert.match(markup, /nothing was replaced\.<\/p>/);
    assert.match(markup, /previous_incarnation_not_stopped · pid 48120 still listening/);
  });

  it('stacks a refused replacement over the incarnation that survived it', () => {
    const markup = render({
      ...live,
      workbenchReadiness: 'pending',
      attempt: { state: 'failed', reason: 'previous_incarnation_not_stopped', detail: null },
    });

    // Both facts, in that order: the banner, then the live process beneath it.
    assert.match(markup, /wouldn&#x27;t stop, so nothing was replaced/);
    assert.match(markup, /Waiting for the workbench…/);
    // Amber, not red — nothing was destroyed and the old editor is still up.
    assert.match(markup, /border-amber/);
    assert.doesNotMatch(markup, /border-error\/35/);
  });

  it('offers calm restart recovery when editor usability is unknown', () => {
    const markup = render({ ...live, workbenchReadiness: 'unknown' });

    assert.match(
      markup,
      /Isagi can&#x27;t confirm whether this editor is usable\. Restarting replaces its process with a fresh one\./,
    );
    assert.match(markup, />Restart editor</);
    assert.doesNotMatch(markup, />Start editor</);
    assert.doesNotMatch(markup, />Retry</);
    assert.doesNotMatch(markup, /text-error/);
    assert.doesNotMatch(markup, /border-error/);
    assert.doesNotMatch(markup, /lucide-rotate-cw/);
  });

  it('keeps a refused-replacement warning separate from unknown readiness', () => {
    const markup = render({
      ...live,
      workbenchReadiness: 'unknown',
      attempt: { state: 'failed', reason: 'previous_incarnation_not_stopped', detail: null },
    });

    const banner = markup.indexOf('The previous editor process wouldn&#x27;t stop');
    const uncertainty = markup.indexOf(
      'Isagi can&#x27;t confirm whether this editor is usable. Restarting replaces its process with a fresh one.',
    );
    assert.ok(banner >= 0 && uncertainty > banner);
    assert.match(markup, /border-amber/);
    assert.match(markup, /lucide-triangle-alert/);
    assert.match(markup, />Restart editor</);
    assert.doesNotMatch(markup, />Start editor</);
    assert.doesNotMatch(markup, />Retry</);
    assert.doesNotMatch(markup, /text-error/);
    assert.doesNotMatch(markup, /border-error/);
    assert.doesNotMatch(markup, /lucide-rotate-cw/);
  });

  it("frames every settled detail as the runtime's evidence, never as our voice", () => {
    const process = render({
      activePtyProcessId: 48120,
      processStatus: 'exited',
      processDiagnostic: 'exited',
      processDiagnosticDetail: 'code 1',
    });
    assert.match(process, /Code Server exited\./);
    assert.match(process, /exited<\/span> · code 1/);

    const unreachable = render({
      ...live,
      workbenchReadiness: 'unreachable',
      readinessDetail: '127.0.0.1:41287 · ECONNREFUSED',
    });
    assert.match(unreachable, /unreachable<\/span> · 127\.0\.0\.1:41287 · ECONNREFUSED/);
  });

  it('never shows an attention dot', () => {
    for (const context of [{}, { ...live, workbenchReadiness: 'ready' } as const]) {
      assert.doesNotMatch(render(context), /attention-dot|AttentionDot/);
    }
  });
});

describe('EditorPane request-local notice', () => {
  // The finding this design got wrong once: an ensure fired on mount can fail
  // while the cached projection still reads idle, so a notice that only rendered
  // inside a failure state would hide it at the exact site of the interaction.
  it('renders in idle, where the projection knows nothing about the failure', () => {
    const markup = render({}, { notice: "Couldn't reach the runtime." });

    assert.match(markup, /Couldn&#x27;t reach the runtime\./);
    assert.match(markup, /No editor running for this worktree yet\./);
    assert.match(markup, />Start editor</);
  });

  it('renders over a working workbench without taking it away', () => {
    const markup = render(
      { ...live, workbenchReadiness: 'ready' },
      { notice: "The editor isn't installed yet." },
    );

    assert.match(markup, /The editor isn&#x27;t installed yet\./);
    assert.match(markup, /<iframe/);
  });
});

describe('EditorPane diagnostics disclosure', () => {
  const exited = {
    activePtyProcessId: 48120,
    processStatus: 'exited',
    processDiagnostic: 'exited',
    processDiagnosticDetail: 'code 1',
    hasDiagnostics: true,
  } as const;

  it('is offered closed, and only when the incarnation retained something', () => {
    const offered = render(exited);
    assert.match(offered, />Show startup output</);
    assert.doesNotMatch(offered, /raw output · code-server/);

    const nothingRetained = render({ ...exited, hasDiagnostics: false });
    assert.doesNotMatch(nothingRetained, /startup output/);
  });

  it('labels the output as raw evidence keyed to its incarnation', () => {
    const markup = render(exited, {
      diagnostics: {
        kind: 'loaded',
        output: {
          editorContextId: 7,
          ptyProcessId: 48120,
          excerpt: 'EADDRINUSE 127.0.0.1:41287',
          truncated: true,
          totalBytes: 42_000,
        },
      },
    });

    assert.match(markup, /raw output · code-server · pid 48120/);
    assert.match(markup, /EADDRINUSE 127\.0\.0\.1:41287/);
    assert.match(markup, /dropped from the front/);
    assert.match(markup, />Hide startup output</);
  });

  it('says so plainly when the incarnation produced no output', () => {
    const markup = render(exited, {
      diagnostics: {
        kind: 'loaded',
        output: {
          editorContextId: 7,
          ptyProcessId: 48120,
          excerpt: '',
          truncated: false,
          totalBytes: 0,
        },
      },
    });

    assert.match(markup, /Isagi kept no startup output for this run\./);
  });

  it('keeps a failed read inside the disclosure, with its own retry', () => {
    const markup = render(exited, {
      diagnostics: { kind: 'failed', detail: 'editor_diagnostics_unavailable · request 8f21' },
    });

    // A log that would not read says nothing about the editor, so the pane's own
    // restart must still be offered for the editor itself.
    assert.match(markup, /editor_diagnostics_unavailable · request 8f21/);
    assert.match(markup, />Restart editor</);
    assert.match(markup, />Try again</);
    assert.match(markup, /Code Server exited\./);
  });

  it('shows a sweep rather than a spinner while the read runs', () => {
    const markup = render(exited, { diagnostics: { kind: 'loading' } });
    assert.match(markup, /command-sweep/);
  });
});

describe('EditorPane shared chrome', () => {
  // The pending sweep is drawn once, at the affordance the user actually touched
  // (ADR 0004). A single collapsed flag would light both controls, or the wrong
  // one, the moment phase 08 wires the real pending-delete store.
  const actions = (overrides: Partial<EditorPaneActions> = {}): EditorPaneActions => ({
    onSplitRight: () => undefined,
    onSplitDown: () => undefined,
    onDelete: () => undefined,
    locked: false,
    menuDeletePending: false,
    clusterDeletePending: false,
    deleteError: null,
    onDeleteResultDismissed: () => undefined,
    ...overrides,
  });

  it('renders no pane chrome at all when the caller owns none', () => {
    const markup = render({});
    assert.doesNotMatch(markup, /Delete pane/);
  });

  it('keeps the cluster sweep to a delete the cluster started', () => {
    const started = render({}, { actions: actions({ clusterDeletePending: true, locked: true }) });
    assert.match(started, /command-sweep-danger/);

    // Started from the menu instead: the cluster is inert, and silent.
    const elsewhere = render({}, { actions: actions({ menuDeletePending: true, locked: true }) });
    assert.doesNotMatch(elsewhere, /command-sweep-danger/);
  });

  it('goes inert while any delete owning this pane is running', () => {
    const markup = render({}, { actions: actions({ locked: true }) });
    assert.match(markup, /aria-label="Delete pane" disabled=""/);
  });
});
