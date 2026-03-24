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

export function getSelectableLabels(
  selectedLabels: ReadonlyArray<string>,
  availableLabels: ReadonlyArray<string>,
  searchQuery: string,
): {
  readonly filteredLabels: Array<string>;
  readonly canCreate: boolean;
} {
  const allKnownLabels = collectUniqueLabels([
    ...availableLabels,
    ...selectedLabels,
  ]);
  const normalizedQuery = normalizeLabelKey(searchQuery);

  const filteredLabels = allKnownLabels.filter(label => {
    const isSelected = selectedLabels.some(
      selected => normalizeLabelKey(selected) === normalizeLabelKey(label),
    );

    return !isSelected && normalizeLabelKey(label).includes(normalizedQuery);
  });

  const exactMatch = allKnownLabels.some(
    label => normalizeLabelKey(label) === normalizedQuery,
  );

  return {
    filteredLabels,
    canCreate: sanitizeLabel(searchQuery).length > 0 && !exactMatch,
  };
}
