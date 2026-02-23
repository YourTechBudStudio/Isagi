import { AnimatePresence, motion } from "framer-motion";
import { useState } from "react";

import { AppShell } from "@/components/layout/AppShell";
import { ContextSidebar } from "@/components/layout/ContextSidebar";
import { ActiveTriageCard } from "@/components/sparks/ActiveTriageCard";
import { BacklogSparkCard } from "@/components/sparks/BacklogSparkCard";
import { SparksEmptyState } from "@/components/sparks/SparksEmptyState";
import {
  mockSidebarProjects,
  mockSidebarTriage,
} from "@/lib/mock/sidebar.mock";
import {
  mockActiveTriages,
  mockBacklogOlder,
  mockBacklogThisWeek,
  mockBacklogToday,
} from "@/lib/mock/sparks.mock";

/* 
  =============================================================================
  DATA LAYER & REACT QUERY IMPLEMENTATION NOTES:
  
  When integrating the real backend, replace the local useState mocks below
  with TanStack React Query.
  
  For the backlog queries, you MUST use tight polling to ensure the `generating`
  state automatically updates to a full spark without manual refresh.
  
  Example implementation:
  
  const { data: backlogToday, refetch } = useQuery({
    queryKey: ['sparks', 'backlog', 'today'],
    queryFn: () => fetchBacklogSparks({ timeRange: 'today' }),
    // CRITICAL: Tight polling for background generation updates
    refetchInterval: (data) => {
      // If any spark in the list is still generating, poll every 3 seconds.
      // Otherwise, we can back off or rely on SSE / manual invalidation.
      const hasGenerating = data?.some(spark => spark.status === 'generating');
      return hasGenerating ? 3000 : false;
    }
  });

  For Rejecting a spark:
  const rejectMutation = useMutation({
    mutationFn: (id: string) => rejectSpark(id),
    onMutate: async (id) => {
      // Optimistically remove from all lists for that instant-vanish feel
    },
    onSuccess: () => {
      toast.success("Spark rejected", { action: { label: "Undo", onClick: ... } });
    }
  });
  =============================================================================
*/

export default function Sparks() {
  const [activeTriages] = useState(mockActiveTriages);

  // Local state for mocking the reject interaction
  const [todaySparks, setTodaySparks] = useState(mockBacklogToday);
  const [thisWeekSparks, setThisWeekSparks] = useState(mockBacklogThisWeek);
  const [olderSparks, setOlderSparks] = useState(mockBacklogOlder);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const handleReject = (id: string) => {
    // Instant vanish for Inbox Zero feel
    setTodaySparks(prev => prev.filter(s => s.id !== id));
    setThisWeekSparks(prev => prev.filter(s => s.id !== id));
    setOlderSparks(prev => prev.filter(s => s.id !== id));

    // Mock toast notification
    setToastMessage("Spark rejected.");
    setTimeout(() => setToastMessage(null), 4000);
  };

  const isBacklogEmpty =
    todaySparks.length === 0 &&
    thisWeekSparks.length === 0 &&
    olderSparks.length === 0;

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
          <div className="from-accent-blue/[0.02] to-accent-violet/[0.03] absolute inset-0 bg-gradient-to-br via-transparent" />
        </div>
      }
    >
      <main className="relative z-10 flex h-screen flex-1 flex-col overflow-y-auto">
        <div className="mx-auto flex w-full max-w-4xl flex-col px-8 pt-24 pb-32">
          <motion.header
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
            className="mb-16"
          >
            <h1 className="font-display text-text-primary text-5xl font-semibold tracking-tight">
              Sparks Inbox
            </h1>
          </motion.header>

          {activeTriages.length > 0 && (
            <motion.section
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{
                duration: 0.8,
                delay: 0.1,
                ease: [0.16, 1, 0.3, 1],
              }}
              className="mb-16"
            >
              <h2 className="text-text-tertiary mb-4 text-xs font-semibold tracking-widest uppercase">
                Active Triage
              </h2>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                {activeTriages.map(spark => (
                  <ActiveTriageCard key={spark.id} spark={spark} />
                ))}
              </div>
            </motion.section>
          )}

          <motion.section
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.2, ease: [0.16, 1, 0.3, 1] }}
          >
            {isBacklogEmpty ? (
              <SparksEmptyState />
            ) : (
              <div className="flex flex-col gap-10">
                {todaySparks.length > 0 && (
                  <div>
                    <h3 className="text-text-tertiary bg-canvas/90 sticky top-0 z-10 mb-3 py-2 text-xs font-semibold tracking-widest uppercase backdrop-blur-md">
                      Today
                    </h3>
                    <div className="flex flex-col gap-2">
                      <AnimatePresence>
                        {todaySparks.map(spark => (
                          <motion.div
                            key={spark.id}
                            initial={{ opacity: 1, height: "auto" }}
                            exit={{ opacity: 0, height: 0, marginTop: 0 }}
                            transition={{ duration: 0.3 }}
                          >
                            <BacklogSparkCard
                              spark={spark}
                              onReject={handleReject}
                            />
                          </motion.div>
                        ))}
                      </AnimatePresence>
                    </div>
                  </div>
                )}

                {thisWeekSparks.length > 0 && (
                  <div>
                    <h3 className="text-text-tertiary bg-canvas/90 sticky top-0 z-10 mb-3 py-2 text-xs font-semibold tracking-widest uppercase backdrop-blur-md">
                      This Week
                    </h3>
                    <div className="flex flex-col gap-2">
                      <AnimatePresence>
                        {thisWeekSparks.map(spark => (
                          <motion.div
                            key={spark.id}
                            initial={{ opacity: 1, height: "auto" }}
                            exit={{ opacity: 0, height: 0, marginTop: 0 }}
                            transition={{ duration: 0.3 }}
                          >
                            <BacklogSparkCard
                              spark={spark}
                              onReject={handleReject}
                            />
                          </motion.div>
                        ))}
                      </AnimatePresence>
                    </div>
                  </div>
                )}

                {olderSparks.length > 0 && (
                  <div>
                    <h3 className="text-text-tertiary bg-canvas/90 sticky top-0 z-10 mb-3 py-2 text-xs font-semibold tracking-widest uppercase backdrop-blur-md">
                      Older
                    </h3>
                    <div className="flex flex-col gap-2">
                      <AnimatePresence>
                        {olderSparks.map(spark => (
                          <motion.div
                            key={spark.id}
                            initial={{ opacity: 1, height: "auto" }}
                            exit={{ opacity: 0, height: 0, marginTop: 0 }}
                            transition={{ duration: 0.3 }}
                          >
                            <BacklogSparkCard
                              spark={spark}
                              onReject={handleReject}
                            />
                          </motion.div>
                        ))}
                      </AnimatePresence>
                    </div>
                  </div>
                )}
              </div>
            )}
          </motion.section>
        </div>
      </main>

      {/* Mock Toast Notification for Undo */}
      <AnimatePresence>
        {toastMessage && (
          <motion.div
            initial={{ opacity: 0, y: 50, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.95 }}
            className="bg-canvas-elevated fixed bottom-8 left-1/2 z-50 flex -translate-x-1/2 items-center gap-4 rounded-xl border border-white/10 px-5 py-3 shadow-2xl"
          >
            <span className="text-text-primary text-sm font-medium">
              {toastMessage}
            </span>
            <div className="h-4 w-px bg-white/10" />
            <button
              onClick={() => setToastMessage(null)}
              className="text-accent-blue hover:text-accent-blue/80 text-sm font-semibold transition-colors"
            >
              Undo
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </AppShell>
  );
}
