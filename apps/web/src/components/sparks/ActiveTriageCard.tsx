import { ArrowRight, Clock, Sparkles } from "lucide-react";
import { useNavigate } from "react-router";

import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { cn } from "@/lib/cn";
import type { Spark } from "@/lib/mock/sparks.mock";

type ActiveTriageCardProps = {
  readonly spark: Spark;
  readonly className?: string;
};

export function ActiveTriageCard({ spark, className }: ActiveTriageCardProps) {
  const navigate = useNavigate();

  return (
    <div
      className={cn("group relative cursor-pointer", className)}
      onClick={() => navigate(`/session/${spark.id}`)}
    >
      <div className="from-accent-violet/20 to-accent-blue/20 absolute -inset-0.5 rounded-2xl bg-gradient-to-r opacity-0 blur transition duration-500 group-hover:opacity-40" />

      <SurfaceCard
        tone="elevated"
        interactive
        className="relative flex flex-col justify-between overflow-hidden p-6 transition-all duration-300"
      >
        <div className="bg-accent-violet/10 pointer-events-none absolute top-0 right-0 translate-x-8 -translate-y-8 rounded-full p-24 blur-3xl transition-opacity group-hover:opacity-100" />

        <div className="relative z-10 mb-4 flex items-start justify-between">
          <h3 className="font-display text-text-primary group-hover:text-accent-violet text-xl font-semibold tracking-tight transition-colors">
            {spark.title || "Untitled Spark"}
          </h3>
          <div className="text-text-tertiary group-hover:text-text-secondary flex items-center gap-1.5 text-xs font-medium transition-colors">
            <Clock className="h-3.5 w-3.5" />
            <span>Active</span>
          </div>
        </div>

        <div className="relative z-10 flex items-center justify-between">
          <div className="flex items-center gap-2">
            {spark.waitingOnUser ? (
              <div className="bg-accent-amber h-2 w-2 animate-pulse rounded-full shadow-[0_0_8px_rgba(245,169,127,0.8)]" />
            ) : (
              <Sparkles className="text-accent-blue h-3.5 w-3.5 animate-pulse" />
            )}
            <span
              className={cn(
                "text-sm font-medium",
                spark.waitingOnUser ? "text-accent-amber" : "text-accent-blue",
              )}
            >
              {spark.activeStatusText || "Triaging..."}
            </span>
          </div>

          <div className="bg-accent-violet/10 text-accent-violet flex h-8 w-8 items-center justify-center rounded-full opacity-0 transition-opacity duration-300 group-hover:opacity-100">
            <ArrowRight className="h-4 w-4" />
          </div>
        </div>
      </SurfaceCard>
    </div>
  );
}
