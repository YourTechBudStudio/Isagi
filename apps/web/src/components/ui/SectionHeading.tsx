import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

type SectionHeadingProps = {
  readonly icon: ReactNode;
  readonly title: string;
  readonly action?: ReactNode;
  readonly className?: string;
};

export function SectionHeading({
  icon,
  title,
  action,
  className,
}: SectionHeadingProps) {
  return (
    <div className={cn("mb-4 flex items-center justify-between", className)}>
      <h2 className="font-display text-text-primary flex items-center gap-2.5 text-xl font-medium">
        {icon}
        {title}
      </h2>
      {action}
    </div>
  );
}
