import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

type BadgeTone = "blue" | "green" | "violet" | "amber" | "red" | "neutral";

type BadgeProps = {
  readonly children: ReactNode;
  readonly tone?: BadgeTone;
  readonly icon?: ReactNode;
  readonly className?: string;
};

const toneClasses: Record<BadgeTone, string> = {
  blue: "bg-accent-blue/10 text-accent-blue border-accent-blue/10",
  green: "bg-accent-green/10 text-accent-green border-accent-green/20",
  violet: "bg-accent-violet/10 text-accent-violet border-accent-violet/20",
  amber: "bg-accent-amber/10 text-accent-amber border-accent-amber/20",
  red: "bg-accent-red/10 text-accent-red border-accent-red/20",
  neutral: "bg-white/5 text-text-secondary border-white/10",
};

export function Badge({
  children,
  tone = "neutral",
  icon,
  className,
}: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium",
        toneClasses[tone],
        className,
      )}
    >
      {icon}
      {children}
    </span>
  );
}
