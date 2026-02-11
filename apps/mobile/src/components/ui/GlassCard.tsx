import type { ReactNode } from "react";
import { View } from "react-native";

/**
 * Available pastel tints. Each maps to a soft accent background
 * defined in the @theme tokens (global.css).
 */
type CardTint = "blue" | "violet" | "amber" | "green" | "cyan" | "neutral";

const TINT_BG: Record<CardTint, string> = {
  blue: "bg-accent-blue-soft",
  violet: "bg-accent-violet-soft",
  amber: "bg-accent-amber-soft",
  green: "bg-accent-green-soft",
  cyan: "bg-accent-cyan-soft",
  neutral: "bg-canvas-subtle",
};

interface GlassCardProps {
  readonly children: ReactNode;
  readonly className?: string;
  /** Pastel tint color. Defaults to "blue". */
  readonly tint?: CardTint;
}

/**
 * Pastel-tinted card with a subtle border. Each section of the home
 * screen picks its own tint so the page has visual rhythm instead
 * of uniform white.
 */
export function GlassCard({
  children,
  className,
  tint = "blue",
}: GlassCardProps): React.ReactElement {
  return (
    <View
      className={`${TINT_BG[tint]} border-glass-border rounded-2xl border p-5 ${className ?? ""}`}
    >
      {children}
    </View>
  );
}
