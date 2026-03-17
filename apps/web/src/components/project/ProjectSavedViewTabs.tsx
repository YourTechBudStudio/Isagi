import { Check, LayoutDashboard, ListTodo, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Popover } from "@/components/ui/Popover";
import { cn } from "@/lib/cn";
import type {
  ProjectSavedView,
  ProjectViewLayout,
} from "@/lib/project-detail-storage";

type ProjectSavedViewTabsProps = {
  readonly views: ReadonlyArray<ProjectSavedView>;
  readonly selectedViewId: string;
  readonly onSelectView: (viewId: string) => void;
  readonly onCreateView: (input: {
    readonly name: string;
    readonly layout: ProjectViewLayout;
  }) => void;
};

function getLayoutIcon(layout: ProjectViewLayout) {
  return layout === "board" ? LayoutDashboard : ListTodo;
}

export function ProjectSavedViewTabs({
  views,
  selectedViewId,
  onSelectView,
  onCreateView,
}: ProjectSavedViewTabsProps) {
  const selectedView =
    views.find(view => view.id === selectedViewId) ?? views[0];
  const [isCreateMenuOpen, setIsCreateMenuOpen] = useState(false);
  const [newViewName, setNewViewName] = useState("");
  const [newViewLayout, setNewViewLayout] =
    useState<ProjectViewLayout>("board");
  const createButtonRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isCreateMenuOpen) {
      return;
    }

    const frameId = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frameId);
  }, [isCreateMenuOpen]);

  const handleCreateView = () => {
    onCreateView({
      name: newViewName.trim(),
      layout: newViewLayout,
    });
    setNewViewName("");
    setNewViewLayout("board");
    setIsCreateMenuOpen(false);
  };

  return (
    <div className="flex items-center gap-2">
      <div className="bg-canvas-subtle/60 flex items-center gap-1 rounded-2xl border border-white/6 p-1">
        {views.map(view => {
          const Icon = getLayoutIcon(view.layout);

          return (
            <button
              key={view.id}
              type="button"
              onClick={() => onSelectView(view.id)}
              className={cn(
                "flex items-center gap-2 rounded-xl px-3 py-1.5 text-sm font-medium transition-all duration-300",
                view.id === selectedViewId
                  ? "text-text-primary bg-white/10 shadow-sm"
                  : "text-text-secondary hover:text-text-primary hover:bg-white/5",
              )}
            >
              <Icon className="h-4 w-4" />
              <span className="max-w-40 truncate">{view.name}</span>
            </button>
          );
        })}
      </div>

      <button
        ref={createButtonRef}
        type="button"
        onClick={() => {
          if (!isCreateMenuOpen && selectedView) {
            setNewViewLayout(selectedView.layout);
          }

          setIsCreateMenuOpen(prev => !prev);
        }}
        className={cn(
          "text-text-secondary hover:text-text-primary flex h-9 items-center gap-2 rounded-xl border border-dashed px-3 text-sm font-medium transition-all duration-300",
          isCreateMenuOpen
            ? "border-accent-blue/30 bg-accent-blue/10 text-accent-blue"
            : "border-white/10 bg-white/[0.03] hover:border-white/20 hover:bg-white/[0.05]",
        )}
      >
        <Plus className="h-4 w-4" />
        New view
      </button>

      <Popover
        open={isCreateMenuOpen}
        onClose={() => setIsCreateMenuOpen(false)}
        anchorRef={createButtonRef}
        align="start"
        minWidth={300}
      >
        <div className="flex flex-col gap-4 p-4">
          <div className="flex flex-col gap-1">
            <h3 className="text-text-primary font-display text-sm font-semibold">
              Create saved view
            </h3>
            <p className="text-text-tertiary text-xs leading-relaxed">
              Clone the current setup, then choose how you want to look at the
              backlog.
            </p>
          </div>

          <label className="flex flex-col gap-1.5">
            <span className="text-text-tertiary text-[11px] font-medium tracking-wider uppercase">
              View name
            </span>
            <input
              ref={inputRef}
              type="text"
              value={newViewName}
              onChange={event => setNewViewName(event.target.value)}
              onKeyDown={event => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  handleCreateView();
                }
              }}
              placeholder="Sprint focus"
              className="text-text-primary placeholder:text-text-tertiary/50 bg-canvas focus:border-accent-blue/40 rounded-xl border border-white/10 px-3 py-2.5 text-sm transition-colors outline-none"
            />
          </label>

          <div className="flex flex-col gap-1.5">
            <span className="text-text-tertiary text-[11px] font-medium tracking-wider uppercase">
              Layout
            </span>
            <div className="bg-canvas-subtle/60 flex items-center gap-1 rounded-xl border border-white/6 p-1">
              {(
                [
                  { value: "board", label: "Board" },
                  { value: "list", label: "List" },
                ] as const
              ).map(option => {
                const Icon = getLayoutIcon(option.value);

                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setNewViewLayout(option.value)}
                    className={cn(
                      "flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                      option.value === newViewLayout
                        ? "text-text-primary bg-white/10"
                        : "text-text-secondary hover:text-text-primary hover:bg-white/5",
                    )}
                  >
                    <Icon className="h-4 w-4" />
                    {option.label}
                    {option.value === newViewLayout ? (
                      <Check className="h-3.5 w-3.5" />
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setIsCreateMenuOpen(false)}
              className="text-text-tertiary hover:text-text-primary rounded-lg px-2 py-1.5 text-sm font-medium transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleCreateView}
              className="bg-accent-blue text-canvas hover:bg-accent-blue/90 rounded-xl px-3.5 py-2 text-sm font-semibold shadow-sm transition-colors"
            >
              Create view
            </button>
          </div>
        </div>
      </Popover>
    </div>
  );
}
