import { useState } from 'react';

import { editorProvisioningCopy, onboardingCopy } from '../../../src/copy/index.js';
import { onboardingDraft, type PolicyDraft } from '../../../src/lib/control-plane/policy-form.js';
import { editorProvisioningManifestLine } from '../../../src/lib/editor/provisioning.js';
import { editorAttemptBanner, editorPaneView } from '../../../src/lib/editor/view.js';
import { syncActivePaneFromSurfaceDetail } from '../../../src/lib/workspace/activation.js';
import type { DeleteOrigin } from '../../../src/lib/workspace/pending-deletes.js';
import { PolicyForm } from '../../../src/routes/startup/PolicyForm.js';
import { BootBody, BootSurface, BootTitle } from '../../../src/routes/startup/StartupSurfaces.js';
import {
  EditorPane,
  type EditorDiagnosticsState,
  type EditorPaneActions,
} from '../../../src/routes/workspace/EditorPane.js';
import {
  EDITOR_FIXTURE_MARKER,
  FALLTHROUGH_STATES,
  FIXTURE_SURFACE_ID,
  FIXTURE_WORKTREE_ID,
  fixturePaneId,
  ONBOARDING_FAILURE_FIXTURES,
  ONBOARDING_SNAPSHOT,
  PANE_FIXTURES,
  PROVISIONING_FIXTURES,
  type EditorPaneFixture,
} from './state.js';

/**
 * The editor surfaces as one contact sheet: every pane state and every
 * provisioning state at the size they actually ship, so copy tone, hierarchy,
 * and precedence can be judged across states in a single pass rather than one
 * screen at a time.
 *
 * Nothing here reaches a shipped build.
 */
export function EditorGalleryApp() {
  const [narrow, setNarrow] = useState(false);

  return (
    <div
      className="relative z-1 h-screen overflow-y-auto px-8 py-7 text-fg"
      {...{ [EDITOR_FIXTURE_MARKER]: '' }}
    >
      <header className="mb-6">
        <h1 className="font-display text-[19px] font-bold tracking-[-0.03em]">
          Embedded editor — fixture
        </h1>
        <p className="mt-1 max-w-3xl text-[13px] leading-relaxed text-fg-muted">
          Every state the pane and the provisioning gate can reach, driven from contract-shaped
          facts through the real reduction. The workbench is a stand-in document, so the
          frame&apos;s load cover is a real load.
        </p>
        <button
          type="button"
          onClick={() => setNarrow((value) => !value)}
          className="mt-3 rounded-sm border border-line/40 px-2.5 py-1 font-mono text-[11px] text-fg-muted hover:text-fg"
        >
          {narrow ? 'normal width' : 'narrow width'}
        </button>
      </header>

      <Section title="Editor pane">
        <div
          className="grid gap-5"
          style={{
            gridTemplateColumns: `repeat(auto-fill, minmax(${narrow ? 300 : 420}px, 1fr))`,
          }}
        >
          {PANE_FIXTURES.map((fixture, index) => (
            <PaneCard key={fixture.id} fixture={fixture} paneId={fixturePaneId(index)} />
          ))}
        </div>
      </Section>

      <Section title="Provisioning — boot surface">
        <p className="mb-3 max-w-3xl text-[12.5px] leading-relaxed text-fg-subtle">
          The boot surface owns the whole screen, so it is reviewed at that size rather than tiled:
          a shrunken screen says nothing useful about a status line or a diagnostic. Pick a state.
        </p>
        <BootPicker />
      </Section>

      <Section title="Provisioning — onboarding">
        <p className="mb-3 max-w-3xl text-[12.5px] leading-relaxed text-fg-subtle">
          The failure where it actually lands: a <code>#</code> comment among the harness lines and
          a <code>Retry download</code> joining the row that already holds Save. This is the real
          onboarding composition — the same <code>BootSurface</code> setup beat and the same{' '}
          <code>PolicyForm</code> the shipped flow mounts.
        </p>
        <OnboardingPicker />
      </Section>

      <Section title="Provisioning — every state, as onboarding hears it">
        <p className="mb-3 max-w-3xl text-[12.5px] leading-relaxed text-fg-subtle">
          The line the composition above is driven from, for every state at once. Progress is
          deliberately absent: every transient state resolves to nothing here.
        </p>
        <div className="rounded-md border border-line/25 bg-elevated/40 p-4 font-mono text-[11.5px] leading-loose">
          {[...PROVISIONING_FIXTURES.map((f) => f.state), ...FALLTHROUGH_STATES].map(
            (state, index) => {
              const line = editorProvisioningManifestLine(state);
              return (
                <p key={index} className={line ? 'text-error' : 'text-fg-subtle/60'}>
                  <span className="text-fg-subtle">
                    {state.status}
                    {state.status === 'failed' ? ` · ${state.reason}` : ''} →{' '}
                  </span>
                  {line ? `# ${line}` : '(nothing)'}
                </p>
              );
            },
          )}
        </div>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-10">
      <h2 className="mb-4 font-mono text-[10px] tracking-widest text-fg-subtle uppercase">
        {title}
      </h2>
      {children}
    </section>
  );
}

