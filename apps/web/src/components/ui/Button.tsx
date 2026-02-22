import type { ButtonHTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/cn";

type ButtonVariant = "primary" | "secondary" | "ghost";
type ButtonSize = "sm" | "md" | "lg";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly leadingIcon?: ReactNode;
  readonly trailingIcon?: ReactNode;
};

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    "bg-accent-blue text-canvas hover:bg-accent-blue/90 shadow-sm hover:scale-105",
  secondary:
    "bg-canvas-elevated text-text-primary border border-white/5 hover:bg-white/10 shadow-sm",
  ghost: "text-text-secondary hover:text-text-primary hover:bg-white/5",
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: "rounded-lg px-2.5 py-1.5 text-xs",
  md: "rounded-xl px-4 py-2 text-sm",
  lg: "rounded-xl px-5 py-2.5 text-sm",
};

export function Button({
  className,
  variant = "primary",
  size = "md",
  leadingIcon,
  trailingIcon,
  children,
  type,
  ...props
}: ButtonProps) {
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center gap-2 font-semibold transition-all duration-300 disabled:cursor-not-allowed disabled:opacity-50",
        variantClasses[variant],
        sizeClasses[size],
        className,
      )}
      type={type ?? "button"}
      {...props}
    >
      {leadingIcon}
      {children}
      {trailingIcon}
    </button>
  );
}
