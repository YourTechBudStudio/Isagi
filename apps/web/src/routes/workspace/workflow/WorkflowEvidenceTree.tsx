import { useId, useMemo } from 'react';

import type { WorkflowEvidenceDto } from '@isagi/contracts';

import { inspectorCopy } from './copy.js';
import type { EvidenceGroup, EvidenceTree } from './evidence-view.js';
import { verticalIndex } from './list-navigation.js';
import { EvidenceMeta } from './WorkflowEvidenceCard.js';

/**
 * What a run kept, in the shape the run actually had.
 *
 * Records arrive from the route as one flat list in capture order, which is the truth but not a
 * readable one: a review loop's two rounds land as an undifferentiated run of rows, and the thing a
 * person came to see — that round two changed something round one did not — is exactly what a flat
 * list hides. Grouping by visit, nested under the subgraph visits that contain them, makes rounds
 * read as rounds.
 *
 * A subgraph group counts `n inside`, matching the spelling on its trace row, because the number is
 * subtree-inclusive in both places and one number with two spellings would invite a reader to add
 * them up.
 *
 * The tree is one tab stop. Up, Down, Home and End move the selection through the records in the
 * order they are drawn, exactly as a click would, and `aria-activedescendant` names the selected one.
 * Groups are headings, not stops: a record is the only thing here a person selects. Rows are not
 * focusable, as in Trace, so a click leaves focus on the tree the active descendant belongs to.
 */
export function WorkflowEvidenceTree({
  tree,
  selectedKey,
  onSelect,
}: {
  readonly tree: EvidenceTree;
  readonly selectedKey: string | null;
  readonly onSelect: (record: WorkflowEvidenceDto) => void;
}) {
  const idPrefix = useId();
  const order = useMemo(() => drawnOrder(tree), [tree]);
  const rowId = useMemo(() => {
    const ids = new Map(order.map((record, index) => [record.evidenceKey, `${idPrefix}-${index}`]));
    return (record: WorkflowEvidenceDto) => ids.get(record.evidenceKey)!;
  }, [order, idPrefix]);
  const selectedIndex = order.findIndex((record) => record.evidenceKey === selectedKey);

  return (
    <div
      className="py-1.5"
      role="tree"
      aria-label={inspectorCopy.evidenceTab}
      tabIndex={0}
      aria-activedescendant={selectedIndex < 0 ? undefined : rowId(order[selectedIndex]!)}
      onKeyDown={(event) => {
        const next = verticalIndex(event.key, selectedIndex, order.length);
        if (next === null) return;
        event.preventDefault();
        const record = order[next]!;
        onSelect(record);
        // A click lands on a row that is already visible; a key press may land on one that is not.
        document.getElementById(rowId(record))?.scrollIntoView({ block: 'nearest' });
      }}
    >
      {tree.unplaced.length > 0 && (
        <div className="mb-1.5">
          {tree.unplaced.map((record) => (
            <EvidenceRow
              key={record.evidenceKey}
              id={rowId(record)}
              record={record}
              depth={0}
              selected={record.evidenceKey === selectedKey}
              onSelect={() => onSelect(record)}
            />
          ))}
        </div>
      )}
      {tree.groups.map((group) => (
        <Group
          key={group.executionId}
          group={group}
          selectedKey={selectedKey}
          rowId={rowId}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

/** Every record in the order it is drawn: the unplaced ones first, then each group depth-first. */
function drawnOrder(tree: EvidenceTree): readonly WorkflowEvidenceDto[] {
  const order: WorkflowEvidenceDto[] = [...tree.unplaced];
  const visit = (group: EvidenceGroup) => {
    order.push(...group.records);
    group.children.forEach(visit);
  };
  tree.groups.forEach(visit);
  return order;
}

function Group({
  group,
  selectedKey,
  rowId,
  onSelect,
}: {
  readonly group: EvidenceGroup;
  readonly selectedKey: string | null;
  readonly rowId: (record: WorkflowEvidenceDto) => string;
  readonly onSelect: (record: WorkflowEvidenceDto) => void;
}) {
  return (
    <div role="group">
      <div
        data-evidence-group={group.executionId}
        className="flex items-baseline gap-2 pt-1.5 pb-0.5 font-mono text-[11px] text-fg-subtle"
        style={{ paddingLeft: 14 + group.depth * 14, paddingRight: 14 }}
      >
        <span>#{group.executionId}</span>
        <span className={group.isSubgraph ? 'text-violet' : 'text-fg'}>{group.nodeId}</span>
        {group.displayName !== null && <span className="text-fg-muted">· {group.displayName}</span>}
        <span className="ml-auto opacity-70">
          {group.live
            ? inspectorCopy.evidenceGroupEmpty
            : group.isSubgraph
              ? inspectorCopy.evidenceInside(group.total)
              : group.records.length}
        </span>
      </div>
      {group.records.map((record) => (
        <EvidenceRow
          key={record.evidenceKey}
          id={rowId(record)}
          record={record}
          depth={group.depth}
          selected={record.evidenceKey === selectedKey}
          onSelect={() => onSelect(record)}
        />
      ))}
      {group.children.map((child) => (
        <Group
          key={child.executionId}
          group={child}
          selectedKey={selectedKey}
          rowId={rowId}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

function EvidenceRow({
  id,
  record,
  depth,
  selected,
  onSelect,
}: {
  readonly id: string;
  readonly record: WorkflowEvidenceDto;
  readonly depth: number;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  return (
    <div
      id={id}
      role="treeitem"
      aria-selected={selected}
      data-evidence-row={record.evidenceKey}
      onClick={onSelect}
      className={`flex w-full cursor-default items-center gap-2.5 border-l-2 py-1.5 pr-3.5 text-left transition duration-micro ease-expo ${
        selected ? 'border-l-cyan bg-cyan/7' : 'border-l-transparent hover:bg-elevated/60'
      }`}
      style={{ paddingLeft: 28 + depth * 14 }}
    >
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg">{record.title}</span>
      <span className="flex-none">
        <EvidenceMeta record={record} />
      </span>
    </div>
  );
}