function PaneCard({ fixture, paneId }: { fixture: EditorPaneFixture; paneId: number }) {
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const [started, setStarted] = useState<string | null>(null);
  const [splitting, setSplitting] = useState<string | null>(null);
  // Local stand-in for the pending-delete store: one origin, exactly the fact
  // `showsDeleteSweep` answers, so the sweep is drawn where the user touched.
  const [deleting, setDeleting] = useState<DeleteOrigin | null>(null);
  const view = editorPaneView(fixture.context);
  const banner = editorAttemptBanner(fixture.context);
  const diagnostics: EditorDiagnosticsState = open ? fixture.diagnostics : { kind: 'closed' };
  const actions: EditorPaneActions | null = fixture.chrome
    ? {
        onSplitRight: () => setSplitting('right'),
        onSplitDown: () => setSplitting('down'),
        onDelete: (origin) => setDeleting(origin),
        locked: deleting !== null,
        menuDeletePending: deleting === 'menu',
        clusterDeletePending: deleting === 'pane',
        deleteError: null,
        onDeleteResultDismissed: () => setDeleting(null),
      }
    : null;

  return (
    <figure
      className="m-0 flex flex-col gap-2"
      data-pane-fixture={fixture.id}
      {...(focused ? { 'data-pane-focused': '' } : {})}
      {...(deleting ? { 'data-delete-origin': deleting } : {})}
    >
      <div className="flex h-75">
        <EditorPane
          title="isagi · feat/embedded-editor"
          view={view}
          banner={banner}
          notice={fixture.notice}
          activePtyProcessId={fixture.context.activePtyProcessId}
          hasDiagnostics={fixture.context.hasDiagnostics}
          focused={focused}
          onFocus={() => setFocused(true)}
          starting={false}
          onStart={(intent) => setStarted(intent)}
          diagnostics={diagnostics}
          onToggleDiagnostics={() => setOpen((value) => !value)}
          onRetryDiagnostics={() => setOpen(true)}
          actions={actions}
          focusTarget={{ surfaceId: FIXTURE_SURFACE_ID, paneId }}
        />
      </div>
      <figcaption className="flex flex-wrap items-baseline gap-2">
        <span className="font-mono text-[11px] text-fg-muted">{fixture.label}</span>
        <span className="text-[12px] text-fg-subtle">{fixture.note}</span>
        {started ? (
          <span className="font-mono text-[10.5px] text-waiting" data-started-intent={started}>
            → ensureRuntime({started})
          </span>
        ) : null}
        {splitting ? (
          <span className="font-mono text-[10.5px] text-waiting" data-split-intent={splitting}>
            → split {splitting}
          </span>
        ) : null}
        {/* Asks the shared focus router to land keyboard focus on this pane —
            what `restoreActivePaneFocus` does when the palette or the drawer
            closes. The gallery drives it directly because neither of those
            surfaces exists here. */}
        <button
          type="button"
          data-restore-focus
          onClick={() =>
            syncActivePaneFromSurfaceDetail({
              worktreeId: FIXTURE_WORKTREE_ID,
              surfaceId: FIXTURE_SURFACE_ID,
              panes: [
                {
                  id: paneId,
                  surfaceId: FIXTURE_SURFACE_ID,
                  title: fixture.label,
                  sortOrder: 0,
                  session: null,
                },
              ],
              detailActivePaneId: paneId,
              preferredPaneId: paneId,
            })
          }
          className="font-mono text-[10.5px] text-fg-subtle underline-offset-2 hover:underline"
        >
          return focus here
        </button>
        {deleting ? (
          <button
            type="button"
            data-clear-delete
            onClick={() => setDeleting(null)}
            className="font-mono text-[10.5px] text-error underline-offset-2 hover:underline"
          >
            deleting · origin {deleting} — clear
          </button>
        ) : null}
      </figcaption>
    </figure>
  );
}

