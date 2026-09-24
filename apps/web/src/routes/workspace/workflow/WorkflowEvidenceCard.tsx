import type { WorkflowEvidenceDto } from '@isagi/contracts';

import { formatBytes } from './format.js';

/**
 * One captured record, as a card in the dock's Evidence column.
 *
 * **A card never claims the content is there.** A listing does not stat files — a run with a
 * thousand captures would stat a thousand of them to render one column — so a record whose bytes
 * have gone looks exactly like one whose bytes are fine, right up until it is opened. That is the
 * honest arrangement, not a gap: the alternative is a column that is either slow or lying, and the
 * detail says plainly what happened the moment someone asks.
 */
export function WorkflowEvidenceCard({
  record,
  selected,
  onSelect,
}: {
  readonly record: WorkflowEvidenceDto;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  return (
    <button
      type="button"
      data-evidence-card={record.evidenceKey}
      aria-pressed={selected}
      onClick={onSelect}
      className={`mb-2 w-full rounded-lg border border-l-[3px] border-l-cyan bg-canvas/50 px-2.5 py-2 text-left transition duration-micro ease-expo ${
        selected ? 'border-cyan/45 bg-cyan/6' : 'border-line/30 hover:border-line/60'
      }`}
    >
      <span className="mb-1 block truncate text-[12.5px] text-fg">{record.title}</span>
      <EvidenceMeta record={record} />
    </button>
  );
}

/**
 * The one-line summary a record carries wherever it appears.
 *
 * Shared by the dock card and the tree row so the two cannot describe the same record differently.
 * Role, labels, what the bytes are, and how the source was established — in that order, because
 * that is the order the questions get asked in.
 */
export function EvidenceMeta({ record }: { readonly record: WorkflowEvidenceDto }) {
  const labels = Object.entries(record.labels);
  return (
    <span className="flex flex-wrap items-center gap-2">
      <span className="rounded-md border border-line/30 px-1.5 font-mono text-[10.5px] leading-4 text-fg-muted">
        {record.role}
      </span>
      {labels.length > 0 && (
        <span className="font-mono text-[10.5px] text-fg-subtle">
          {labels.map(([key, value]) => (
            <span key={key} className="mr-1.5">
              {key}:<span className="text-fg-muted">{String(value)}</span>
            </span>
          ))}
        </span>
      )}
      <span className="font-mono text-[10.5px] text-fg-subtle">
        {shortMediaType(record.content.mediaType)} · {formatBytes(record.content.byteSize)}
      </span>
      <EvidenceSourceMark source={record.source} />
    </span>
  );
}

/**
 * How firmly this record is tied to something the runtime did, in one glance.
 *
 * Green only for `exact` — the author handed back the handle they already held, so the connection
 * is a fact rather than a reconstruction. Amber covers both weaker answers, because both are
 * honest reports of a gap: `inferred` picked the latest operation and `unresolved` found nothing at
 * all. A record with no source is neither good nor bad news; the author simply did not name one.
 */
export function EvidenceSourceMark({ source }: { readonly source: WorkflowEvidenceDto['source'] }) {
  // The words go in `aria-label` as well as `title`: a glyph plus a colour is nothing at all to a
  // screen reader, and a hover tooltip is nothing at all on a touch screen or from the keyboard.
  if (source.kind === 'none') {
    const none = 'no source was given';
    return (
      <span className="font-mono text-[10.5px] text-fg-subtle" title={none} aria-label={none}>
        —
      </span>
    );
  }
  const word = sourceWord(source.kind);
  const exact = source.attribution === 'exact';
  const spelled = `${source.kind.replaceAll('_', ' ')} · ${source.attribution.replaceAll('_', ' ')}`;
  return (
    <span
      className={`font-mono text-[10.5px] ${exact ? 'text-green' : 'text-amber'}`}
      title={spelled}
      aria-label={spelled}
    >
      {word} {exact ? '✓' : source.attribution === 'unresolved' ? '?' : '~'}
    </span>
  );
}

function sourceWord(kind: 'agent_turn' | 'headless_operation' | 'agent_session'): string {
  switch (kind) {
    case 'agent_turn':
      return 'turn';
    case 'headless_operation':
      return 'headless';
    case 'agent_session':
      return 'session';
  }
}

/** `text/markdown` reads as `markdown` in a column this narrow; the full type is in the detail. */
function shortMediaType(mediaType: string): string {
  const base = mediaType.split(';')[0]?.trim().toLowerCase() ?? mediaType;
  const subtype = base.split('/').at(-1) ?? base;
  return subtype.replace(/^x-/, '').replace('svg+xml', 'svg');
}
