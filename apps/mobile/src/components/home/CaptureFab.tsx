import * as Haptics from "expo-haptics";
import { useEffect } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSpring,
} from "react-native-reanimated";

/**
 * Floating Action Button for capturing sparks.
 * Clean pill with the primary accent color and haptic feedback.
 */
export function CaptureFab(): React.ReactElement {
  const scale = useSharedValue(0);

  useEffect(() => {
    scale.value = withDelay(
      1000,
      withSpring(1, { damping: 12, stiffness: 120 }),
    );
  }, [scale]);

  const animStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handlePress = (): void => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  };

  return (
    <Animated.View style={[styles.container, animStyle]}>
      <Pressable
        onPress={handlePress}
        accessibilityRole="button"
        accessibilityLabel="Capture a spark"
        className="overflow-hidden rounded-full"
      >
        <View className="bg-accent-blue flex-row items-center px-5 py-3.5">
          <Text className="mr-2 text-lg">&#x26A1;</Text>
          <Text className="font-body-semi text-sm text-white">Capture</Text>
        </View>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    bottom: 40,
    right: 24,
    shadowColor: "#007aff",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 16,
    elevation: 8,
  },
});
