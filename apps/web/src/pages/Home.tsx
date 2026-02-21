import { motion } from "framer-motion";
import {
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  Clock,
  Play,
  Sparkles,
  TerminalSquare,
} from "lucide-react";

export default function Home() {
  return (
    <div className="bg-canvas text-text-primary font-body selection:bg-accent-violet/30 relative flex h-screen w-full overflow-hidden">
      {/* Background Atmosphere */}
      <div className="pointer-events-none absolute inset-0 mix-blend-screen">
        <div className="from-accent-blue/[0.03] to-accent-violet/[0.04] absolute inset-0 bg-gradient-to-br via-transparent" />
        <div className="from-accent-cyan/[0.02] absolute inset-0 bg-gradient-to-tr via-transparent to-transparent" />
      </div>

      {/* Left Sidebar (Active Sessions) */}
      <aside className="bg-canvas relative z-10 flex w-[280px] flex-col justify-between border-r border-white/5 p-5">
        <div>
          <div className="mb-10">
            <h3 className="text-text-tertiary mb-4 flex items-center gap-2 text-xs font-semibold tracking-wider uppercase">
              <div className="bg-accent-green/80 h-1.5 w-1.5 rounded-full shadow-[0_0_8px_rgba(166,218,149,0.8)]" />
              Active Context
            </h3>
            <div className="space-y-1.5">
              <button className="group flex w-full items-center justify-between rounded-xl border border-white/[0.03] bg-white/[0.04] px-3 py-2.5 text-left text-sm shadow-sm transition-all duration-300 hover:bg-white/[0.06]">
                <span className="truncate pr-2 font-medium">
                  Refactor Auth Flow
                </span>
                <ChevronRight className="text-text-tertiary h-4 w-4 -translate-x-1 opacity-0 transition-opacity duration-300 group-hover:translate-x-0 group-hover:opacity-100" />
              </button>
              <button className="text-text-secondary group flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left text-sm transition-all duration-300 hover:bg-white/[0.03]">
                <span className="truncate pr-2">
                  Triage: "Dark mode toggle"
                </span>
              </button>
              <button className="text-text-secondary group flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left text-sm transition-all duration-300 hover:bg-white/[0.03]">
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

      {/* Main Dashboard Canvas */}
      <main className="relative z-10 flex flex-1 flex-col">
        <header className="z-20 flex h-16 items-center justify-end px-8">
          <div className="text-text-secondary flex items-center gap-3 text-sm opacity-60 transition-opacity hover:opacity-100">
            <kbd className="text-text-primary rounded-md border border-white/10 bg-white/5 px-2 py-1 font-mono text-[11px] shadow-sm">
              ⌘K
            </kbd>
            <span className="text-xs font-medium tracking-wide uppercase">
              Command Palette
            </span>
          </div>
        </header>

        <div className="custom-scrollbar mx-auto flex w-full max-w-4xl flex-1 flex-col overflow-y-auto px-8 pt-12 pb-16">
          {/* Greeting */}
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
            className="mb-14"
          >
            <h1 className="font-display text-text-primary mb-3 text-5xl font-semibold tracking-tight">
              Brain cache rehydrated.
            </h1>
            <p className="text-text-secondary text-lg font-light">
              State restored. What are we dominating today?
            </p>
          </motion.div>

          {/* Resume Context (Top) */}
          <motion.section
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.1, ease: [0.16, 1, 0.3, 1] }}
            className="mb-12"
          >
            <h2 className="font-display text-text-primary mb-4 flex items-center gap-2.5 text-xl font-medium">
              <Play className="text-accent-blue fill-accent-blue/20 h-5 w-5" />
              Resume Context
            </h2>
            <div className="group relative cursor-pointer">
              {/* Soft glow behind card */}
              <div className="from-accent-blue/20 to-accent-cyan/20 absolute -inset-0.5 rounded-2xl bg-gradient-to-r opacity-0 blur transition duration-700 group-hover:opacity-40"></div>

              <div className="bg-accent-blue/[0.08] border-accent-blue/10 relative overflow-hidden rounded-2xl border p-6 transition-all duration-500">
                <div className="bg-accent-blue/10 pointer-events-none absolute top-0 right-0 translate-x-16 -translate-y-16 rounded-full p-32 blur-3xl" />
                <div className="relative z-10 flex items-center justify-between">
                  <div>
                    <div className="mb-2 flex items-center gap-3">
                      <span className="text-text-primary group-hover:text-accent-blue text-xl font-medium transition-colors duration-300">
                        Refactor Auth Flow
                      </span>
                      <span className="bg-accent-blue/10 text-accent-blue border-accent-blue/10 flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium">
                        <Clock className="h-3 w-3" />
                        Last active 14m ago
                      </span>
                    </div>
                    <p className="text-text-secondary text-sm font-light">
                      Project: Spark System MVP
                    </p>
                  </div>
                  <button className="bg-accent-blue text-canvas hover:bg-accent-blue/90 flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-semibold shadow-sm transition-transform duration-300 group-hover:scale-105">
                    Jump In
                    <ArrowRight className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </div>
          </motion.section>

          {/* Focus Queue (Middle) */}
          <motion.section
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.2, ease: [0.16, 1, 0.3, 1] }}
            className="mb-14"
          >
            <h2 className="font-display text-text-primary mb-4 flex items-center gap-2.5 text-xl font-medium">
              <CheckCircle2 className="text-accent-green h-5 w-5 opacity-80" />
              Focus Queue
            </h2>
            <div className="space-y-3">
              <div className="group flex cursor-pointer items-center justify-between rounded-2xl border border-white/[0.04] bg-white/[0.02] p-5 shadow-sm transition-all duration-300 hover:border-white/[0.08] hover:bg-white/[0.04]">
                <div className="flex flex-col">
                  <span className="group-hover:text-accent-green mb-1 text-[15px] font-medium transition-colors">
                    Implement desktop layout shell
                  </span>
                  <span className="text-text-tertiary text-xs font-medium tracking-wide uppercase">
                    Project: Spark System MVP
                  </span>
                </div>
                <button className="bg-canvas-elevated text-text-primary flex scale-95 items-center gap-2 rounded-xl border border-white/5 px-4 py-2 text-xs font-semibold opacity-0 shadow-sm transition-all duration-300 group-hover:scale-100 group-hover:opacity-100 hover:bg-white/10">
                  <TerminalSquare className="h-3.5 w-3.5" />
                  Start Session
                </button>
              </div>

              <div className="group flex cursor-pointer items-center justify-between rounded-2xl border border-white/[0.04] bg-white/[0.02] p-5 shadow-sm transition-all duration-300 hover:border-white/[0.08] hover:bg-white/[0.04]">
                <div className="flex flex-col">
                  <span className="group-hover:text-accent-green mb-1 text-[15px] font-medium transition-colors">
                    Write setup instructions for SQLite
                  </span>
                  <span className="text-text-tertiary text-xs font-medium tracking-wide uppercase">
                    Project: Backend Foundation
                  </span>
                </div>
              </div>
            </div>
          </motion.section>

          {/* Triage Inbox (Bottom) */}
          <motion.section
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.3, ease: [0.16, 1, 0.3, 1] }}
          >
            <div className="mb-4 flex items-center justify-between">
              <h2 className="font-display text-text-primary flex items-center gap-2.5 text-xl font-medium">
                <Sparkles className="text-accent-violet h-5 w-5" />
                Triage Inbox
              </h2>
              <button className="text-text-tertiary hover:text-accent-violet flex items-center gap-1.5 text-sm font-medium transition-colors">
                View all 12 sparks
                <ArrowRight className="h-4 w-4" />
              </button>
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              {[
                { title: "Git worktree parallelization", time: "2h ago" },
                { title: "New dashboard mock", time: "4h ago" },
                { title: "Migrate away from CRA", time: "Yesterday" },
              ].map((spark, idx) => (
                <div key={idx} className="group relative cursor-pointer">
                  <div className="from-accent-violet/10 to-accent-blue/10 absolute -inset-0.5 rounded-2xl bg-gradient-to-br opacity-0 blur transition duration-500 group-hover:opacity-100"></div>
                  <div className="bg-canvas-subtle hover:bg-canvas-elevated relative flex h-full flex-col justify-between rounded-2xl border border-white/5 p-5 transition-colors duration-300">
                    <div>
                      <p className="text-text-primary group-hover:text-accent-violet mb-3 text-[15px] leading-snug font-medium transition-colors">
                        "{spark.title}"
                      </p>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-text-tertiary text-xs">
                        {spark.time}
                      </span>
                      <div className="bg-accent-violet/10 text-accent-violet flex h-6 w-6 items-center justify-center rounded-full opacity-0 transition-opacity duration-300 group-hover:opacity-100">
                        <ArrowRight className="h-3 w-3" />
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </motion.section>
        </div>
      </main>
    </div>
  );
}