function BootPicker() {
  const [selectedId, setSelectedId] = useState(PROVISIONING_FIXTURES[0]!.id);
  const [retried, setRetried] = useState(0);
  const fixture =
    PROVISIONING_FIXTURES.find((candidate) => candidate.id === selectedId) ??
    PROVISIONING_FIXTURES[0]!;

  return (
    <div data-boot-picker>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {PROVISIONING_FIXTURES.map((option) => (
          <button
            key={option.id}
            type="button"
            data-boot-option={option.id}
            aria-pressed={option.id === fixture.id}
            onClick={() => {
              setSelectedId(option.id);
              setRetried(0);
            }}
            className={`rounded-sm border px-2.5 py-1 font-mono text-[11px] transition duration-micro ease-expo ${
              option.id === fixture.id
                ? 'border-blue/40 bg-blue/12 text-fg'
                : 'border-line/30 text-fg-muted hover:text-fg'
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
      <p className="mb-3 font-mono text-[11.5px] text-fg-subtle" data-boot-note>
        {fixture.note}
        {retried > 0 ? (
          <span className="ml-2 text-waiting" data-retry-count={retried}>
            → retryProvisioning ×{retried}
          </span>
        ) : null}
      </p>
      <div className="overflow-hidden rounded-md border border-line/20" data-boot-stage>
        <BootSurface
          view={{
            kind: 'editor_provisioning',
            state: fixture.state,
            retrying: fixture.retrying,
            onRetry: () => setRetried((count) => count + 1),
          }}
        />
      </div>
    </div>
  );
}

/**
 * Onboarding, composed the way the shipped flow composes it: the boot surface's
 * setup beat, the real title and body, and the real `PolicyForm` with its draft
 * state live. Only the provisioning failure is picked — everything else on the
 * screen is the actual onboarding surface, which is the only way its placement,
 * button row, and keyboard flow can be judged.
 */
function OnboardingPicker() {
  const [selectedId, setSelectedId] = useState(ONBOARDING_FAILURE_FIXTURES[0]!.id);
  const [draft, setDraft] = useState<PolicyDraft>(() => onboardingDraft(ONBOARDING_SNAPSHOT));
  const [retried, setRetried] = useState(0);
  const fixture =
    ONBOARDING_FAILURE_FIXTURES.find((candidate) => candidate.id === selectedId) ??
    ONBOARDING_FAILURE_FIXTURES[0]!;
  // `ONBOARDING_FAILURE_FIXTURES` is filtered to failures; this narrows it for
  // the type system so the retryable fact comes from the one keyed map that owns
  // it rather than from a second opinion about which reasons can be retried.
  const failure = fixture.state.status === 'failed' ? fixture.state : null;
  const line = editorProvisioningManifestLine(fixture.state);

  return (
    <div data-onboarding-picker>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {ONBOARDING_FAILURE_FIXTURES.map((option) => (
          <button
            key={option.id}
            type="button"
            data-onboarding-option={option.id}
            aria-pressed={option.id === fixture.id}
            onClick={() => {
              setSelectedId(option.id);
              setRetried(0);
            }}
            className={`rounded-sm border px-2.5 py-1 font-mono text-[11px] transition duration-micro ease-expo ${
              option.id === fixture.id
                ? 'border-blue/40 bg-blue/12 text-fg'
                : 'border-line/30 text-fg-muted hover:text-fg'
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
      {retried > 0 ? (
        <p className="mb-3 font-mono text-[11.5px] text-waiting" data-onboarding-retry={retried}>
          → retryProvisioning ×{retried}
        </p>
      ) : null}
      <div className="overflow-hidden rounded-md border border-line/20" data-onboarding-stage>
        <BootSurface
          view={{
            kind: 'setup',
            live: false,
            whisper: onboardingCopy.keyboardWhisper,
            stepKey: 'setup',
            children: (
              <>
                <BootTitle>{onboardingCopy.title}</BootTitle>
                <BootBody>{onboardingCopy.body}</BootBody>
                <PolicyForm
                  snapshot={ONBOARDING_SNAPSHOT}
                  draft={draft}
                  onChange={setDraft}
                  saving={false}
                  error={null}
                  onSave={() => undefined}
                  provisioning={
                    failure === null || line === null
                      ? null
                      : {
                          line,
                          retryable: editorProvisioningCopy.retryable[failure.reason],
                          retrying: false,
                          onRetry: () => setRetried((count) => count + 1),
                        }
                  }
                />
              </>
            ),
          }}
        />
      </div>
    </div>
  );
}
