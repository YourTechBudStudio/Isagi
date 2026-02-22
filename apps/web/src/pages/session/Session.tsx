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

export default function Session() {
  const [rightPanelOpen, setRightPanelOpen] = useState(true);

  return (
    <div className="bg-canvas text-text-primary font-body selection:bg-accent-violet/30 relative flex h-screen w-full overflow-hidden">
      {/* Background Atmosphere */}
      <div className="pointer-events-none absolute inset-0 mix-blend-screen">
        <div className="from-accent-blue/2 to-accent-violet/3 absolute inset-0 bg-linear-to-br via-transparent" />
      </div>

      {/* Left Sidebar (Active Sessions) - Kept identical to Home for continuity */}
      <aside className="bg-canvas relative z-10 flex w-70 flex-col justify-between border-r border-white/5 p-5">
        <div>
          <div className="mb-10">
            <h3 className="text-text-tertiary mb-4 flex items-center gap-2 text-xs font-semibold tracking-wider uppercase">
              <div className="bg-accent-green/80 h-1.5 w-1.5 rounded-full shadow-[0_0_8px_rgba(166,218,149,0.8)]" />
              Active Context
            </h3>
            <div className="space-y-1.5">
              <button className="group flex w-full items-center justify-between rounded-xl border border-white/3 bg-white/4 px-3 py-2.5 text-left text-sm shadow-sm transition-all duration-300 hover:bg-white/6">
                <span className="truncate pr-2 font-medium">
                  Refactor Auth Flow
                </span>
                <ChevronRight className="text-text-tertiary h-4 w-4 -translate-x-1 opacity-0 transition-opacity duration-300 group-hover:translate-x-0 group-hover:opacity-100" />
              </button>
              <button className="text-accent-violet group flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left text-sm font-medium transition-all duration-300">
                <span className="truncate pr-2">
                  Triage: "Dark mode toggle"
                </span>
              </button>
              <button className="text-text-secondary group flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left text-sm transition-all duration-300 hover:bg-white/3">
                <span className="truncate pr-2">Research: sqlite vs turso</span>
              </button>
            </div>
          </div>
        </div>

        <div className="text-text-secondary hover:text-text-primary group flex cursor-pointer items-center gap-3 px-2 py-2 text-sm transition-colors">
          <div className="bg-canvas-elevated flex h-8 w-8 items-center justify-center rounded-full border border-white/5 shadow-sm transition-colors group-hover:border-white/10">
            I
          </div>
          <span className="font-medium">Isagi Core</span>
        </div>
      </aside>

      {/* Center Workspace */}
      <main className="relative z-10 flex flex-1 flex-col">
        {/* Floating Action Bar / Header */}
        <header className="pointer-events-none absolute top-6 right-6 left-6 z-20 flex items-center justify-between">
          {/* Breadcrumbs (Left) */}
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

          {/* Action Bar (Right) */}
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
              <button
                className="text-text-secondary hover:text-text-primary rounded-xl p-2 transition-colors hover:bg-white/5"
                title="Open Terminal"
              >
                <Terminal className="h-4 w-4" />
              </button>
              <button
                className="text-text-secondary hover:text-text-primary rounded-xl p-2 transition-colors hover:bg-white/5"
                title="Open VS Code"
              >
                <Code2 className="h-4 w-4" />
              </button>
            </div>

            <button className="bg-accent-violet hover:bg-accent-violet/90 text-canvas ml-1 flex items-center gap-2 rounded-xl px-4 py-1.5 text-sm font-semibold shadow-sm transition-transform duration-300 hover:scale-105">
              <CheckCircle2 className="h-4 w-4" />
              Complete Task
            </button>

            <div className="ml-1 border-l border-white/10 pl-1">
              <button
                className={`text-text-secondary hover:text-text-primary rounded-xl p-2 transition-colors hover:bg-white/5 ${rightPanelOpen ? "text-text-primary bg-white/5" : ""}`}
                onClick={() => setRightPanelOpen(!rightPanelOpen)}
                title="Toggle Artifacts"
              >
                <PanelRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        </header>

        {/* Chat Feed */}
        <div className="custom-scrollbar flex-1 overflow-y-auto px-12 pt-24 pb-48">
          <div className="mx-auto flex max-w-3xl flex-col gap-8">
            {/* User Message */}
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

            {/* Agent Message (Triager) */}
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

              {/* Reasoning Block */}
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
                  Macchiato. Let's check `global.css` to see how Tailwind v4 is
                  configured for themes.
                </div>
              </div>

              {/* Tool Call */}
              <div className="bg-canvas-elevated my-2 overflow-hidden rounded-xl border border-white/5 font-mono text-[13px]">
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
              </div>

              {/* Text Response */}
              <div className="text-text-primary space-y-4 text-[15px] leading-relaxed">
                <p>
                  I've checked the styles. We are currently hardcoded to the{" "}
                  <strong>Catppuccin Macchiato</strong> dark theme.
                </p>
                <p>
                  To implement a toggle, we'll need to define a light theme
                  palette (like Catppuccin Latte) in CSS variables and add a
                  state manager (Zustand or React Context) to toggle a `.dark`
                  or `.theme-latte` class on the root HTML element.
                </p>
                <p className="text-accent-blue font-medium">
                  I'm plotting a scheme. I've drafted some proposals in the
                  panel on the right. Review them, and if they look sufficiently
                  diabolical, we can finalize and get to building.
                </p>
              </div>
            </motion.div>
          </div>
        </div>

        {/* Chat Input (Bottom Anchored) */}
        <div className="from-canvas via-canvas pointer-events-none absolute right-0 bottom-0 left-0 bg-linear-to-t to-transparent p-6 pt-12">
          <div className="pointer-events-auto mx-auto max-w-3xl">
            <div className="bg-canvas-elevated focus-within:border-accent-violet/50 focus-within:ring-accent-violet/20 overflow-hidden rounded-2xl border border-white/10 shadow-2xl transition-all focus-within:ring-1">
              {/* Text Input Area */}
              <div className="p-4 pb-2">
                <textarea
                  className="text-text-primary placeholder:text-text-tertiary max-h-50 min-h-11 w-full resize-none bg-transparent text-[15px] focus:outline-none"
                  placeholder="Tell me what to do... (/ for commands)"
                  rows={1}
                />
              </div>

              {/* Controls & Actions Row */}
              <div className="flex items-center justify-between border-t border-white/5 bg-white/2 px-3 py-2.5">
                {/* Engine Controls (Left) */}
                <div className="flex items-center gap-1.5">
                  <button className="text-text-secondary hover:text-text-primary flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-white/5">
                    <Sparkles className="text-accent-violet h-3.5 w-3.5" />
                    Brainstorming
                    <ChevronRight className="h-3 w-3 rotate-90 opacity-50" />
                  </button>

                  <div className="mx-1 h-3 w-px bg-white/10" />

                  <button className="text-text-secondary hover:text-text-primary flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-white/5">
                    Claude 3.5 Sonnet
                    <ChevronRight className="h-3 w-3 rotate-90 opacity-50" />
                  </button>

                  <button className="text-text-secondary hover:text-text-primary flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-white/5">
                    Fast
                    <ChevronRight className="h-3 w-3 rotate-90 opacity-50" />
                  </button>
                </div>

                {/* Submit Actions (Right) */}
                <div className="flex items-center gap-2">
                  <button className="text-text-tertiary hover:text-text-primary rounded-lg p-1.5 transition-colors hover:bg-white/5">
                    <FileCode className="h-4 w-4" />
                  </button>
                  <button className="text-text-primary rounded-lg bg-white/10 p-1.5 transition-colors hover:bg-white/20">
                    <CornerDownRight className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </div>

            {/* Tiny disclaimer */}
            <div className="text-text-tertiary mt-3 text-center text-[11px] font-light">
              Isagi can make mistakes. Verify code before deploying to
              production.
            </div>
          </div>
        </div>
      </main>

      {/* Right Panel (Triage Artifacts) - Two-Layer Animation */}
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
          {/* Panel Header */}
          <div className="flex h-16 shrink-0 items-center justify-between border-b border-white/5 px-5">
            <h2 className="text-text-tertiary flex items-center gap-2 text-xs font-semibold tracking-wider uppercase">
              <div className="bg-accent-blue/80 h-1.5 w-1.5 rounded-full shadow-[0_0_8px_rgba(138,173,244,0.8)]" />
              Proposed Actions
            </h2>
            <button
              onClick={() => setRightPanelOpen(false)}
              className="text-text-tertiary hover:text-text-primary rounded-lg p-1.5 transition-colors hover:bg-white/5"
              title="Close Panel"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Panel Content (Scrollable) */}
          <div className="custom-scrollbar flex-1 space-y-4 overflow-y-auto p-5">
            {/* Approved Mutation */}
            <div className="bg-accent-green/4 border-accent-green/20 rounded-xl border p-4 transition-all">
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
            </div>

            {/* Rejected Mutation */}
            <div className="rounded-xl border border-white/5 bg-white/2 p-4 opacity-60 grayscale transition-all">
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
            </div>

            {/* Pending Mutation */}
            <div className="bg-canvas-subtle border-accent-violet/30 group relative overflow-hidden rounded-xl border p-4 shadow-[0_0_16px_rgba(198,160,246,0.05)] transition-all">
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
                <button className="bg-accent-green/10 hover:bg-accent-green/20 text-accent-green border-accent-green/20 flex-1 rounded-lg border py-2 text-sm font-semibold transition-colors">
                  Approve
                </button>
                <button className="bg-accent-red/10 hover:bg-accent-red/20 text-accent-red border-accent-red/20 flex-1 rounded-lg border py-2 text-sm font-semibold transition-colors">
                  Reject
                </button>
              </div>
            </div>
          </div>

          {/* Panel Footer (Batch Actions) */}
          <div className="bg-canvas/50 border-t border-white/5 p-4 backdrop-blur-md">
            <div className="flex flex-col gap-2">
              <button className="bg-accent-blue hover:bg-accent-blue/90 text-canvas w-full rounded-xl py-2.5 text-sm font-semibold shadow-sm transition-transform duration-300 hover:scale-[1.02]">
                Finalize All
              </button>
              <button className="text-text-secondary hover:text-text-primary w-full rounded-xl border border-white/10 py-2.5 text-sm font-semibold transition-colors hover:bg-white/5">
                Reject All
              </button>
            </div>
          </div>
        </motion.aside>
      </motion.div>
    </div>
  );
}
