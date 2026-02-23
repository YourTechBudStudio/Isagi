import { motion } from "framer-motion";
import { ArrowRight, Sparkles, X } from "lucide-react";
import { useNavigate } from "react-router";

import { cn } from "@/lib/cn";
import type { Spark } from "@/lib/mock/sparks.mock";

type BacklogSparkCardProps = {
  readonly spark: Spark;
  readonly onReject: (id: string) => void;
  readonly className?: string;
};

export function BacklogSparkCard({
  spark,
  onReject,
  className,
}: BacklogSparkCardProps) {
  const navigate = useNavigate();
  const isGenerating = spark.status === "generating";

  return (
    <div
      className={cn(
        "group bg-canvas-subtle hover:bg-canvas-elevated relative flex min-h-[84px] w-full items-center overflow-hidden rounded-2xl border border-white/5 p-4 transition-all duration-500 hover:border-white/10 hover:shadow-md",
        className,
      )}
    >
      <div className="flex flex-1 flex-col pr-32">
        {isGenerating ? (
          <motion.div
            initial={{ opacity: 0.5 }}
            animate={{ opacity: [0.5, 1, 0.5] }}
            transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
            className="flex items-center gap-3"
          >
            <div className="bg-accent-blue/20 flex h-8 w-8 shrink-0 items-center justify-center rounded-full">
              <Sparkles className="text-accent-blue h-4 w-4" />
            </div>
            <div className="flex flex-col gap-2">
              <div className="h-4 w-48 rounded-md bg-white/5" />
              <span className="text-text-tertiary text-xs tracking-wide">
                Assimilating idea...
              </span>
            </div>
          </motion.div>
        ) : (
          <div className="flex flex-col gap-1.5">
            <h4 className="text-text-primary group-hover:text-accent-blue text-[15px] leading-snug font-medium transition-colors">
              {spark.title}
            </h4>
            <p className="text-text-secondary line-clamp-2 text-sm font-light">
              {spark.rawSnippet}
            </p>
          </div>
        )}
      </div>

      {!isGenerating && (
        <div className="absolute top-1/2 right-4 flex translate-x-8 -translate-y-1/2 items-center gap-2 opacity-0 transition-all duration-500 ease-out group-hover:translate-x-0 group-hover:opacity-100">
          <button
            onClick={() => onReject(spark.id)}
            className="text-accent-red hover:bg-accent-red/20 bg-accent-red/10 flex h-10 items-center justify-center gap-1.5 rounded-xl px-3 text-xs font-semibold tracking-wide transition-all hover:scale-105"
            aria-label="Reject spark"
          >
            <X className="h-3.5 w-3.5" />
            Reject
          </button>

          <button
            onClick={() => navigate(`/session/${spark.id}`)}
            className="text-accent-blue hover:bg-accent-blue/20 bg-accent-blue/10 flex h-10 items-center justify-center gap-1.5 rounded-xl px-3 text-xs font-semibold tracking-wide transition-all hover:scale-105"
            aria-label="Start Triaging spark"
          >
            Start Triaging
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}
