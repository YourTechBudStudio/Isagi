import { motion } from "framer-motion";
import {
  CheckCircle2,
  ChevronRight,
  Sparkles,
  TerminalSquare,
  X,
} from "lucide-react";
import { useState } from "react";

import { AppShell } from "@/components/layout/AppShell";
import { ContextSidebar } from "@/components/layout/ContextSidebar";
import { ScrollableArea } from "@/components/layout/ScrollableArea";
import { Composer } from "@/components/session/Composer";
import { ProposalCard } from "@/components/session/ProposalCard";
import { SessionActionBar } from "@/components/session/SessionActionBar";
import { IconButton } from "@/components/ui/IconButton";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import {
  sessionComposerConfig,
  sessionHeader,
  sessionProposals,
} from "@/lib/mock/session.mock";
import {
  mockSidebarProjects,
  mockSidebarTriage,
} from "@/lib/mock/sidebar.mock";

export default function Session() {
  const [rightPanelOpen, setRightPanelOpen] = useState(true);

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
      <main className="relative z-10 flex flex-1 flex-col">
        <SessionActionBar
          breadcrumbs={sessionHeader.breadcrumbs}
          currentContext={sessionHeader.currentContext}
          branchName={sessionHeader.branchName}
          isArtifactsOpen={rightPanelOpen}
          onToggleArtifacts={() => setRightPanelOpen(!rightPanelOpen)}
        />

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
                  the
                  <strong> Catppuccin Macchiato</strong> dark theme.
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

        <Composer
          modeLabel={sessionComposerConfig.modeLabel}
          modelLabel={sessionComposerConfig.modelLabel}
          speedLabel={sessionComposerConfig.speedLabel}
          placeholder={sessionComposerConfig.placeholder}
          disclaimer={sessionComposerConfig.disclaimer}
        />
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
            {sessionProposals.map(proposal => (
              <ProposalCard
                key={proposal.id}
                status={proposal.status}
                title={proposal.title}
                subtitle={proposal.subtitle}
                dependencyLabel={proposal.dependencyLabel}
              />
            ))}
          </ScrollableArea>
        </motion.aside>
      </motion.div>
    </AppShell>
  );
}
