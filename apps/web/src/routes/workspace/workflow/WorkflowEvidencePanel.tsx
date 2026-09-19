import { useMemo } from 'react';

import type { WorkflowEvidenceDto } from '@isagi/contracts';

import type { EvidenceScope } from '../../../lib/workspace/workflow/evidence.js';
import type { WorkflowRunState } from '../../../lib/workspace/workflow/model.js';
import { useWorkflowEvidenceList } from '../../../lib/workspace/workflow/queries.js';
import { inspectorCopy } from './copy.js';
import {
  buildEvidenceTree,
  evidenceFacets,
  evidenceFiltersActive,
  filterEvidence,
  type EvidenceSelectedFilters,
} from './evidence-view.js';
import { WorkflowEvidenceDetail } from './WorkflowEvidenceDetail.js';
import { WorkflowEvidenceTree } from './WorkflowEvidenceTree.js';

/**
 * The Evidence tab: what the workflow chose to keep, for the run or for one visit.
 *
 * Two scopes, and which one a person lands in is decided by how they got here. From the tab bar the
 * question is "what did this run keep", so the scope is the run. From the dock's link the question
 * is already about one visit, so the scope is that visit with the subtree switch **on** — which
 * makes the list exactly the set `evidenceCaptured` counts and exactly the length of the column
 * they came from. Turning the switch off narrows to the visit's own callback and is the only way
 * those two numbers ever differ.
 *
 * The listing itself is unfiltered on the wire. Role and label chips narrow the records already in
 * hand, because the panel pages the whole listing anyway and sending a filter would change the
 * query key — splitting this list off the dock column's cache entry, which is the one thing the two
 * surfaces may never do. The route's own `role` and `label` filters remain, for clients reading the
 * API directly.
 */
export function WorkflowEvidencePanel({
  runId,
  state,
  scope,
  onScopeChange,
  filters,
  onFiltersChange,
  selectedKey,
  onSelect,
  dockExecutionId,
  liveExecutionId,
}: {
  readonly runId: number;
  readonly state: WorkflowRunState | null;
  readonly scope: EvidenceScope;
  readonly onScopeChange: (scope: EvidenceScope) => void;
  readonly filters: EvidenceSelectedFilters;
  readonly onFiltersChange: (filters: EvidenceSelectedFilters) => void;
  readonly selectedKey: string | null;
  /** Selecting a record also moves the dock beneath to the visit that captured it. */
  readonly onSelect: (record: WorkflowEvidenceDto) => void;
  /**
   * The visit the dock is describing, and the fallback the `visit` arm resolves to.
   *
   * Never null in practice once the run's state has hydrated: the inspector seeds a selection on
   * the live visit, or the last thing that ran, or the root frame. That invariant is what keeps the
   * toggle from dead-ending, so an edit to the seeding effect that broke it would break this too.
   */
  readonly dockExecutionId: number | null;
  readonly liveExecutionId: number | null;
}) {
  const list = useWorkflowEvidenceList(state, scope);
  const records = list.data ?? null;

  const facets = useMemo(() => evidenceFacets(records ?? []), [records]);
  const shown = useMemo(() => filterEvidence(records ?? [], filters), [records, filters]);
  const tree = useMemo(
    () =>
      state === null
        ? null
        : buildEvidenceTree({
            state,
            records: shown,
            rootExecutionId: scope.kind === 'visit' ? scope.executionId : null,
            // A live visit shows its own empty line only when nothing is filtering the view; under
            // a filter, "nothing captured here yet" would describe the filter, not the visit.
            liveExecutionId: evidenceFiltersActive(filters) ? null : liveExecutionId,
          }),
    [state, shown, scope, filters, liveExecutionId],
  );

  const selected = shown.find((record) => record.evidenceKey === selectedKey) ?? null;

  /**
   * Which visit `visit` scope means, when it is chosen from the toolbar rather than the dock link.
   *
   * The selected record first, because a person looking at one record and asking for "this visit"
   * means the visit that produced it. The dock's own selection otherwise, which is what everything
   * below the panel is already describing. Subtree on either way, so the list stays exactly the set
   * `evidenceCaptured` counts.
   */
  const visitScopeTarget = selected?.executionId ?? dockExecutionId;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-canvas/55">
      <Toolbar
        scope={scope}
        visitScopeTarget={visitScopeTarget}
        onScopeChange={onScopeChange}
        filters={filters}
        onFiltersChange={onFiltersChange}
        roles={facets.roles}
        labels={facets.labels}
        count={records === null ? null : shown.length}
      />
      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 flex-none basis-152 overflow-auto border-r border-line/22">
          {list.error ? (
            <div className="px-4.5 py-4">
              <p className="text-[12.5px] text-fg-muted">{inspectorCopy.evidenceListFailed}</p>
              <button
                type="button"
                onClick={() => void list.refetch()}
                className="mt-1.5 rounded-md bg-white/6 px-2.5 py-1 font-mono text-[11px] text-fg-muted transition duration-micro ease-expo hover:bg-white/10"
              >
                {inspectorCopy.evidenceListRetry}
              </button>
            </div>
          ) : tree === null || records === null ? (
            <p className="px-4.5 py-4 font-mono text-[11.5px] text-fg-subtle">
              {inspectorCopy.evidenceListLoading}
            </p>
          ) : tree.groups.length === 0 && tree.unplaced.length === 0 ? (
            <p className="px-4.5 py-4 font-mono text-[11.5px] text-fg-subtle">
              {evidenceFiltersActive(filters)
                ? inspectorCopy.evidenceFilteredEmpty
                : scope.kind === 'run'
                  ? inspectorCopy.evidenceRunEmpty
                  : inspectorCopy.evidenceVisitEmpty}
            </p>
          ) : (
            <WorkflowEvidenceTree tree={tree} selectedKey={selectedKey} onSelect={onSelect} />
          )}
        </div>
        {selected === null ? (
          <div className="min-h-0 flex-1" />
        ) : (
          <WorkflowEvidenceDetail key={selected.evidenceKey} runId={runId} record={selected} />
        )}
      </div>
    </div>
  );
}

