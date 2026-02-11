import { BlurView } from "expo-blur";
import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";

interface GlassCardProps {
  readonly children: ReactNode;
  readonly className?: string;
  /** Blur intensity 0-100. Defaults to 60 for a soft frosted-glass feel. */
  readonly intensity?: number;
}

/**
 * Light-mode frosted card with blur backdrop. Uses a bright tint
 * and a subtle border so cards feel elevated above the canvas.
 */
export function GlassCard({
  children,
  className,
  intensity = 60,
}: GlassCardProps): React.ReactElement {
  return (
    <View className={`overflow-hidden rounded-2xl ${className ?? ""}`}>
      <BlurView intensity={intensity} tint="light" style={styles.blur}>
        <View className="border-glass-border bg-glass border p-5">
          {children}
        </View>
      </BlurView>
    </View>
  );
}

const styles = StyleSheet.create({
  blur: {
    borderRadius: 16,
    overflow: "hidden",
  },
});
