import { Workflow } from "lucide-react";

import { GIT_MODE_OPTIONS } from "@/components/project/settings/projectSettings.constants";
import type { GitMode } from "@/components/project/settings/projectSettings.types";
import { cn } from "@/lib/cn";

type GitModeSectionProps = {
  readonly gitMode: GitMode;
  readonly onSelectMode: (mode: GitMode) => void;
};

export function GitModeSection({ gitMode, onSelectMode }: GitModeSectionProps) {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Workflow className="text-accent-cyan h-4 w-4" />
        <h3 className="text-text-primary font-display text-sm font-medium">
          Default Git Mode
        </h3>
      </div>

      <div className="bg-canvas-subtle/50 flex flex-col gap-1 rounded-2xl border border-white/5 p-1">
        {GIT_MODE_OPTIONS.map(option => {
          const isActive = gitMode === option.value;
          const Icon = option.icon;

          return (
            <button
              key={option.value}
              type="button"
              onClick={() => onSelectMode(option.value)}
              className={cn(
                "flex items-start gap-3 rounded-xl px-4 py-3 text-left transition-colors",
                isActive
                  ? "bg-canvas border border-white/5 shadow-sm"
                  : "border border-transparent hover:bg-white/5",
              )}
            >
              <Icon
                className={cn(
                  "mt-0.5 h-4 w-4 shrink-0",
                  isActive ? option.activeColor : "text-text-tertiary",
                )}
              />
              <div className="flex flex-col gap-0.5">
                <span
                  className={cn(
                    "text-sm font-medium",
                    isActive ? "text-text-primary" : "text-text-secondary",
                  )}
                >
                  {option.label}
                </span>
                <span className="text-text-tertiary text-xs leading-relaxed">
                  {option.description}
                </span>
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}
