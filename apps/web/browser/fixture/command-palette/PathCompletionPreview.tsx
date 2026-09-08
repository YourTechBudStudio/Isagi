import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import { Chip } from '../../../src/components/Chip.js';
import {
  highlightedPathSuggestion,
  movedPathHighlight,
  nextPathIntent,
  pathBufferValue,
  pathPickIntent,
  pathSuggestionsAreStale,
  selectablePathSuggestions,
  withPathSeparator,
  type PathStepData,
  type PathStepView,
  type PathSuggestionLike,
} from '../../../src/lib/palette/path-step.js';

/**
 * Story #39, phase 02 — a fixture-only preview of the target path interaction.
 *
 * This is a **temporary** surface reached at `?pathPreview=1`. It exists so the
 * changed highlight, hints, focus and key behaviour can be seen and argued about
 * before phase 03's atomic cutover, which is irreversible in the sense that the
 * reducer, the shared keyboard hook, the click policy and the ARIA contract all
 * change in one commit. Phase 03 deletes this file, its entry branch in
 * `main.tsx`, its Playwright project, and `path-completion-preview.spec.ts`.
 *
 * What is real: every rule comes from `src/lib/palette/path-step.ts`. Movement,
 * the meaning of Enter, the click asymmetry, and the descent separator are the
 * phase 01 helpers, called with the same `{ query, stepData }` shape phase 03's
 * reducer will pass. The hint is derived from `nextPathIntent`, so this page
 * cannot show a sentence that disagrees with what Enter does.
 *
 * What is not real: the directory tree is a literal below, the "request" is a
 * `setTimeout`, and a submission appends to a local list instead of registering
 * a project. There is no runtime client, no reducer, no mutation, and no shared
 * hook — the key routing here is a local adapter mirroring program design §5, and
 * exercising it proves nothing about `useKeyboardSelection` until phase 03 wires
 * the real one.
 */

/* ------------------------------------------------------------------ *
 * Fixture filesystem. Display paths only — the runtime owns `~`.
 * ------------------------------------------------------------------ */

const TREE: readonly string[] = [
  '~/work',
  '~/work/projects',
  '~/work/projects/alpha',
  '~/work/projects/beta',
  '~/work/projects/beta/apps',
  '~/work/projects/beta/packages',
  '~/work/projects/beta/.github',
  '~/work/projects/gamma',
  '~/work/scratch',
  '~/Documents',
  '~/Downloads',
  '/Volumes',
  '/Volumes/scratch-ssd',
  '/Volumes/scratch-ssd/clients',
  '/Volumes/scratch-ssd/clients/northwind',
  '/Volumes/scratch-ssd/clients/northwind/monorepo',
];

const HOME = '~';
const LIMIT = 25;

function dirname(path: string): string {
  const cut = path.lastIndexOf('/');
  if (cut < 0) return '';
  return cut === 0 ? '/' : path.slice(0, cut);
}

function basename(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut < 0 ? path : path.slice(cut + 1);
}

/**
 * Mirrors the runtime's input parsing closely enough to exercise the interaction:
 * a trailing separator lists that directory's children, anything else is a
 * case-insensitive prefix within its parent. It is a stand-in, not a second
 * implementation of `path.suggestions.ts` — phase 04 owns the real one.
 */
function listDirectories(rawQuery: string): readonly PathSuggestionLike[] {
  const query = pathBufferValue(rawQuery);
  const { parent, prefix } =
    query === ''
      ? { parent: HOME, prefix: '' }
      : query === '/'
        ? { parent: '/', prefix: '' }
        : query.endsWith('/')
          ? { parent: query.slice(0, -1) || '/', prefix: '' }
          : { parent: dirname(query), prefix: basename(query) };

  const wantsHidden = prefix.startsWith('.');
  return TREE.filter((path) => dirname(path) === parent)
    .map((path) => ({ label: basename(path), path, hidden: basename(path).startsWith('.') }))
    .filter((entry) => (entry.hidden ? wantsHidden : true))
    .filter((entry) => entry.label.toLowerCase().startsWith(prefix.toLowerCase()))
    .sort((left, right) => left.label.localeCompare(right.label))
    .slice(0, LIMIT);
}

