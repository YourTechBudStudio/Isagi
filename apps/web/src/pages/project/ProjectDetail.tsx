import { AnimatePresence, motion } from "framer-motion";
import { useState } from "react";
import { useParams, useSearchParams } from "react-router";

import { AppShell } from "@/components/layout/AppShell";
import { ContextSidebar } from "@/components/layout/ContextSidebar";
import { ProjectActionBar } from "@/components/project/ProjectActionBar";
import { ProjectBoardView } from "@/components/project/ProjectBoardView";
import { ProjectEmptyState } from "@/components/project/ProjectEmptyState";
import { ProjectListView } from "@/components/project/ProjectListView";
import { ProjectSavedViewTabs } from "@/components/project/ProjectSavedViewTabs";
import { ProjectSettingsSheet } from "@/components/project/ProjectSettingsSheet";
import { ProjectViewContextBar } from "@/components/project/ProjectViewContextBar";
import { TaskDetailModal } from "@/components/project/TaskDetailModal";
import { EditableHeading } from "@/components/ui/EditableHeading";
import { getMockProject, type MockTask } from "@/lib/mock/project.mock";
import {
  mockSidebarProjects,
  mockSidebarTriage,
} from "@/lib/mock/sidebar.mock";
import { filterProjectTasks, sortProjectTasks } from "@/lib/utils/task-utils";
import { useProjectTasks } from "@/pages/project/hooks/useProjectTasks";
import { useProjectViews } from "@/pages/project/hooks/useProjectViews";

export default function ProjectDetail() {
  const { id } = useParams<{ id: string }>();
  const projectId = id ?? "";
  const project = getMockProject(projectId);

  if (!project) {
    return (
      <AppShell sidebar={<ContextSidebar />}>
        <div className="flex h-screen items-center justify-center">
          <p className="text-text-secondary">Project not found.</p>
        </div>
      </AppShell>
    );
  }

  return (
    <ProjectDetailContent
      key={projectId}
      projectId={projectId}
      projectName={project.name}
      initialTasks={project.tasks}
    />
  );
}

type ProjectDetailContentProps = {
  readonly projectId: string;
  readonly projectName: string;
  readonly initialTasks: ReadonlyArray<MockTask>;
};

function ProjectDetailContent({
  projectId,
  projectName: initialProjectName,
  initialTasks,
}: ProjectDetailContentProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [localProjectName, setLocalProjectName] = useState(initialProjectName);
  const [searchParams, setSearchParams] = useSearchParams();

  const selectedTaskId = searchParams.get("taskId");
  const { tasks, updateTask, collectionOptions, availableLabels } =
    useProjectTasks(initialTasks);
  const {
    views,
    selectedView,
    selectView,
    createView,
    renameView,
    duplicateView,
    deleteView,
    updateSelectedView,
  } = useProjectViews(projectId);

  const isEmpty = tasks.length === 0;
  const filteredTasks = sortProjectTasks(
    filterProjectTasks(tasks, {
      searchQuery,
      priorityFilter: selectedView.priorityFilter,
      collectionFilter: selectedView.collectionFilter,
    }),
    selectedView.sortKey,
  );

  return (
    <AppShell
      sidebar={
        <ContextSidebar
          triageItems={mockSidebarTriage}
          projects={mockSidebarProjects}
        />
      }
      atmosphere={
        <div className="pointer-events-none absolute inset-0 mix-blend-screen">
          <div className="from-accent-blue/2 to-accent-violet/3 absolute inset-0 bg-linear-to-br via-transparent" />
        </div>
      }
    >
      <div className="flex h-screen flex-1 overflow-hidden">
        <main className="relative z-10 flex min-w-0 flex-1 flex-col overflow-y-auto">
          <ProjectActionBar
            isSettingsOpen={isSettingsOpen}
            onToggleSettings={() => setIsSettingsOpen(prev => !prev)}
          />

          <div className="mx-auto flex h-full w-full flex-col px-8 pt-24 pb-32">
            <motion.header
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
              className="mb-6 flex flex-col gap-4"
            >
              <EditableHeading
                initialValue={localProjectName}
                onSave={setLocalProjectName}
                className="font-display text-text-primary self-start text-5xl font-semibold tracking-tight"
              />

              {!isEmpty && (
                <div className="flex flex-col gap-4 border-b border-white/6 pb-5">
                  <div className="flex items-center justify-between gap-6">
                    <ProjectSavedViewTabs
                      views={views}
                      selectedViewId={selectedView.id}
                      onSelectView={selectView}
                      onCreateView={createView}
                    />

                    <ProjectViewContextBar
                      searchQuery={searchQuery}
                      onSearchChange={setSearchQuery}
                      priorityFilter={selectedView.priorityFilter}
                      onPriorityChange={priorityFilter =>
                        updateSelectedView(view => ({
                          ...view,
                          priorityFilter,
                        }))
                      }
                      collectionFilter={selectedView.collectionFilter}
                      onCollectionChange={collectionFilter =>
                        updateSelectedView(view => ({
                          ...view,
                          collectionFilter,
                        }))
                      }
                      sortKey={selectedView.sortKey}
                      onSortChange={sortKey =>
                        updateSelectedView(view => ({
                          ...view,
                          sortKey,
                        }))
                      }
                      collectionOptions={collectionOptions}
                      resultCount={filteredTasks.length}
                      totalCount={tasks.length}
                      selectedView={selectedView}
                      viewsCount={views.length}
                      onRenameView={renameView}
                      onDuplicateView={duplicateView}
                      onDeleteView={deleteView}
                    />
                  </div>
                </div>
              )}
            </motion.header>

            <div className="flex-1">
              {isEmpty ? (
                <ProjectEmptyState projectId={projectId} />
              ) : (
                <AnimatePresence mode="wait">
                  {selectedView.layout === "board" ? (
                    <motion.div
                      key={selectedView.id}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -10 }}
                      transition={{ duration: 0.3 }}
                      className="h-full"
                    >
                      <ProjectBoardView tasks={filteredTasks} />
                    </motion.div>
                  ) : (
                    <motion.div
                      key={selectedView.id}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -10 }}
                      transition={{ duration: 0.3 }}
                      className="w-full"
                    >
                      <ProjectListView tasks={filteredTasks} />
                    </motion.div>
                  )}
                </AnimatePresence>
              )}
            </div>
          </div>
        </main>

        <ProjectSettingsSheet
          isOpen={isSettingsOpen}
          onClose={() => setIsSettingsOpen(false)}
          projectName={localProjectName}
        />
      </div>

      <TaskDetailModal
        taskId={selectedTaskId}
        tasks={tasks}
        availableLabels={availableLabels}
        collectionOptions={collectionOptions}
        onClose={() => setSearchParams({})}
        onUpdateTask={updateTask}
      />
    </AppShell>
  );
}
