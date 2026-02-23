import { motion } from "framer-motion";
import {
  ArrowRight,
  CheckCircle2,
  Clock,
  Play,
  Sparkles,
  TerminalSquare,
} from "lucide-react";

import { FocusQueueItem } from "@/components/home/FocusQueueItem";
import { SparkCard } from "@/components/home/SparkCard";
import { AppShell } from "@/components/layout/AppShell";
import { ContextSidebar } from "@/components/layout/ContextSidebar";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { SectionHeading } from "@/components/ui/SectionHeading";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { cn } from "@/lib/cn";
import {
  homeFocusQueueItems,
  homeInboxSparkCount,
  homeResumeContext,
  homeSparks,
} from "@/lib/mock/home.mock";
import { homeSidebarItems } from "@/lib/mock/sidebar.mock";

export default function Home() {
  const isMac =
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad|iPod/.test(navigator.platform);
  const commandPaletteShortcut = isMac ? "⌘P" : "Ctrl+P";

  return (
    <AppShell
      sidebar={<ContextSidebar items={homeSidebarItems} />}
      atmosphere={
        <div className="pointer-events-none absolute inset-0 mix-blend-screen">
          <div className="from-accent-blue/[0.03] to-accent-violet/[0.04] absolute inset-0 bg-gradient-to-br via-transparent" />
          <div className="from-accent-cyan/[0.02] absolute inset-0 bg-gradient-to-tr via-transparent to-transparent" />
        </div>
      }
    >
      <main className="relative z-10 flex h-screen flex-1 flex-col overflow-y-auto">
        <div
          className={cn(
            "from-canvas via-canvas/80 pointer-events-none fixed top-0 right-0 z-20 h-24 bg-linear-to-b to-transparent",
            "left-[var(--layout-sidebar-width)]",
          )}
        />
        <header className="pointer-events-none fixed top-0 right-0 left-[var(--layout-sidebar-width)] z-30 flex h-16 items-center justify-end px-8">
          <div className="text-text-secondary pointer-events-auto flex items-center gap-3 text-sm opacity-60 transition-opacity hover:opacity-100">
            <kbd className="text-text-primary rounded-md border border-white/10 bg-white/5 px-2 py-1 font-mono text-[11px] shadow-sm">
              {commandPaletteShortcut}
            </kbd>
            <span className="text-xs font-medium tracking-wide uppercase">
              Command Palette
            </span>
          </div>
        </header>

        <div className="mx-auto flex w-full max-w-4xl flex-col px-8 pt-28 pb-16">
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

          <motion.section
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.1, ease: [0.16, 1, 0.3, 1] }}
            className="mb-12"
          >
            <SectionHeading
              icon={
                <Play className="text-accent-blue fill-accent-blue/20 h-5 w-5" />
              }
              title="Resume Context"
            />

            <div className="group relative cursor-pointer">
              <div className="from-accent-blue/20 to-accent-cyan/20 absolute -inset-0.5 rounded-2xl bg-gradient-to-r opacity-0 blur transition duration-700 group-hover:opacity-40" />

              <SurfaceCard
                tone="blue"
                className="relative overflow-hidden p-6 transition-all duration-500"
              >
                <div className="bg-accent-blue/10 pointer-events-none absolute top-0 right-0 translate-x-16 -translate-y-16 rounded-full p-32 blur-3xl" />
                <div className="relative z-10 flex items-center justify-between">
                  <div>
                    <div className="mb-2 flex items-center gap-3">
                      <span className="text-text-primary group-hover:text-accent-blue text-xl font-medium transition-colors duration-300">
                        {homeResumeContext.title}
                      </span>
                      <Badge
                        tone="blue"
                        icon={<Clock className="h-3 w-3" />}
                        className="border-accent-blue/10"
                      >
                        {homeResumeContext.lastActiveLabel}
                      </Badge>
                    </div>
                    <p className="text-text-secondary text-sm font-light">
                      {homeResumeContext.projectLabel}
                    </p>
                  </div>
                  <Button
                    variant="primary"
                    size="lg"
                    trailingIcon={<ArrowRight className="h-4 w-4" />}
                    className="group-hover:scale-105"
                  >
                    Jump In
                  </Button>
                </div>
              </SurfaceCard>
            </div>
          </motion.section>

          <motion.section
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.2, ease: [0.16, 1, 0.3, 1] }}
            className="mb-14"
          >
            <SectionHeading
              icon={
                <CheckCircle2 className="text-accent-green h-5 w-5 opacity-80" />
              }
              title="Focus Queue"
            />

            <div className="space-y-3">
              {homeFocusQueueItems.map(item => (
                <FocusQueueItem
                  key={item.id}
                  title={item.title}
                  project={item.project}
                  action={
                    item.actionLabel ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        leadingIcon={<TerminalSquare className="h-3.5 w-3.5" />}
                        className="scale-95 opacity-0 group-hover:scale-100 group-hover:opacity-100"
                      >
                        {item.actionLabel}
                      </Button>
                    ) : null
                  }
                />
              ))}
            </div>
          </motion.section>

          <motion.section
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.3, ease: [0.16, 1, 0.3, 1] }}
          >
            <SectionHeading
              icon={<Sparkles className="text-accent-violet h-5 w-5" />}
              title="Triage Inbox"
              action={
                <Button
                  variant="ghost"
                  size="sm"
                  trailingIcon={<ArrowRight className="h-4 w-4" />}
                  className="text-text-tertiary hover:text-accent-violet font-medium"
                >
                  View all {homeInboxSparkCount} sparks
                </Button>
              }
            />

            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              {homeSparks.map(spark => (
                <SparkCard
                  key={spark.id}
                  title={spark.title}
                  time={spark.time}
                />
              ))}
            </div>
          </motion.section>
        </div>
      </main>
    </AppShell>
  );
}
