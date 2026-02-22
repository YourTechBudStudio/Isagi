import type { ButtonHTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/cn";

type IconButtonVariant = "ghost" | "subtle";
type IconButtonSize = "sm" | "md";

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  readonly variant?: IconButtonVariant;
  readonly size?: IconButtonSize;
  readonly icon: ReactNode;
};

const variantClasses: Record<IconButtonVariant, string> = {
  ghost: "text-text-secondary hover:text-text-primary hover:bg-white/5",
  subtle: "text-text-tertiary hover:text-text-primary hover:bg-white/5",
};

const sizeClasses: Record<IconButtonSize, string> = {
  sm: "rounded-lg p-1.5",
  md: "rounded-xl p-2",
};

export function IconButton({
  className,
  variant = "ghost",
  size = "md",
  icon,
  type,
  ...props
}: IconButtonProps) {
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center transition-colors",
        variantClasses[variant],
        sizeClasses[size],
        className,
      )}
      type={type ?? "button"}
      {...props}
    >
      {icon}
    </button>
  );
}
