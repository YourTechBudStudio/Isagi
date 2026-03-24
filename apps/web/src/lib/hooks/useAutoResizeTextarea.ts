import { type RefObject, useLayoutEffect } from "react";

export function useAutoResizeTextarea(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string | undefined,
): void {
  useLayoutEffect(() => {
    if (!ref.current) {
      return;
    }

    ref.current.style.height = "auto";
    ref.current.style.height = `${ref.current.scrollHeight}px`;
  }, [ref, value]);
}
