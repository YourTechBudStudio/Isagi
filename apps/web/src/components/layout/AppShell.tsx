import type { ReactNode } from "react";

import { CommandPalette } from "@/components/command-palette/CommandPalette";
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
      <CommandPalette />
      {atmosphere}
      {sidebar}
      {children}
    </div>
  );
}
