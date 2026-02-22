import type { SearchResult } from "@/lib/commands/searchEntities";

type CommandPaletteDropdownProps = {
  readonly recommended: SearchResult[];
  readonly results: SearchResult[];
  readonly highlightedIndex: number;
  readonly emptyStateMessage: string;
  readonly onHighlight: (index: number) => void;
  readonly onSelect: (index: number) => void;
};

export function CommandPaletteDropdown({
  recommended,
  results,
  highlightedIndex,
  emptyStateMessage,
  onHighlight,
  onSelect,
}: CommandPaletteDropdownProps) {
  const allVisibleOptions = [...recommended, ...results];

  if (allVisibleOptions.length === 0) {
    return (
      <div className="max-h-[40vh] overflow-y-auto overscroll-contain">
        <div className="text-text-tertiary font-body p-8 text-center">
          {emptyStateMessage}
        </div>
      </div>
    );
  }

  const renderOption = (
    item: SearchResult,
    index: number,
    isRecommended = false,
  ) => {
    const isHighlighted = index === highlightedIndex;
    return (
      <div
        key={item.id}
        className={`flex cursor-pointer items-center gap-3 border-l-2 px-4 py-3 transition-colors duration-150 select-none ${
          isHighlighted
            ? "bg-canvas-subtle border-accent-blue"
            : "border-transparent"
        }`}
        onMouseEnter={() => onHighlight(index)}
        onClick={() => onSelect(index)}
      >
        <span className="text-text-primary font-body">{item.label}</span>
        {isRecommended && (
          <span className="text-text-tertiary font-body ml-auto text-xs tracking-wider uppercase">
            Suggested
          </span>
        )}
        {isHighlighted && !isRecommended && (
          <span className="text-text-tertiary font-body ml-auto text-xs tracking-wider uppercase">
            Select ↵
          </span>
        )}
      </div>
    );
  };

  return (
    <div className="max-h-[40vh] overflow-y-auto overscroll-contain">
      <div className="py-2">
        {recommended.length > 0 && (
          <>
            <div className="font-display text-text-tertiary px-4 py-1.5 text-xs tracking-wider">
              Context
            </div>
            {recommended.map((item, i) => renderOption(item, i, true))}
            {results.length > 0 && (
              <div className="mx-4 my-2 border-t border-white/5" />
            )}
          </>
        )}
        {results.length > 0 && (
          <>
            {recommended.length > 0 && (
              <div className="font-display text-text-tertiary px-4 py-1.5 text-xs tracking-wider">
                Other options
              </div>
            )}
            {results.map((item, i) =>
              renderOption(item, i + recommended.length),
            )}
          </>
        )}
      </div>
    </div>
  );
}
