import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useState } from "react";
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
import { getMockProject, type MockTask } from "@/lib/mock/project.mock";
import {
  mockSidebarProjects,
  mockSidebarTriage,
} from "@/lib/mock/sidebar.mock";
import {
  createProjectSavedViewId,
  DEFAULT_PROJECT_VIEWS_STATE,
  getNextProjectViewName,
  type ProjectSavedView,
  readProjectViewsState,
  writeProjectViewsState,
} from "@/lib/project-detail-storage";
import { filterProjectTasks, sortProjectTasks } from "@/lib/utils/task-utils";

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
      project={project}
      projectId={projectId}
    />
  );
}

type ProjectDetailContentProps = {
  readonly projectId: string;
  readonly project: NonNullable<ReturnType<typeof getMockProject>>;
};

function ProjectDetailContent({
  projectId,
  project,
}: ProjectDetailContentProps) {
  const initialViewsState = readProjectViewsState(projectId);
  const [viewsState, setViewsState] = useState(initialViewsState);
  const [searchQuery, setSearchQuery] = useState("");

  // Local state for tasks to enable inline editing
  const [tasks, setTasks] = useState<MockTask[]>([...project.tasks]);

  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  // URL state for the task modal
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedTaskId = searchParams.get("taskId");

  const selectedView =
    viewsState.views.find(view => view.id === viewsState.selectedViewId) ??
    viewsState.views[0] ??
    DEFAULT_PROJECT_VIEWS_STATE.views[0];

  useEffect(() => {
    writeProjectViewsState(projectId, viewsState);
  }, [projectId, viewsState]);

  const isEmpty = tasks.length === 0;
  const collectionOptions = Array.from(
    new Set(
      tasks
        .map(task => task.collection)
        .filter((value): value is string => Boolean(value)),
    ),
  ).sort((left, right) => left.localeCompare(right));

  const filteredTasks = sortProjectTasks(
    filterProjectTasks(tasks, {
      searchQuery,
      priorityFilter: selectedView.priorityFilter,
      collectionFilter: selectedView.collectionFilter,
    }),
    selectedView.sortKey,
  );

  const handleTaskUpdate = (updatedTask: MockTask) => {
    setTasks(prev =>
      prev.map(t => (t.id === updatedTask.id ? updatedTask : t)),
    );
  };

  const updateSelectedView = (
    updater: (view: ProjectSavedView) => ProjectSavedView,
  ) => {
    setViewsState(prev => {
      const currentView =
        prev.views.find(view => view.id === prev.selectedViewId) ??
        prev.views[0];
      const safeCurrentView =
        currentView ?? DEFAULT_PROJECT_VIEWS_STATE.views[0];

      return {
        ...prev,
        views: prev.views.map(view =>
          view.id === safeCurrentView.id ? updater(safeCurrentView) : view,
        ),
      };
    });
  };

  const handleCreateView = ({
    name,
    layout,
  }: {
    readonly name: string;
    readonly layout: "board" | "list";
  }) => {
    setViewsState(prev => {
      const sourceView =
        prev.views.find(view => view.id === prev.selectedViewId) ??
        prev.views[0];
      const safeSourceView = sourceView ?? DEFAULT_PROJECT_VIEWS_STATE.views[0];

      const nextView = {
        ...safeSourceView,
        id: createProjectSavedViewId(),
        name: name || getNextProjectViewName(layout, prev.views),
        layout,
      };

      return {
        selectedViewId: nextView.id,
        views: [...prev.views, nextView],
      };
    });
  };

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
      {/* Flex wrapper for push-sheet layout */}
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
              <h1 className="font-display text-text-primary text-5xl font-semibold tracking-tight">
                {project.name}
              </h1>

              {!isEmpty && (
                <div className="flex flex-col gap-4 border-b border-white/6 pb-5">
                  <div className="flex items-center justify-between gap-6">
                    <ProjectSavedViewTabs
                      views={viewsState.views}
                      selectedViewId={selectedView.id}
                      onSelectView={viewId =>
                        setViewsState(prev => ({
                          ...prev,
                          selectedViewId: viewId,
                        }))
                      }
                      onCreateView={handleCreateView}
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
                      totalCount={project.tasks.length}
                      onReset={() => {
                        setSearchQuery("");
                        updateSelectedView(view => ({
                          ...view,
                          priorityFilter: "all",
                          collectionFilter: "all",
                          sortKey: "due_date",
                        }));
                      }}
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

        {/* Settings sheet: spacer pushes main, content slides in */}
        <ProjectSettingsSheet
          isOpen={isSettingsOpen}
          onClose={() => setIsSettingsOpen(false)}
          projectName={project.name}
        />
      </div>

      <TaskDetailModal
        taskId={selectedTaskId}
        tasks={tasks}
        collectionOptions={collectionOptions}
        onClose={() => setSearchParams({})}
        onUpdateTask={handleTaskUpdate}
      />
    </AppShell>
  );
}
