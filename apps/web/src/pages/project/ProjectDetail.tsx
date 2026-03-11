import { AnimatePresence, motion } from "framer-motion";
import { LayoutDashboard, ListTodo } from "lucide-react";
import { useState } from "react";
import { useParams } from "react-router";

import { AppShell } from "@/components/layout/AppShell";
import { ContextSidebar } from "@/components/layout/ContextSidebar";
import { ProjectActionBar } from "@/components/project/ProjectActionBar";
import { ProjectBoardView } from "@/components/project/ProjectBoardView";
import { ProjectEmptyState } from "@/components/project/ProjectEmptyState";
import { ProjectListView } from "@/components/project/ProjectListView";
import { cn } from "@/lib/cn";
import { getMockProject } from "@/lib/mock/project.mock";
import {
  mockSidebarProjects,
  mockSidebarTriage,
} from "@/lib/mock/sidebar.mock";

type ViewMode = "board" | "list";

export default function ProjectDetail() {
  const { id } = useParams<{ id: string }>();
  const [viewMode, setViewMode] = useState<ViewMode>("board");

  const project = getMockProject(id ?? "");

  if (!project) {
    return (
      <AppShell sidebar={<ContextSidebar />}>
        <div className="flex h-screen items-center justify-center">
          <p className="text-text-secondary">Project not found.</p>
        </div>
      </AppShell>
    );
  }

  const isEmpty = project.tasks.length === 0;

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

        <div className="mx-auto flex h-full w-full max-w-350 flex-col px-8 pt-24 pb-32">
          <motion.header
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
            className="mb-12 flex flex-col gap-6"
          >
            <h1 className="font-display text-text-primary text-5xl font-semibold tracking-tight">
              {project.name}
            </h1>

            {!isEmpty && (
              <div className="flex items-center gap-2 border-b border-white/5 pb-4">
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
                    <ProjectBoardView tasks={project.tasks} />
                  </motion.div>
                ) : (
                  <motion.div
                    key="list"
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    transition={{ duration: 0.3 }}
                  >
                    <ProjectListView tasks={project.tasks} />
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
