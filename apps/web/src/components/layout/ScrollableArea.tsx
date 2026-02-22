import type { HTMLAttributes } from "react";

import { cn } from "@/lib/cn";

type ScrollableAreaProps = HTMLAttributes<HTMLDivElement>;

export function ScrollableArea({
  className,
  children,
  ...props
}: ScrollableAreaProps) {
  return (
    <div
      className={cn("custom-scrollbar overflow-y-auto", className)}
      {...props}
    >
      {children}
    </div>
  );
}
