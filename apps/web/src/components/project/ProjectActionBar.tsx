import { FolderPlus, Plus, Settings2, Sparkles } from "lucide-react";

import {
  PROJECT_ACTION_BAR_EDGE_OFFSET,
  PROJECT_SETTINGS_SHEET_WIDTH,
  projectSettingsSheetTransition,
} from "@/components/project/projectSettings.constants";
import { Button } from "@/components/ui/Button";
import { FloatingActionBar } from "@/components/ui/FloatingActionBar";
import { IconButton } from "@/components/ui/IconButton";

type ProjectActionBarProps = {
  readonly isSettingsOpen: boolean;
  readonly onToggleSettings: () => void;
};

export function ProjectActionBar({
  isSettingsOpen,
  onToggleSettings,
}: ProjectActionBarProps) {
  const rightInset = isSettingsOpen
    ? PROJECT_SETTINGS_SHEET_WIDTH + PROJECT_ACTION_BAR_EDGE_OFFSET
    : PROJECT_ACTION_BAR_EDGE_OFFSET;

  return (
    <FloatingActionBar
      rightInset={rightInset}
      rightTransition={projectSettingsSheetTransition}
    >
      <div className="bg-canvas-elevated/80 pointer-events-auto flex items-center gap-2 rounded-2xl border border-white/10 p-1.5 shadow-lg backdrop-blur-md">
        <div className="flex items-center gap-1 border-r border-white/10 px-1 pr-2">
          <Button
            variant="ghost"
            size="md"
            leadingIcon={<FolderPlus className="h-4 w-4" />}
          >
            New Collection
          </Button>
          <Button
            variant="ghost"
            size="md"
            leadingIcon={<Plus className="h-4 w-4" />}
          >
            New Task
          </Button>
        </div>

        <Button
          variant="primary"
          size="md"
          leadingIcon={<Sparkles className="h-4 w-4" />}
          className="bg-accent-violet hover:bg-accent-violet/90 text-canvas ml-1"
        >
          Shape what&apos;s next
        </Button>

        <div className="border-l border-white/10 pl-2">
          <IconButton
            icon={<Settings2 className="h-4 w-4" />}
            onClick={onToggleSettings}
            aria-label={
              isSettingsOpen
                ? "Close project settings"
                : "Open project settings"
            }
          />
        </div>
      </div>
    </FloatingActionBar>
  );
}
