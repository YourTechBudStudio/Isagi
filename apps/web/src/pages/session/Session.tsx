import { motion } from "framer-motion";
import {
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  Code2,
  CornerDownRight,
  FileCode,
  GitBranch,
  PanelRight,
  Sparkles,
  Terminal,
  TerminalSquare,
  X,
  XCircle,
} from "lucide-react";
import { useState } from "react";

import { AppShell } from "@/components/layout/AppShell";
import { ContextSidebar } from "@/components/layout/ContextSidebar";
import { ScrollableArea } from "@/components/layout/ScrollableArea";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { cn } from "@/lib/cn";

const sidebarItems = [
  { id: "auth", label: "Refactor Auth Flow", state: "active" },
  {
    id: "dark-mode",
    label: 'Triage: "Dark mode toggle"',
    state: "highlighted",
  },
  { id: "db-research", label: "Research: sqlite vs turso" },
] as const;

export default function Session() {
  const [rightPanelOpen, setRightPanelOpen] = useState(true);

  return (
    <AppShell
      sidebar={<ContextSidebar items={sidebarItems} />}
      atmosphere={
        <div className="pointer-events-none absolute inset-0 mix-blend-screen">
          <div className="from-accent-blue/2 to-accent-violet/3 absolute inset-0 bg-linear-to-br via-transparent" />
        </div>
      }
    >
      <main className="relative z-10 flex flex-1 flex-col">
        <header className="pointer-events-none absolute top-6 right-6 left-6 z-20 flex items-center justify-between">
          <div className="text-text-tertiary pointer-events-auto flex items-center gap-2 text-sm font-medium">
            <span className="hover:text-text-secondary cursor-pointer transition-colors">
              Frontend
            </span>
            <ChevronRight className="h-3.5 w-3.5 opacity-50" />
            <span className="hover:text-text-secondary cursor-pointer transition-colors">
              Spark System
            </span>
            <ChevronRight className="h-3.5 w-3.5 opacity-50" />
            <span className="text-text-primary">Triage: Dark mode toggle</span>
          </div>

          <div className="bg-canvas-elevated/80 pointer-events-auto flex items-center gap-3 rounded-2xl border border-white/10 p-1.5 shadow-lg backdrop-blur-md">
            <div className="flex items-center gap-2 border-r border-white/10 px-3 py-1">
              <GitBranch className="text-text-secondary h-4 w-4" />
              <span className="text-text-secondary font-mono text-sm">
                main
              </span>
              <div
                className="bg-accent-amber ml-1 h-1.5 w-1.5 animate-pulse rounded-full"
                title="Uncommitted changes"
              />
            </div>

            <div className="flex items-center gap-1 px-1">
              <IconButton
                icon={<Terminal className="h-4 w-4" />}
                title="Open Terminal"
              />
              <IconButton
                icon={<Code2 className="h-4 w-4" />}
                title="Open VS Code"
              />
            </div>

            <Button
              variant="primary"
              size="md"
              leadingIcon={<CheckCircle2 className="h-4 w-4" />}
              className="bg-accent-violet hover:bg-accent-violet/90 text-canvas ml-1"
            >
              Complete Task
            </Button>

            <div className="ml-1 border-l border-white/10 pl-1">
              <IconButton
                icon={<PanelRight className="h-4 w-4" />}
                onClick={() => setRightPanelOpen(!rightPanelOpen)}
                title="Toggle Artifacts"
                className={cn(rightPanelOpen && "text-text-primary bg-white/5")}
              />
            </div>
          </div>
        </header>

        <ScrollableArea className="flex-1 px-12 pt-24 pb-48">
          <div className="mx-auto flex max-w-3xl flex-col gap-8">
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex justify-end"
            >
              <div className="max-w-[80%] rounded-2xl rounded-tr-sm border border-white/5 bg-white/5 px-5 py-3.5">
                <p className="text-text-primary text-[15px] leading-relaxed">
                  I want to add a dark mode toggle to the desktop app. It should
                  sit in the bottom left corner near the user profile.
                </p>
              </div>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
              className="flex max-w-[85%] flex-col gap-3"
            >
              <div className="text-accent-violet mb-1 flex items-center gap-2">
                <Sparkles className="h-4 w-4" />
                <span className="font-display text-sm font-medium">
                  Triager
                </span>
              </div>

              <div className="border-accent-violet/30 border-l-2 py-1 pl-4">
                <div className="text-text-secondary hover:text-text-primary mb-2 flex cursor-pointer items-center gap-2 text-sm font-medium transition-colors">
                  <ChevronRight className="h-3.5 w-3.5 rotate-90" />
                  Analyzing current theme architecture...
                </div>
                <div className="text-text-tertiary pr-4 text-[14px] leading-relaxed font-light">
                  The user wants a dark mode toggle. Checking the
                  `frontend-design` skill, we are using Catppuccin Macchiato as
                  the canonical palette, which is inherently dark. A "dark mode
                  toggle" might imply they want a light mode variant (Latte?),
                  or they want to toggle between system default and forced
                  Macchiato. Let&apos;s check `global.css` to see how Tailwind
                  v4 is configured for themes.
                </div>
              </div>

              <SurfaceCard
                tone="elevated"
                className="bg-canvas-elevated my-2 overflow-hidden rounded-xl border-white/5 font-mono text-[13px]"
              >
                <div className="flex items-center justify-between border-b border-white/5 bg-white/2 px-4 py-2">
                  <div className="text-text-secondary flex items-center gap-2">
                    <TerminalSquare className="h-3.5 w-3.5" />
                    <span>read(filePath: "apps/web/src/global.css")</span>
                  </div>
                  <span className="text-accent-green flex items-center gap-1 text-xs">
                    <CheckCircle2 className="h-3 w-3" /> 12ms
                  </span>
                </div>
                <div className="text-text-tertiary custom-scrollbar max-h-32 overflow-y-auto bg-black/20 p-4">
                  <pre>
                    <code>
                      {`@theme {
  --color-canvas: #24273a;
  --color-canvas-elevated: #363a4f;
  --color-text-primary: #cad3f5;
  /* ... */
}`}
                    </code>
                  </pre>
                </div>
              </SurfaceCard>

              <div className="text-text-primary space-y-4 text-[15px] leading-relaxed">
                <p>
                  I&apos;ve checked the styles. We are currently hardcoded to
                  the <strong>Catppuccin Macchiato</strong> dark theme.
                </p>
                <p>
                  To implement a toggle, we&apos;ll need to define a light theme
                  palette (like Catppuccin Latte) in CSS variables and add a
                  state manager (Zustand or React Context) to toggle a `.dark`
                  or `.theme-latte` class on the root HTML element.
                </p>
                <p className="text-accent-blue font-medium">
                  I&apos;m plotting a scheme. I&apos;ve drafted some proposals
                  in the panel on the right. Review them, and if they look
                  sufficiently diabolical, we can finalize and get to building.
                </p>
              </div>
            </motion.div>
          </div>
        </ScrollableArea>

        <div className="from-canvas via-canvas pointer-events-none absolute right-0 bottom-0 left-0 bg-linear-to-t to-transparent p-6 pt-12">
          <div className="pointer-events-auto mx-auto max-w-3xl">
            <div className="bg-canvas-elevated focus-within:border-accent-violet/50 focus-within:ring-accent-violet/20 overflow-hidden rounded-2xl border border-white/10 shadow-2xl transition-all focus-within:ring-1">
              <div className="p-4 pb-2">
                <textarea
                  className="text-text-primary placeholder:text-text-tertiary max-h-50 min-h-11 w-full resize-none bg-transparent text-[15px] focus:outline-none"
                  placeholder="Tell me what to do... (/ for commands)"
                  rows={1}
                />
              </div>

              <div className="flex items-center justify-between border-t border-white/5 bg-white/2 px-3 py-2.5">
                <div className="flex items-center gap-1.5">
                  <Button
                    variant="ghost"
                    size="sm"
                    leadingIcon={
                      <Sparkles className="text-accent-violet h-3.5 w-3.5" />
                    }
                    trailingIcon={
                      <ChevronRight className="h-3 w-3 rotate-90 opacity-50" />
                    }
                    className="font-medium"
                  >
                    Brainstorming
                  </Button>

                  <div className="mx-1 h-3 w-px bg-white/10" />

                  <Button
                    variant="ghost"
                    size="sm"
                    trailingIcon={
                      <ChevronRight className="h-3 w-3 rotate-90 opacity-50" />
                    }
                    className="font-medium"
                  >
                    Claude 3.5 Sonnet
                  </Button>

                  <Button
                    variant="ghost"
                    size="sm"
                    trailingIcon={
                      <ChevronRight className="h-3 w-3 rotate-90 opacity-50" />
                    }
                    className="font-medium"
                  >
                    Fast
                  </Button>
                </div>

                <div className="flex items-center gap-2">
                  <IconButton
                    icon={<FileCode className="h-4 w-4" />}
                    variant="subtle"
                    size="sm"
                  />
                  <IconButton
                    icon={<CornerDownRight className="h-4 w-4" />}
                    size="sm"
                    className="text-text-primary bg-white/10 hover:bg-white/20"
                  />
                </div>
              </div>
            </div>

            <div className="text-text-tertiary mt-3 text-center text-[11px] font-light">
              Isagi can make mistakes. Verify code before deploying to
              production.
            </div>
          </div>
        </div>
      </main>

      <motion.div
        initial={false}
        animate={{ width: rightPanelOpen ? 384 : 0 }}
        transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
        className="relative z-20 shrink-0"
      >
        <motion.aside
          initial={false}
          animate={{ x: rightPanelOpen ? 0 : "100%" }}
          transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
          className="bg-canvas absolute top-0 bottom-0 left-0 flex w-[384px] flex-col border-l border-white/5 shadow-[-8px_0_24px_rgba(0,0,0,0.2)]"
        >
          <div className="flex h-16 shrink-0 items-center justify-between border-b border-white/5 px-5">
            <h2 className="text-text-tertiary flex items-center gap-2 text-xs font-semibold tracking-wider uppercase">
              <div className="bg-accent-blue/80 h-1.5 w-1.5 rounded-full shadow-[0_0_8px_rgba(138,173,244,0.8)]" />
              Proposed Actions
            </h2>
            <IconButton
              onClick={() => setRightPanelOpen(false)}
              icon={<X className="h-4 w-4" />}
              variant="subtle"
              title="Close Panel"
            />
          </div>

          <ScrollableArea className="flex-1 space-y-4 p-5">
            <SurfaceCard tone="green" className="rounded-xl p-4 transition-all">
              <div className="mb-2 flex items-start justify-between">
                <div className="text-accent-green flex items-center gap-2 text-sm font-semibold">
                  <CheckCircle2 className="h-4 w-4" />
                  Approved
                </div>
              </div>
              <h3 className="text-text-primary mb-1 font-medium">
                Create Project
              </h3>
              <p className="text-text-secondary text-sm">Theme System</p>
            </SurfaceCard>

            <SurfaceCard
              tone="elevated"
              className="rounded-xl border-white/5 bg-white/2 p-4 opacity-60 grayscale transition-all"
            >
              <div className="mb-2 flex items-start justify-between">
                <div className="text-text-tertiary flex items-center gap-2 text-sm font-semibold">
                  <XCircle className="h-4 w-4" />
                  Rejected
                </div>
                <button className="text-text-tertiary hover:text-text-primary text-xs underline decoration-white/20 underline-offset-2">
                  Restore
                </button>
              </div>
              <h3 className="text-text-primary mb-1 font-medium line-through decoration-white/20">
                Create Task
              </h3>
              <p className="text-text-secondary text-sm line-through decoration-white/20">
                Refactor global.css
              </p>
            </SurfaceCard>

            <SurfaceCard
              tone="violet"
              className="group relative overflow-hidden rounded-xl p-4"
            >
              <div className="bg-accent-violet/10 pointer-events-none absolute top-0 right-0 h-24 w-24 translate-x-1/2 -translate-y-1/2 rounded-full blur-2xl" />

              <div className="relative z-10 mb-3 flex items-start justify-between">
                <div className="text-accent-violet flex items-center gap-2 text-sm font-semibold">
                  <CircleDashed className="h-4 w-4" />
                  Pending Review
                </div>
                <button className="text-text-tertiary hover:text-text-primary text-xs transition-colors">
                  Edit
                </button>
              </div>

              <div className="relative z-10 mb-4">
                <h3 className="text-text-primary mb-1 text-[15px] font-medium">
                  Create Task
                </h3>
                <p className="text-text-secondary mb-3 text-sm">
                  Implement Dark Mode Toggle
                </p>
                <div className="text-text-tertiary rounded-lg bg-black/20 p-2.5 font-mono text-xs">
                  Depends on: Project "Theme System"
                </div>
              </div>

              <div className="relative z-10 flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="md"
                  className="bg-accent-green/10 hover:bg-accent-green/20 text-accent-green border-accent-green/20 flex-1 border"
                >
                  Approve
                </Button>
                <Button
                  variant="ghost"
                  size="md"
                  className="bg-accent-red/10 hover:bg-accent-red/20 text-accent-red border-accent-red/20 flex-1 border"
                >
                  Reject
                </Button>
              </div>
            </SurfaceCard>
          </ScrollableArea>

          <div className="bg-canvas/50 border-t border-white/5 p-4 backdrop-blur-md">
            <div className="flex flex-col gap-2">
              <Button
                variant="primary"
                size="lg"
                className="w-full hover:scale-[1.02]"
              >
                Finalize All
              </Button>
              <Button
                variant="ghost"
                size="lg"
                className="text-text-secondary hover:text-text-primary w-full border border-white/10"
              >
                Reject All
              </Button>
            </div>
          </div>
        </motion.aside>
      </motion.div>
    </AppShell>
  );
}
