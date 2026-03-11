import type { HTMLAttributes } from "react";

import { cn } from "@/lib/cn";

type SurfaceCardTone = "subtle" | "elevated" | "blue" | "violet" | "green";

type SurfaceCardProps = HTMLAttributes<HTMLDivElement> & {
  readonly tone?: SurfaceCardTone;
  readonly interactive?: boolean;
};

const toneClasses: Record<SurfaceCardTone, string> = {
  subtle: "bg-canvas-subtle border-white/5",
  elevated: "bg-canvas-elevated/40 border-white/6",
  blue: "bg-accent-blue/[0.08] border-accent-blue/10",
  violet:
    "bg-canvas-subtle border-accent-violet/30 shadow-[0_0_16px_rgba(198,160,246,0.05)]",
  green: "bg-accent-green/4 border-accent-green/20",
};

export function SurfaceCard({
  className,
  tone = "subtle",
  interactive = false,
  children,
  ...props
}: SurfaceCardProps) {
  return (
    <div
      className={cn(
        "rounded-2xl border",
        interactive && "transition-all duration-300",
        toneClasses[tone],
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}
