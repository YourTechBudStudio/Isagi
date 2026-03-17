import { Plus, TagIcon, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Badge } from "@/components/ui/Badge";
import { Popover } from "@/components/ui/Popover";
import { cn } from "@/lib/cn";
import { normalizeLabelKey, sanitizeLabel } from "@/lib/labels";

type TaskDetailModalLabelsProps = {
  readonly selectedLabels: ReadonlyArray<string>;
  readonly availableLabels?: ReadonlyArray<string>;
  readonly onChange: (labels: ReadonlyArray<string>) => void;
};

export function TaskDetailModalLabels({
  selectedLabels,
  availableLabels = [],
  onChange,
}: TaskDetailModalLabelsProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const labelsInputRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listboxRef = useRef<HTMLDivElement>(null);

  const allKnownLabels = Array.from(
    new Set(
      [...availableLabels, ...selectedLabels]
        .map(sanitizeLabel)
        .filter(Boolean),
    ),
  ).sort((left, right) => left.localeCompare(right));

  const normalizedQuery = normalizeLabelKey(searchQuery);

  // Filter out labels that are already selected, then match against the query
  const unselectedLabels = allKnownLabels.filter(
    label =>
      !selectedLabels.some(
        selected => normalizeLabelKey(selected) === normalizeLabelKey(label),
      ),
  );

  const filteredLabels = unselectedLabels.filter(label =>
    normalizeLabelKey(label).includes(normalizedQuery),
  );

  const exactMatch = allKnownLabels.find(
    label => normalizeLabelKey(label) === normalizedQuery,
  );
  const canCreate = sanitizeLabel(searchQuery).length > 0 && !exactMatch;

  // The total options available in the dropdown
  const optionsCount = filteredLabels.length + (canCreate ? 1 : 0);

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(e.target.value);
    setActiveIndex(0);
    setIsOpen(true);
  };

  // Scroll active item into view
  useEffect(() => {
    if (!isOpen || optionsCount === 0 || !listboxRef.current) return;

    const activeElement = listboxRef.current.children[
      activeIndex
    ] as HTMLElement;
    if (activeElement) {
      activeElement.scrollIntoView({
        block: "nearest",
        behavior: "smooth",
      });
    }
  }, [activeIndex, isOpen, optionsCount]);

  const handleAddLabel = (label: string) => {
    const newLabel = sanitizeLabel(label);
    if (!newLabel) return;

    // Check if already exists (case-insensitive)
    const isSelected = selectedLabels.some(
      selected => normalizeLabelKey(selected) === normalizeLabelKey(newLabel),
    );

    if (!isSelected) {
      onChange([...selectedLabels, newLabel]);
    }

    setSearchQuery("");
    // Keep focus in the input so user can keep typing more labels
    inputRef.current?.focus();
  };

  const handleRemoveLabel = (labelToRemove: string) => {
    onChange(
      selectedLabels.filter(
        label => normalizeLabelKey(label) !== normalizeLabelKey(labelToRemove),
      ),
    );
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (
      e.key === "Backspace" &&
      searchQuery === "" &&
      selectedLabels.length > 0
    ) {
      // Remove the last label when backspacing on an empty input
      e.preventDefault();
      const newLabels = [...selectedLabels];
      newLabels.pop();
      onChange(newLabels);
      return;
    }

    if (!isOpen && e.key !== "Escape" && e.key !== "Tab") {
      setIsOpen(true);
    }

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActiveIndex(prev => (prev + 1) % Math.max(1, optionsCount));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActiveIndex(prev =>
          prev === 0 ? Math.max(0, optionsCount - 1) : prev - 1,
        );
        break;
      case "Enter":
        e.preventDefault();
        if (optionsCount === 0) return;

        if (activeIndex < filteredLabels.length) {
          handleAddLabel(filteredLabels[activeIndex]);
        } else if (canCreate) {
          handleAddLabel(searchQuery);
        }
        break;
      case "Escape":
        e.preventDefault();
        setIsOpen(false);
        setSearchQuery("");
        inputRef.current?.blur();
        break;
    }
  };

  return (
    <div className="col-span-2 flex flex-col gap-1.5">
      <span className="text-text-tertiary flex items-center gap-1.5 text-[11px] font-medium tracking-wider uppercase">
        <TagIcon className="h-3 w-3" /> Labels
      </span>

      <div className="relative">
        <div
          ref={labelsInputRef}
          className={cn(
            "bg-canvas-subtle/30 focus-within:bg-canvas focus-within:border-accent-blue/40 flex min-h-10.5 flex-wrap items-center gap-2 rounded-xl border border-transparent px-3 py-2 transition-colors",
            isOpen && "bg-canvas border-white/10",
            !isOpen && selectedLabels.length === 0 && "hover:bg-white/5",
          )}
          onClick={() => {
            setIsOpen(true);
            inputRef.current?.focus();
          }}
        >
          {selectedLabels.map(label => (
            <span key={label} className="inline-flex items-center">
              <Badge tone="neutral" className="border-white/10 bg-white/5 pr-1">
                <span>{label}</span>
                <button
                  type="button"
                  onClick={e => {
                    e.stopPropagation();
                    handleRemoveLabel(label);
                  }}
                  className="text-text-tertiary hover:text-text-primary ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full transition-colors hover:bg-white/10"
                  aria-label={`Remove ${label}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            </span>
          ))}

          <input
            ref={inputRef}
            type="text"
            value={searchQuery}
            onChange={handleSearchChange}
            onKeyDown={handleKeyDown}
            onFocus={() => setIsOpen(true)}
            placeholder={
              selectedLabels.length === 0 ? "Add labels..." : "Add more..."
            }
            className="text-text-primary placeholder:text-text-tertiary/40 min-w-30 flex-1 bg-transparent text-sm outline-none"
          />
        </div>

        <Popover
          open={isOpen && optionsCount > 0}
          onClose={() => {
            setIsOpen(false);
            setSearchQuery("");
          }}
          anchorRef={labelsInputRef}
          align="start"
        >
          <div
            ref={listboxRef}
            className="flex max-h-60 min-w-65 flex-col overflow-y-auto p-1"
            role="listbox"
          >
            {filteredLabels.map((label, index) => {
              const isActive = index === activeIndex;

              return (
                <button
                  key={label}
                  type="button"
                  role="option"
                  aria-selected={isActive}
                  onClick={e => {
                    e.stopPropagation();
                    handleAddLabel(label);
                  }}
                  className={cn(
                    "text-text-primary flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition-colors",
                    isActive ? "bg-white/10" : "hover:bg-white/5",
                  )}
                  onMouseEnter={() => setActiveIndex(index)}
                >
                  <span className="truncate">{label}</span>
                </button>
              );
            })}

            {canCreate && (
              <button
                type="button"
                role="option"
                aria-selected={activeIndex === filteredLabels.length}
                onClick={e => {
                  e.stopPropagation();
                  handleAddLabel(searchQuery);
                }}
                className={cn(
                  "text-text-primary flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors",
                  activeIndex === filteredLabels.length
                    ? "bg-white/10"
                    : "hover:bg-white/5",
                )}
                onMouseEnter={() => setActiveIndex(filteredLabels.length)}
              >
                <Plus className="text-accent-blue h-4 w-4 shrink-0" />
                <span className="truncate">
                  Create "{sanitizeLabel(searchQuery)}"
                </span>
              </button>
            )}
          </div>
        </Popover>
      </div>
    </div>
  );
}
