import { ArrowRight } from "lucide-react";

import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { cn } from "@/lib/cn";

type SparkCardProps = {
  readonly title: string;
  readonly time: string;
  readonly className?: string;
};

export function SparkCard({ title, time, className }: SparkCardProps) {
  return (
    <div className={cn("group relative cursor-pointer", className)}>
      <div className="from-accent-violet/10 to-accent-blue/10 absolute -inset-0.5 rounded-2xl bg-gradient-to-br opacity-0 blur transition duration-500 group-hover:opacity-100" />
      <SurfaceCard
        tone="subtle"
        interactive
        className="hover:bg-canvas-elevated relative flex h-full flex-col justify-between p-5 transition-colors duration-300"
      >
        <div>
          <p className="text-text-primary group-hover:text-accent-violet mb-3 text-[15px] leading-snug font-medium transition-colors">
            "{title}"
          </p>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-text-tertiary text-xs">{time}</span>
          <div className="bg-accent-violet/10 text-accent-violet flex h-6 w-6 items-center justify-center rounded-full opacity-0 transition-opacity duration-300 group-hover:opacity-100">
            <ArrowRight className="h-3 w-3" />
          </div>
        </div>
      </SurfaceCard>
    </div>
  );
}
