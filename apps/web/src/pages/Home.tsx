import { FolderPlus, Play, Plus, Rocket } from "lucide-react";

import { HomeCandidateTasksSection } from "@/components/home/HomeCandidateTasksSection";
import { HomeEmptyState } from "@/components/home/HomeEmptyState";
import { HomeIntro } from "@/components/home/HomeIntro";
import { HomeOpenSessionsSection } from "@/components/home/HomeOpenSessionsSection";
import { HomeResumeHero } from "@/components/home/HomeResumeHero";
import { AppShell } from "@/components/layout/AppShell";
import { ContextSidebar } from "@/components/layout/ContextSidebar";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { deriveHomeViewState } from "@/lib/home/deriveHomeViewState";
import { homeScreenData } from "@/lib/mock/home.mock";
import {
  mockSidebarProjects,
  mockSidebarTriage,
} from "@/lib/mock/sidebar.mock";
import { useCommandPaletteActions } from "@/stores/commandPalette.selectors";

export default function Home() {
  const { launchCommand } = useCommandPaletteActions();
  const isMac =
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad|iPod/.test(navigator.platform);
  const commandPaletteShortcut = isMac ? "⌘P" : "Ctrl+P";
  const viewState = deriveHomeViewState(homeScreenData);
  const sidebarProjects =
    homeScreenData.projects.length > 0 ? mockSidebarProjects : [];
  const sidebarTriage =
    homeScreenData.projects.length > 0 ? mockSidebarTriage : [];

  return (
    <AppShell
      sidebar={
        <ContextSidebar
          triageItems={sidebarTriage}
          projects={sidebarProjects}
        />
      }
      atmosphere={
        <div className="pointer-events-none absolute inset-0 mix-blend-screen">
          <div className="from-accent-blue/3 to-accent-violet/4 absolute inset-0 bg-linear-to-br via-transparent" />
          <div className="from-accent-cyan/2 absolute inset-0 bg-linear-to-tr via-transparent to-transparent" />
        </div>
      }
    >
      <main className="relative z-10 flex h-screen flex-1 flex-col overflow-y-auto">
        <div
          className={cn(
            "from-canvas via-canvas/80 pointer-events-none fixed top-0 right-(--layout-scrollbar-size) z-20 h-24 bg-linear-to-b to-transparent",
            "left-(--layout-sidebar-width)",
          )}
        />
        <header className="pointer-events-none fixed top-0 right-0 left-(--layout-sidebar-width) z-30 flex h-16 items-center justify-end px-8">
          <div className="text-text-secondary pointer-events-auto flex items-center gap-3 text-sm opacity-60 transition-opacity hover:opacity-100">
            <kbd className="text-text-primary rounded-md border border-white/10 bg-white/5 px-2 py-1 font-mono text-[11px] shadow-sm">
              {commandPaletteShortcut}
            </kbd>
            <span className="text-xs font-medium tracking-wide uppercase">
              Command Palette
            </span>
          </div>
        </header>

        <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col px-8 pt-28 pb-16">
          {viewState === "no-projects" && (
            <NoProjectsView onAddProject={() => launchCommand("add-project")} />
          )}
          {viewState === "no-sessions" && (
            <NoSessionsView
              onCreateTask={() => launchCommand("create-task")}
              onStartSession={() => launchCommand("start-work-session")}
            />
          )}
          {viewState === "no-resumable" && (
            <NoResumableView tasks={homeScreenData.candidateTasks} />
          )}
          {viewState === "happy-path" && homeScreenData.resumeContext && (
            <HappyPathView
              resumeContext={homeScreenData.resumeContext}
              openSessions={homeScreenData.openSessions}
            />
          )}
        </div>
      </main>
    </AppShell>
  );
}

type NoProjectsViewProps = {
  readonly onAddProject: () => void;
};

function NoProjectsView({ onAddProject }: NoProjectsViewProps) {
  return (
    <HomeEmptyState
      icon={<FolderPlus className="text-text-tertiary h-8 w-8" />}
      title="Nothing to orchestrate. Yet."
      description="Every master plan starts with a repo. Point me at an existing local git project and I'll handle the rest."
      actions={
        <Button
          variant="primary"
          size="lg"
          trailingIcon={<Plus className="h-4 w-4" />}
          onClick={onAddProject}
        >
          Add your first project
        </Button>
      }
    />
  );
}

type NoSessionsViewProps = {
  readonly onStartSession: () => void;
  readonly onCreateTask: () => void;
};

function NoSessionsView({ onCreateTask, onStartSession }: NoSessionsViewProps) {
  return (
    <HomeEmptyState
      icon={<Rocket className="text-accent-blue h-8 w-8" />}
      title="Nothing to unblock. Suspicious."
      description="Zero sessions, zero tasks. Either you shipped everything or something's deeply wrong. Let's find out."
      actions={
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <Button
            variant="primary"
            size="lg"
            trailingIcon={<Play className="h-4 w-4" />}
            onClick={onStartSession}
          >
            Start a session
          </Button>
          <Button
            variant="secondary"
            size="lg"
            trailingIcon={<Plus className="h-4 w-4" />}
            onClick={onCreateTask}
          >
            Create task
          </Button>
        </div>
      }
    />
  );
}

type NoResumableViewProps = {
  readonly tasks: typeof homeScreenData.candidateTasks;
};

function NoResumableView({ tasks }: NoResumableViewProps) {
  return (
    <div className="w-full">
      <HomeIntro
        title="All sessions closed."
        description="Your threads went cold but the backlog never sleeps. Pick one and I'll warm-start your context."
      />
      <HomeCandidateTasksSection tasks={tasks} />
    </div>
  );
}

type HappyPathViewProps = {
  readonly resumeContext: NonNullable<typeof homeScreenData.resumeContext>;
  readonly openSessions: typeof homeScreenData.openSessions;
};

function HappyPathView({ resumeContext, openSessions }: HappyPathViewProps) {
  return (
    <div className="w-full">
      <HomeIntro
        title="Brain cache rehydrated."
        description="Context restored. Shall we resume world domination?"
      />
      <HomeResumeHero context={resumeContext} />
      <HomeOpenSessionsSection sessions={openSessions} />

      {/* Spark surfaces stay parked for Phase 2 so MVP Home remains session-first. */}
    </div>
  );
}
