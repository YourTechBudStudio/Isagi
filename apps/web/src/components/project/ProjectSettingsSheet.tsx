import { AnimatePresence, motion } from "framer-motion";
import { Settings2, X as XIcon } from "lucide-react";
import { useEffect, useState } from "react";

import {
  PROJECT_SETTINGS_SHEET_WIDTH,
  projectSettingsSheetTransition,
} from "@/components/project/projectSettings.constants";
import { DisplayAliasesSection } from "@/components/project/settings/DisplayAliasesSection";
import { GitModeSection } from "@/components/project/settings/GitModeSection";
import {
  getInitialRepoPath,
  INITIAL_STATUSES,
} from "@/components/project/settings/projectSettings.constants";
import type {
  EditableStatus,
  GitMode,
  StatusBucket,
} from "@/components/project/settings/projectSettings.types";
import { RepositorySection } from "@/components/project/settings/RepositorySection";
import { TaskStatusesSection } from "@/components/project/settings/TaskStatusesSection";
import { IconButton } from "@/components/ui/IconButton";

type ProjectSettingsSheetProps = {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly projectName: string;
};

export function ProjectSettingsSheet({
  isOpen,
  onClose,
  projectName,
}: ProjectSettingsSheetProps) {
  const [gitMode, setGitMode] = useState<GitMode>("global_default");
  const [repoPath, setRepoPath] = useState(() =>
    getInitialRepoPath(projectName),
  );
  const [draftRepoPath, setDraftRepoPath] = useState(repoPath);
  const [isRepoEditorOpen, setIsRepoEditorOpen] = useState(false);
  const [statuses, setStatuses] = useState<Array<EditableStatus>>(() => [
    ...INITIAL_STATUSES,
  ]);
  const [newStatusName, setNewStatusName] = useState("");
  const [taskLabel, setTaskLabel] = useState("Task");
  const [collectionLabel, setCollectionLabel] = useState("Milestone");

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && isOpen) {
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  const handleOpenRepoEditor = () => {
    setDraftRepoPath(repoPath);
    setIsRepoEditorOpen(true);
  };

  const handleSaveRepoPath = () => {
    const trimmedPath = draftRepoPath.trim();
    if (!trimmedPath) {
      return;
    }

    setRepoPath(trimmedPath);
    setIsRepoEditorOpen(false);
  };

  const handleStatusNameChange = (statusId: string, name: string) => {
    setStatuses(prev =>
      prev.map(status =>
        status.id === statusId ? { ...status, name } : status,
      ),
    );
  };

  const handleStatusBucketChange = (statusId: string, bucket: StatusBucket) => {
    setStatuses(prev =>
      prev.map(status =>
        status.id === statusId ? { ...status, bucket } : status,
      ),
    );
  };

  const handleMoveStatus = (statusId: string, direction: "up" | "down") => {
    setStatuses(prev => {
      const index = prev.findIndex(status => status.id === statusId);
      if (index === -1) {
        return prev;
      }

      const targetIndex = direction === "up" ? index - 1 : index + 1;
      if (targetIndex < 0 || targetIndex >= prev.length) {
        return prev;
      }

      const next = [...prev];
      const [movedStatus] = next.splice(index, 1);
      next.splice(targetIndex, 0, movedStatus);
      return next;
    });
  };

  const handleDeleteStatus = (statusId: string) => {
    setStatuses(prev => prev.filter(status => status.id !== statusId));
  };

  const handleAddStatus = () => {
    const trimmedName = newStatusName.trim();
    if (!trimmedName) {
      return;
    }

    setStatuses(prev => [
      ...prev,
      {
        id: `status-${Date.now()}`,
        name: trimmedName,
        bucket: "todo",
      },
    ]);
    setNewStatusName("");
  };

  return (
    <>
      <motion.div
        animate={{ width: isOpen ? PROJECT_SETTINGS_SHEET_WIDTH : 0 }}
        transition={projectSettingsSheetTransition}
        className="shrink-0"
      />

      <AnimatePresence>
        {isOpen ? (
          <motion.div
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={projectSettingsSheetTransition}
            style={{ width: PROJECT_SETTINGS_SHEET_WIDTH }}
            className="bg-canvas-elevated/95 fixed inset-y-0 right-0 z-40 flex flex-col border-l border-white/10 shadow-2xl backdrop-blur-xl"
          >
            <div className="flex items-center justify-between border-b border-white/5 px-6 py-5">
              <div className="flex items-center gap-3">
                <div className="bg-canvas-subtle flex h-8 w-8 items-center justify-center rounded-lg border border-white/5">
                  <Settings2 className="text-text-secondary h-4 w-4" />
                </div>
                <div>
                  <h2 className="text-text-primary font-display text-lg font-semibold tracking-tight">
                    Project Settings
                  </h2>
                  <p className="text-text-tertiary text-xs">
                    Configuring{" "}
                    <span className="text-text-secondary font-medium">
                      {projectName}
                    </span>
                  </p>
                </div>
              </div>
              <IconButton
                icon={<XIcon className="h-5 w-5" />}
                onClick={onClose}
                aria-label="Close settings"
              />
            </div>

            <div className="flex-1 overflow-y-auto p-6">
              <div className="flex flex-col gap-8">
                <RepositorySection
                  repoPath={repoPath}
                  draftRepoPath={draftRepoPath}
                  isRepoEditorOpen={isRepoEditorOpen}
                  onOpenEditor={handleOpenRepoEditor}
                  onDraftChange={setDraftRepoPath}
                  onCancel={() => {
                    setDraftRepoPath(repoPath);
                    setIsRepoEditorOpen(false);
                  }}
                  onConfirm={handleSaveRepoPath}
                />

                <GitModeSection gitMode={gitMode} onSelectMode={setGitMode} />

                <TaskStatusesSection
                  statuses={statuses}
                  newStatusName={newStatusName}
                  onStatusNameChange={handleStatusNameChange}
                  onStatusBucketChange={handleStatusBucketChange}
                  onMoveStatus={handleMoveStatus}
                  onDeleteStatus={handleDeleteStatus}
                  onNewStatusNameChange={setNewStatusName}
                  onAddStatus={handleAddStatus}
                />

                <DisplayAliasesSection
                  taskLabel={taskLabel}
                  collectionLabel={collectionLabel}
                  onTaskLabelChange={setTaskLabel}
                  onCollectionLabelChange={setCollectionLabel}
                />
              </div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </>
  );
}
