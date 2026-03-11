import { AnimatePresence, motion } from "framer-motion";
import { LayoutDashboard, ListTodo } from "lucide-react";
import { useEffect, useState } from "react";
import { useParams } from "react-router";

import { AppShell } from "@/components/layout/AppShell";
import { ContextSidebar } from "@/components/layout/ContextSidebar";
import { ProjectActionBar } from "@/components/project/ProjectActionBar";
import { ProjectBoardView } from "@/components/project/ProjectBoardView";
import { ProjectEmptyState } from "@/components/project/ProjectEmptyState";
import { ProjectListView } from "@/components/project/ProjectListView";
import { ProjectViewContextBar } from "@/components/project/ProjectViewContextBar";
import { cn } from "@/lib/cn";
import { getMockProject } from "@/lib/mock/project.mock";
import {
  mockSidebarProjects,
  mockSidebarTriage,
} from "@/lib/mock/sidebar.mock";
import {
  readProjectViewState,
  writeProjectViewState,
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
  const savedState = readProjectViewState(projectId);
  const [viewMode, setViewMode] = useState(savedState.viewMode);
  const [searchQuery, setSearchQuery] = useState("");
  const [priorityFilter, setPriorityFilter] = useState(
    savedState.priorityFilter,
  );
  const [collectionFilter, setCollectionFilter] = useState(
    savedState.collectionFilter,
  );
  const [sortKey, setSortKey] = useState(savedState.sortKey);

  useEffect(() => {
    writeProjectViewState(projectId, {
      viewMode,
      priorityFilter,
      collectionFilter,
      sortKey,
    });
  }, [collectionFilter, priorityFilter, projectId, sortKey, viewMode]);

  const isEmpty = project.tasks.length === 0;
  const collectionOptions = Array.from(
    new Set(
      project.tasks
        .map(task => task.collection)
        .filter((value): value is string => Boolean(value)),
    ),
  ).sort((left, right) => left.localeCompare(right));
  const filteredTasks = sortProjectTasks(
    filterProjectTasks(project.tasks, {
      searchQuery,
      priorityFilter,
      collectionFilter,
    }),
    sortKey,
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
      <main className="relative z-10 flex h-screen flex-1 flex-col overflow-y-auto">
        {!isEmpty && <ProjectActionBar />}

        <div className="mx-auto flex h-full w-full flex-col px-8 pt-24 pb-32">
          <motion.header
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
            className="mb-8 flex flex-col gap-6"
          >
            <h1 className="font-display text-text-primary text-5xl font-semibold tracking-tight">
              {project.name}
            </h1>

            {!isEmpty && (
              <div className="flex flex-col gap-4 border-b border-white/5 pb-5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setViewMode("board")}
                      className={cn(
                        "flex items-center gap-2 rounded-xl px-3 py-1.5 text-sm font-medium transition-colors",
                        viewMode === "board"
                          ? "text-text-primary bg-white/10"
                          : "text-text-secondary hover:text-text-primary hover:bg-white/5",
                      )}
                    >
                      <LayoutDashboard className="h-4 w-4" />
                      Board
                    </button>
                    <button
                      onClick={() => setViewMode("list")}
                      className={cn(
                        "flex items-center gap-2 rounded-xl px-3 py-1.5 text-sm font-medium transition-colors",
                        viewMode === "list"
                          ? "text-text-primary bg-white/10"
                          : "text-text-secondary hover:text-text-primary hover:bg-white/5",
                      )}
                    >
                      <ListTodo className="h-4 w-4" />
                      List
                    </button>
                  </div>

                  <div className="flex-1" />

                  <ProjectViewContextBar
                    searchQuery={searchQuery}
                    onSearchChange={setSearchQuery}
                    priorityFilter={priorityFilter}
                    onPriorityChange={setPriorityFilter}
                    collectionFilter={collectionFilter}
                    onCollectionChange={setCollectionFilter}
                    sortKey={sortKey}
                    onSortChange={setSortKey}
                    collectionOptions={collectionOptions}
                    resultCount={filteredTasks.length}
                    totalCount={project.tasks.length}
                    onReset={() => {
                      setSearchQuery("");
                      setPriorityFilter("all");
                      setCollectionFilter("all");
                      setSortKey("due_date");
                    }}
                  />
                </div>
              </div>
            )}
          </motion.header>

          <div className="flex-1">
            {isEmpty ? (
              <ProjectEmptyState />
            ) : (
              <AnimatePresence mode="wait">
                {viewMode === "board" ? (
                  <motion.div
                    key="board"
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
                    key="list"
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
    </AppShell>
  );
}
