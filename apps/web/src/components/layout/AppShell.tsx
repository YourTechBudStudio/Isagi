import { type ReactNode, useEffect } from "react";

import { CommandPalette } from "@/components/command-palette/CommandPalette";
import { cn } from "@/lib/cn";

type AppShellProps = {
  readonly sidebar: ReactNode;
  readonly children: ReactNode;
  readonly atmosphere?: ReactNode;
  readonly className?: string;
};

const SCROLL_ACTIVITY_CLASS_NAME = "is-scrolling";
const SCROLLBAR_IDLE_TIMEOUT_MS = 900;

export function AppShell({
  sidebar,
  children,
  atmosphere,
  className,
}: AppShellProps) {
  useEffect(() => {
    const timeoutIdsByElement = new WeakMap<HTMLElement, number>();
    const activeElements = new Set<HTMLElement>();

    const resolveScrollableElement = (
      target: EventTarget | null,
    ): HTMLElement | null => {
      if (target instanceof HTMLElement) {
        return target;
      }

      if (
        target instanceof Document &&
        target.scrollingElement instanceof HTMLElement
      ) {
        return target.scrollingElement;
      }

      return null;
    };

    const clearIdleTimeout = (element: HTMLElement): void => {
      const timeoutId = timeoutIdsByElement.get(element);
      if (timeoutId === undefined) {
        return;
      }

      window.clearTimeout(timeoutId);
    };

    const markElementIdle = (element: HTMLElement): void => {
      element.classList.remove(SCROLL_ACTIVITY_CLASS_NAME);
      timeoutIdsByElement.delete(element);
      activeElements.delete(element);
    };

    const handleScroll = (event: Event): void => {
      const scrollableElement = resolveScrollableElement(event.target);
      if (!scrollableElement) {
        return;
      }

      scrollableElement.classList.add(SCROLL_ACTIVITY_CLASS_NAME);
      activeElements.add(scrollableElement);
      clearIdleTimeout(scrollableElement);

      const timeoutId = window.setTimeout(() => {
        markElementIdle(scrollableElement);
      }, SCROLLBAR_IDLE_TIMEOUT_MS);

      timeoutIdsByElement.set(scrollableElement, timeoutId);
    };

    window.addEventListener("scroll", handleScroll, {
      capture: true,
      passive: true,
    });

    return () => {
      for (const element of activeElements) {
        clearIdleTimeout(element);
        markElementIdle(element);
      }

      window.removeEventListener("scroll", handleScroll, true);
    };
  }, []);

  return (
    <div
      className={cn(
        "bg-canvas text-text-primary font-body selection:bg-accent-violet/30 relative flex h-screen w-full overflow-hidden pl-[var(--layout-sidebar-width)]",
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
