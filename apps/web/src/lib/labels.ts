export function normalizeLabelKey(label: string): string {
  return label.trim().toLowerCase();
}

export function sanitizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ");
}

export function collectUniqueLabels(
  labels: ReadonlyArray<string>,
): Array<string> {
  return Array.from(new Set(labels.map(sanitizeLabel).filter(Boolean))).sort(
    (left, right) => left.localeCompare(right),
  );
}
