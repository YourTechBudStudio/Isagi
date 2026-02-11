import { LinearGradient } from "expo-linear-gradient";
import type { PropsWithChildren } from "react";
import { StyleSheet, View } from "react-native";

/**
 * Full-screen canvas with a layered nebula wash.
 *
 * Three overlapping gradients at different angles using Catppuccin
 * accent colors at very low opacity create a faint atmospheric wash
 * over the base canvas. Wrap any screen content inside this component.
 */
export function NebulaBackground({
  children,
}: PropsWithChildren): React.ReactElement {
  return (
    <View className="bg-canvas flex-1">
      {/* Mauve wash — top-left to center-right */}
      <LinearGradient
        colors={["rgba(198, 160, 246, 0.035)", "transparent"]}
        start={{ x: 0, y: 0 }}
        end={{ x: 0.8, y: 0.55 }}
        style={styles.wash}
      />
      {/* Blue wash — right-center to left-bottom */}
      <LinearGradient
        colors={["transparent", "rgba(138, 173, 244, 0.03)", "transparent"]}
        start={{ x: 0.6, y: 0.25 }}
        end={{ x: 0.2, y: 0.85 }}
        style={styles.wash}
      />
      {/* Teal wash — bottom-left to center-bottom */}
      <LinearGradient
        colors={["transparent", "rgba(145, 215, 227, 0.025)"]}
        start={{ x: 0.1, y: 0.6 }}
        end={{ x: 0.5, y: 1 }}
        style={styles.wash}
      />

      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  /* Every layer covers the full screen — gradient start/end
     points control where color appears, no hard View edges. */
  wash: {
    ...StyleSheet.absoluteFillObject,
  },
});
