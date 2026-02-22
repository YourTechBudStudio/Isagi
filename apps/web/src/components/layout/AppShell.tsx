import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

type AppShellProps = {
  readonly sidebar: ReactNode;
  readonly children: ReactNode;
  readonly atmosphere?: ReactNode;
  readonly className?: string;
};

export function AppShell({
  sidebar,
  children,
  atmosphere,
  className,
}: AppShellProps) {
  return (
    <div
      className={cn(
        "bg-canvas text-text-primary font-body selection:bg-accent-violet/30 relative flex h-screen w-full overflow-hidden",
        className,
      )}
    >
      {atmosphere}
      {sidebar}
      {children}
    </div>
  );
}