function Toolbar({
  scope,
  visitScopeTarget,
  onScopeChange,
  filters,
  onFiltersChange,
  roles,
  labels,
  count,
}: {
  readonly scope: EvidenceScope;
  readonly visitScopeTarget: number | null;
  readonly onScopeChange: (scope: EvidenceScope) => void;
  readonly filters: EvidenceSelectedFilters;
  readonly onFiltersChange: (filters: EvidenceSelectedFilters) => void;
  readonly roles: readonly string[];
  readonly labels: readonly string[];
  readonly count: number | null;
}) {
  const toggleLabel = (label: string) => {
    const next = new Set(filters.labels);
    if (!next.delete(label)) next.add(label);
    onFiltersChange({ ...filters, labels: next });
  };

  return (
    <div className="flex flex-none flex-wrap items-center gap-2.5 border-b border-line/25 px-3.5 py-1.5 font-mono text-[11px] text-fg-subtle">
      <div className="flex gap-px rounded-lg border border-line/28 bg-elevated/70 p-px">
        <ScopeButton
          active={scope.kind === 'run'}
          value="run"
          onClick={() => onScopeChange({ kind: 'run' })}
        >
          {inspectorCopy.evidenceScopeRun}
        </ScopeButton>
        <ScopeButton
          active={scope.kind === 'visit'}
          value="visit"
          // Only genuinely unreachable before the projection has arrived, when there is no visit to
          // name. A toggle whose second arm can never be pressed is a control that does nothing.
          disabled={visitScopeTarget === null}
          onClick={() =>
            visitScopeTarget !== null &&
            onScopeChange({ kind: 'visit', executionId: visitScopeTarget, subtree: true })
          }
        >
          {inspectorCopy.evidenceScopeVisit}
        </ScopeButton>
      </div>
      {scope.kind === 'visit' && (
        <button
          type="button"
          role="switch"
          aria-checked={scope.subtree}
          data-evidence-subtree
          onClick={() => onScopeChange({ ...scope, subtree: !scope.subtree })}
          className="flex items-center gap-1.5 text-fg-subtle transition duration-micro ease-expo hover:text-fg"
        >
          <span
            aria-hidden
            className={`relative block h-3 w-5.5 rounded-full ${
              scope.subtree ? 'bg-cyan/35' : 'bg-line/40'
            }`}
          >
            <span
              className={`absolute top-0.5 block size-2 rounded-full transition duration-micro ease-expo ${
                scope.subtree ? 'right-0.5 bg-cyan' : 'left-0.5 bg-fg-subtle'
              }`}
            />
          </span>
          {inspectorCopy.evidenceSubtree}
        </button>
      )}
      <Chip
        active={filters.role === null}
        onClick={() => onFiltersChange({ ...filters, role: null })}
      >
        {inspectorCopy.evidenceAllRoles}
      </Chip>
      {roles.map((role) => (
        <Chip
          key={role}
          active={filters.role === role}
          onClick={() => onFiltersChange({ ...filters, role: filters.role === role ? null : role })}
        >
          {role}
        </Chip>
      ))}
      {labels.length > 0 && <span aria-hidden>·</span>}
      {labels.map((label) => (
        <Chip key={label} active={filters.labels.has(label)} onClick={() => toggleLabel(label)}>
          {label}
        </Chip>
      ))}
      <span className="ml-auto opacity-80">
        {count === null
          ? ''
          : scope.kind === 'run'
            ? inspectorCopy.evidenceRunCount(count)
            : inspectorCopy.evidenceVisitCount(count)}
      </span>
    </div>
  );
}

function ScopeButton({
  active,
  value,
  disabled = false,
  onClick,
  children,
}: {
  readonly active: boolean;
  readonly value: string;
  readonly disabled?: boolean;
  readonly onClick: () => void;
  readonly children: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      data-evidence-scope={value}
      onClick={onClick}
      className={`rounded-md px-2.5 py-0.5 font-mono text-[11px] transition duration-micro ease-expo ${
        active ? 'bg-cyan/14 text-fg' : 'text-fg-subtle hover:text-fg'
      } disabled:opacity-45 disabled:hover:text-fg-subtle`}
    >
      {children}
    </button>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  readonly active: boolean;
  readonly onClick: () => void;
  readonly children: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      data-evidence-filter={children}
      onClick={onClick}
      className={`rounded-full border px-2 py-px font-mono text-[10.5px] transition duration-micro ease-expo ${
        active
          ? 'border-cyan/45 bg-cyan/8 text-cyan'
          : 'border-line/30 text-fg-subtle hover:text-fg'
      }`}
    >
      {children}
    </button>
  );
}
