import type { WorkflowEvidenceDto } from '@isagi/contracts';

import { inspectorCopy } from './copy.js';
import type { EvidenceGroup, EvidenceTree } from './evidence-view.js';
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
  return (
    <div className="py-1.5" role="tree" aria-label={inspectorCopy.evidenceTab}>
      {tree.unplaced.length > 0 && (
        <div className="mb-1.5">
          {tree.unplaced.map((record) => (
            <EvidenceRow
              key={record.evidenceKey}
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
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

function Group({
  group,
  selectedKey,
  onSelect,
}: {
  readonly group: EvidenceGroup;
  readonly selectedKey: string | null;
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
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

function EvidenceRow({
  record,
  depth,
  selected,
  onSelect,
}: {
  readonly record: WorkflowEvidenceDto;
  readonly depth: number;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="treeitem"
      aria-selected={selected}
      data-evidence-row={record.evidenceKey}
      onClick={onSelect}
      className={`flex w-full items-center gap-2.5 border-l-2 py-1.5 pr-3.5 text-left transition duration-micro ease-expo ${
        selected ? 'border-l-cyan bg-cyan/7' : 'border-l-transparent hover:bg-elevated/60'
      }`}
      style={{ paddingLeft: 28 + depth * 14 }}
    >
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg">{record.title}</span>
      <span className="flex-none">
        <EvidenceMeta record={record} />
      </span>
    </button>
  );
}