/* ------------------------------------------------------------------ *
 * Copy. Program design §7, kept fixture-local until the phase 03 cutover
 * moves it into `src/copy/palette.ts`.
 * ------------------------------------------------------------------ */

const previewCopy = {
  label: 'Repository root',
  placeholder: 'Path to a repository root',
  fillHighlighted: 'Press enter to fill the highlighted folder.',
  usePath: 'Press enter to use this path.',
  typeRepositoryRoot: 'Type a repository root path.',
  searching: 'Searching…',
  goDeeper: '/ to go deeper',
  tips: { cycle: 'cycle', fill: 'fill', use: 'use', back: 'back' },
} as const;

const TRANSPORT_ERROR = 'Could not reach the runtime to list folders.';
const REJECTION = 'Not a Git repository root';

const EMPTY_STEP: PathStepData = {
  kind: 'path',
  suggestions: [],
  suggestionsQuery: '',
  loading: false,
  error: null,
  attemptId: 0,
  highlightedIndex: null,
};

interface Submission {
  readonly value: string;
  readonly at: number;
  readonly outcome: 'registered' | 'rejected';
}

/* ------------------------------------------------------------------ *
 * The preview.
 * ------------------------------------------------------------------ */

export function PathCompletionPreview() {
  const [query, setQuery] = useState('');
  const [stepData, setStepData] = useState<PathStepData>(EMPTY_STEP);
  const [submissions, setSubmissions] = useState<readonly Submission[]>([]);
  const [rejection, setRejection] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  // Scenario switches. Fixture chrome drives these; production has no equivalent.
  const [failListing, setFailListing] = useState(false);
  const [rejectSubmission, setRejectSubmission] = useState(false);
  const [latency, setLatency] = useState(320);

  const inputRef = useRef<HTMLInputElement>(null);
  const attemptRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  // Read inside the timeout so flipping a switch mid-flight takes effect without
  // re-arming the request, which is how a reviewer actually uses this page.
  const failRef = useRef(failListing);
  failRef.current = failListing;
  const latencyRef = useRef(latency);
  latencyRef.current = latency;
  const onLatencyRef = useRef(setLatency);
  onLatencyRef.current = setLatency;

  const view: PathStepView = useMemo(() => ({ query, stepData }), [query, stepData]);
  const intent = nextPathIntent(view);
  const selectable = selectablePathSuggestions(view);
  const stale = pathSuggestionsAreStale(view);
  const highlighted = highlightedPathSuggestion(view);

  const baseId = useId();
  const listId = `${baseId}-list`;
  const hintId = `${baseId}-hint`;
  const activeOptionId =
    stepData.highlightedIndex !== null && highlighted !== null
      ? `${listId}-${stepData.highlightedIndex}`
      : undefined;

  /** Stands in for the debounced effect plus the runtime round trip. */
  const request = useCallback((nextQuery: string) => {
    const attemptId = ++attemptRef.current;
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    setStepData((data) => ({ ...data, loading: true, error: null, attemptId }));
    timerRef.current = window.setTimeout(() => {
      // The reducer's attempt guard, in miniature: a late response for a query the
      // user has moved on from is discarded rather than applied.
      if (attemptRef.current !== attemptId) return;
      setStepData((data) =>
        failRef.current
          ? { ...data, loading: false, error: TRANSPORT_ERROR, highlightedIndex: null }
          : {
              ...data,
              suggestions: listDirectories(nextQuery),
              suggestionsQuery: nextQuery,
              loading: false,
              error: null,
              // Result arrival never creates a highlight. This is the single most
              // important line on the page.
              highlightedIndex: null,
            },
      );
    }, 80 + latencyRef.current);
  }, []);

  useEffect(() => {
    request('');
    inputRef.current?.focus();
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, [request]);

  const edit = useCallback(
    (nextQuery: string) => {
      setRejection(null);
      setQuery(nextQuery);
      // An edit clears the highlight and invalidates the previous result.
      setStepData((data) => ({ ...data, highlightedIndex: null }));
      request(nextQuery);
    },
    [request],
  );

  const accept = useCallback(
    (path: string) => {
      setRejection(null);
      setQuery(path);
      setStepData((data) => ({ ...data, highlightedIndex: null }));
      request(path);
    },
    [request],
  );

  const submit = useCallback(
    (value: string) => {
      if (running) return;
      setRunning(true);
      window.setTimeout(() => {
        setRunning(false);
        if (rejectSubmission) {
          setRejection(REJECTION);
          setSubmissions((list) => [...list, { value, at: Date.now(), outcome: 'rejected' }]);
          return;
        }
        setRejection(null);
        setSubmissions((list) => [...list, { value, at: Date.now(), outcome: 'registered' }]);
      }, 420);
    },
    [rejectSubmission, running],
  );

  const activate = useCallback(() => {
    const next = nextPathIntent(view);
    if (next.kind === 'accept') accept(next.path);
    else if (next.kind === 'submit') submit(next.value);
  }, [accept, submit, view]);

  const move = useCallback(
    (delta: number) => {
      setStepData((data) => ({
        ...data,
        highlightedIndex: movedPathHighlight({ query, stepData: data }, delta),
      }));
    },
    [query],
  );

  const descend = useCallback(() => {
    if (highlighted === null) return;
    accept(withPathSeparator(highlighted.path));
  }, [accept, highlighted]);

  const pick = useCallback(
    (index: number) => {
      const next = pathPickIntent(view, index);
      if (next.kind === 'accept') accept(next.path);
      else if (next.kind === 'submit') submit(next.value);
    },
    [accept, submit, view],
  );

  /**
   * Local adapter mirroring program design §5's routing table. Phase 03 deletes
   * this in favour of `useKeyboardSelection`'s controlled-selection mode; nothing
   * here should be read as evidence about that hook.
   */
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      // An IME composition must never commit a step.
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (running) {
        // The busy lock: no key may start a second submission.
        if (event.key === 'Enter' || event.key === 'Tab') event.preventDefault();
        return;
      }
      const length = selectable.length;

      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (length === 0) return;
        event.preventDefault();
        move(event.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      if (event.key === 'Tab') {
        // Inert when there is nothing to cycle, but still swallowed: focus never
        // traverses out of the panel.
        event.preventDefault();
        if (length > 0) move(event.shiftKey ? -1 : 1);
        return;
      }
      if (event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey) {
        if (stepData.highlightedIndex !== null && highlighted !== null) {
          event.preventDefault();
          descend();
          return;
        }
        const target = event.target;
        if (
          target instanceof HTMLInputElement &&
          target.selectionStart === target.selectionEnd &&
          target.selectionStart === target.value.length &&
          target.value.endsWith('/')
        ) {
          // Swallow the duplicate separator; anything else is ordinary editing.
          event.preventDefault();
        }
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        // A held Enter must not accept and then register.
        if (event.repeat) return;
        activate();
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
      }
    },
    [activate, descend, highlighted, move, running, selectable.length, stepData.highlightedIndex],
  );

  const hint =
    intent.kind === 'accept'
      ? previewCopy.fillHighlighted
      : intent.kind === 'submit'
        ? previewCopy.usePath
        : previewCopy.typeRepositoryRoot;

  // Expose the same facts the panel renders, so a browser spec asserts against the
  // policy's own output rather than re-deriving it from the DOM.
  useEffect(() => {
    window.pathPreviewFixture = {
      state: () => ({
        query,
        highlightedIndex: stepData.highlightedIndex,
        intent: intent.kind,
        stale,
        loading: stepData.loading,
        error: stepData.error,
        selectableCount: selectable.length,
      }),
      submissions: () => submissions.map((entry) => entry.value),
      setQuery: edit,
      // Browser specs collapse the simulated round trip so a wait is a wait on the
      // interaction, not on a slider a reviewer happened to leave at 2 seconds.
      setLatency: onLatencyRef.current,
      reset: () => {
        setQuery('');
        setSubmissions([]);
        setRejection(null);
        setStepData(EMPTY_STEP);
        request('');
      },
    };
    return () => {
      delete window.pathPreviewFixture;
    };
  }, [edit, intent.kind, query, request, selectable.length, stale, stepData, submissions]);

  return (
    <div className="relative min-h-screen overflow-y-auto bg-canvas text-fg">
      <PreviewAtmosphere />
      <div className="relative z-10 mx-auto flex max-w-6xl flex-col gap-10 px-8 py-12 lg:flex-row lg:items-start">
        <div className="min-w-0 flex-1">
          <p className="font-mono text-[11px] tracking-[0.09em] text-fg-subtle uppercase">
            story #39 · phase 02
          </p>
          <h1 className="mt-2 font-display text-[24px] font-semibold">Path completion preview</h1>
          <p className="mt-2 max-w-[62ch] text-[13.5px] leading-relaxed text-fg-muted">
            Fixture-only. Every rule below comes from{' '}
            <code className="font-mono text-fg">lib/palette/path-step.ts</code>; the directory tree
            and the request are fake, and a submission appends to the log rather than registering a
            project. Focus starts in the input — press Tab.
          </p>

          <div
            data-path-preview-panel
            className="mt-8 w-145 max-w-full overflow-hidden rounded-lg border border-line/30 bg-elevated/85 shadow-lift backdrop-blur-2xl"
            onKeyDown={onKeyDown}
          >
            <div className="flex flex-wrap items-center gap-1.5 border-b border-line/16 px-4 py-3.5">
              <Chip tone="command">Add project</Chip>
              <span className="text-[11px] text-fg-subtle">›</span>
              <input
                ref={inputRef}
                type="text"
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={selectable.length > 0}
                aria-controls={listId}
                aria-describedby={hintId}
                aria-label={previewCopy.label}
                {...(activeOptionId ? { 'aria-activedescendant': activeOptionId } : {})}
                data-path-preview-input
                value={query}
                disabled={running}
                onChange={(event) => edit(event.target.value)}
                placeholder={previewCopy.placeholder}
                className="min-w-30 flex-1 bg-transparent font-sans text-[15px] text-fg outline-none placeholder:text-fg-subtle disabled:opacity-55"
              />
            </div>

            <div aria-busy={stepData.loading}>
              <div className="px-3 py-2">
                <div className="mb-1.5 flex min-w-0 items-center gap-2">
                  <p className="min-w-0 truncate font-mono text-[11.5px] text-fg-muted">
                    {previewCopy.label}
                  </p>
                  {rejection && (
                    <p
                      data-path-preview-rejection
                      className="min-w-0 truncate font-mono text-[10.5px] text-error"
                    >
                      {rejection}
                    </p>
                  )}
                </div>
                {/* The hint survives searching and transport failure: the window
                    between accepting and children arriving is exactly where the
                    second Enter happens, so the sentence describing Enter has to
                    still be on screen. */}
                <p
                  id={hintId}
                  data-path-preview-hint
                  className="font-mono text-[11px] text-fg-subtle"
                >
                  {hint}
                  {stepData.loading && (
                    <span className="opacity-70"> · {previewCopy.searching}</span>
                  )}
                </p>
              </div>

              {stepData.error ? (
                <p className="wrap-break-word px-3 py-4 font-mono text-[12px] text-error">
                  {stepData.error}
                </p>
              ) : stepData.suggestions.length === 0 ? (
                <div className="px-3 py-4">
                  {pathBufferValue(query) && (
                    <p className="rounded-sm border border-line/22 bg-white/6 px-3 py-2 font-mono text-[13px] break-all text-fg">
                      {pathBufferValue(query)}
                    </p>
                  )}
                </div>
              ) : (
                <div role="listbox" id={listId} data-path-preview-list>
                  {stepData.suggestions.map((suggestion, index) => {
                    const selected = !stale && index === stepData.highlightedIndex;
                    return (
                      <button
                        type="button"
                        key={suggestion.path}
                        id={`${listId}-${index}`}
                        role="option"
                        aria-selected={selected}
                        data-path-preview-row={index}
                        disabled={stale || running}
                        // Keeps focus in the input: a differing-row click fills the
                        // buffer and expects the next keystroke to land there.
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => pick(index)}
                        // The accent is a painted `border-l-2`, the same marker
                        // `WorktreeBlock` uses, not an inset shadow: a shadow
                        // follows the row's radius and lands as a soft stub. Every
                        // row carries the border transparently so moving the
                        // highlight cannot shift the rows sideways, and the left
                        // corners stay square so the line is actually straight.
                        className={`flex w-full items-center gap-3 rounded-r-sm border-l-2 px-3 py-2.25 text-left transition duration-micro ease-expo ${
                          stale
                            ? 'border-transparent opacity-55'
                            : selected
                              ? 'border-blue bg-blue/10'
                              : 'border-transparent hover:bg-white/4'
                        }`}
                      >
                        <span
                          className={`w-4 text-center font-mono text-[12px] ${
                            selected ? 'text-blue' : 'text-fg-subtle'
                          }`}
                        >
                          {selected ? '●' : '○'}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13.5px] text-fg">
                            {suggestion.label}
                          </span>
                          <span className="block truncate font-mono text-[10.5px] text-fg-subtle">
                            {suggestion.path}
                          </span>
                        </span>
                        {suggestion.hidden && (
                          <span className="font-mono text-[10.5px] text-fg-subtle">hidden</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="flex items-center gap-3 border-t border-line/14 px-4 py-2.5 font-mono text-[11px] text-fg-subtle">
              <span>
                <span className="text-fg-muted">↑↓ tab</span> {previewCopy.tips.cycle}
              </span>
              <span>
                <span className="text-fg-muted">↵</span>{' '}
                {intent.kind === 'accept' ? previewCopy.tips.fill : previewCopy.tips.use}
              </span>
              <span>
                <span className="text-fg-muted">esc</span> {previewCopy.tips.back}
              </span>
              <span className="ml-auto opacity-70">{previewCopy.goDeeper}</span>
            </div>
          </div>
        </div>

        <PreviewControls
          view={view}
          intent={intent.kind}
          stale={stale}
          running={running}
          submissions={submissions}
          failListing={failListing}
          rejectSubmission={rejectSubmission}
          latency={latency}
          onScenario={(next) => {
            setRejection(null);
            setQuery(next);
            setStepData((data) => ({ ...data, highlightedIndex: null }));
            request(next);
            inputRef.current?.focus();
          }}
          onToggleFail={() => setFailListing((on) => !on)}
          onToggleReject={() => setRejectSubmission((on) => !on)}
          onLatency={setLatency}
          onClear={() => setSubmissions([])}
        />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Fixture chrome. Deliberately outside the panel: production has no such
 * controls, and putting them in the palette would make this page a preview
 * of a palette that does not exist.
 * ------------------------------------------------------------------ */

const SCENARIOS: readonly { readonly label: string; readonly query: string }[] = [
  { label: 'empty buffer', query: '' },
  { label: 'matches, no highlight', query: '~/work/projects/' },
  { label: 'single match', query: '~/work/projects/al' },
  { label: 'accepted folder', query: '~/work/projects/beta' },
  { label: 'after descent', query: '~/work/projects/beta/' },
  { label: 'hidden entries', query: '~/work/projects/beta/.' },
  { label: 'no matches', query: '~/work/projects/zzz' },
  { label: 'outside home', query: '/Volumes/scratch-ssd/clients/northwind/' },
  { label: 'filesystem root', query: '/' },
];

function PreviewControls({
  view,
  intent,
  stale,
  running,
  submissions,
  failListing,
  rejectSubmission,
  latency,
  onScenario,
  onToggleFail,
  onToggleReject,
  onLatency,
  onClear,
}: {
  readonly view: PathStepView;
  readonly intent: string;
  readonly stale: boolean;
  readonly running: boolean;
  readonly submissions: readonly Submission[];
  readonly failListing: boolean;
  readonly rejectSubmission: boolean;
  readonly latency: number;
  readonly onScenario: (query: string) => void;
  readonly onToggleFail: () => void;
  readonly onToggleReject: () => void;
  readonly onLatency: (value: number) => void;
  readonly onClear: () => void;
}) {
  return (
    <aside className="w-full shrink-0 lg:w-80" data-path-preview-controls>
      <Section title="State">
        <Fact name="query" value={JSON.stringify(view.query)} />
        <Fact name="highlightedIndex" value={String(view.stepData.highlightedIndex)} />
        <Fact name="nextPathIntent" value={intent} accent />
        <Fact name="stale" value={String(stale)} />
        <Fact name="loading" value={String(view.stepData.loading)} />
        <Fact name="running" value={String(running)} />
        <Fact name="selectable" value={String(selectablePathSuggestions(view).length)} />
      </Section>

      <Section title="Scenarios">
        <div className="flex flex-wrap gap-1.5">
          {SCENARIOS.map((scenario) => (
            <button
              key={scenario.label}
              type="button"
              onClick={() => onScenario(scenario.query)}
              className="rounded-md border border-line/30 bg-white/4 px-2 py-1 font-mono text-[11px] text-fg-muted transition duration-micro ease-expo hover:bg-white/8"
            >
              {scenario.label}
            </button>
          ))}
        </div>
      </Section>

      <Section title="Failure switches">
        <Toggle label="listing transport error" on={failListing} onClick={onToggleFail} />
        <Toggle label="reject submission" on={rejectSubmission} onClick={onToggleReject} />
        <label className="mt-2 flex items-center gap-2 font-mono text-[11px] text-fg-subtle">
          latency
          <input
            type="range"
            min={0}
            max={2000}
            step={40}
            value={latency}
            onChange={(event) => onLatency(Number(event.target.value))}
            className="flex-1"
          />
          <span className="w-12 text-right text-fg-muted">{latency}ms</span>
        </label>
      </Section>

      <Section title={`Submissions (${submissions.length})`}>
        {submissions.length === 0 ? (
          <p className="font-mono text-[11px] text-fg-subtle">
            Nothing submitted yet. Accepting a folder does not appear here — that is the point.
          </p>
        ) : (
          <ol className="flex flex-col gap-1" data-path-preview-submissions>
            {submissions.map((entry, index) => (
              <li
                key={`${entry.at}-${index}`}
                className="flex items-center gap-2 font-mono text-[11px]"
              >
                <span className="text-fg-subtle">{index + 1}.</span>
                <span className="min-w-0 flex-1 truncate text-fg">{entry.value}</span>
                <span className={entry.outcome === 'rejected' ? 'text-error' : 'text-green'}>
                  {entry.outcome}
                </span>
              </li>
            ))}
          </ol>
        )}
        {submissions.length > 0 && (
          <button
            type="button"
            onClick={onClear}
            className="mt-2 font-mono text-[11px] text-fg-subtle underline underline-offset-2 hover:text-fg-muted"
          >
            clear log
          </button>
        )}
      </Section>
    </aside>
  );
}

function Section({
  title,
  children,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="mb-5 rounded-lg border border-line/22 bg-white/4 p-3">
      <p className="mb-2 font-mono text-[10.5px] tracking-[0.09em] text-fg-subtle uppercase">
        {title}
      </p>
      {children}
    </div>
  );
}

function Fact({
  name,
  value,
  accent = false,
}: {
  readonly name: string;
  readonly value: string;
  readonly accent?: boolean;
}) {
  return (
    <p className="flex items-baseline gap-2 font-mono text-[11px]">
      <span className="text-fg-subtle">{name}</span>
      <span
        data-path-preview-fact={name}
        className={`ml-auto ${accent ? 'text-blue' : 'text-fg-muted'}`}
      >
        {value}
      </span>
    </p>
  );
}

function Toggle({
  label,
  on,
  onClick,
}: {
  readonly label: string;
  readonly on: boolean;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`mb-1.5 flex w-full items-center gap-2 rounded-md border px-2 py-1.5 font-mono text-[11px] transition duration-micro ease-expo ${
        on
          ? 'border-amber/40 bg-amber/12 text-amber'
          : 'border-line/26 bg-white/4 text-fg-muted hover:bg-white/8'
      }`}
    >
      <span className="w-3 text-center">{on ? '●' : '○'}</span>
      {label}
    </button>
  );
}

/** Two halos, per the design system's atmosphere rule. Fixture page only. */
function PreviewAtmosphere() {
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0"
      style={{
        background:
          'radial-gradient(52rem 34rem at 12% -6%, rgb(138 173 244 / 0.14), transparent 62%), radial-gradient(46rem 32rem at 92% 4%, rgb(198 160 246 / 0.12), transparent 60%)',
      }}
    />
  );
}

declare global {
  interface Window {
    /** Phase 02 preview only. Removed with the preview in phase 03. */
    pathPreviewFixture?: {
      readonly state: () => {
        readonly query: string;
        readonly highlightedIndex: number | null;
        readonly intent: string;
        readonly stale: boolean;
        readonly loading: boolean;
        readonly error: string | null;
        readonly selectableCount: number;
      };
      readonly submissions: () => readonly string[];
      readonly setQuery: (query: string) => void;
      readonly setLatency: (ms: number) => void;
      readonly reset: () => void;
    };
  }
}
