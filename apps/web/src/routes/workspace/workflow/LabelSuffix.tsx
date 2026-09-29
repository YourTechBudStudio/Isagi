/**
 * A captured label, drawn as a muted suffix after the name of the row it belongs to.
 *
 * Every inspector row that names a node, graph or checkpoint shows its label this way — the trace,
 * the dock's child list, the Checkpoints tab — so a label reads the same wherever it turns up.
 * Nothing is drawn when there is no label.
 */
export function LabelSuffix({ label }: { readonly label: string | null | undefined }) {
  if (!label) return null;
  return <span className="min-w-0 truncate text-[11.5px] text-fg-muted">{label}</span>;
}
