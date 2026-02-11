import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { useEffect } from "react";
import { Dimensions, Pressable, StyleSheet, Text, View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

/**
 * Floating Action Button for capturing sparks.
 * Clean pill with the primary accent color and haptic feedback.
 */
export function CaptureFab(): React.ReactElement {
  const opacity = useSharedValue(0);
  const insets = useSafeAreaInsets();
  const screenHeight = Dimensions.get("screen").height;
  const windowHeight = Dimensions.get("window").height;
  const systemBottomInset = Math.max(0, screenHeight - windowHeight);
  const navBarGap = Math.max(0, systemBottomInset - insets.bottom);
  const bottomOffset = Math.max(0, insets.bottom - navBarGap);

  useEffect(() => {
    opacity.value = withDelay(
      600,
      withTiming(1, { duration: 250, easing: Easing.out(Easing.ease) }),
    );
  }, [opacity]);

  const animStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
  }));

  const handlePress = (): void => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    router.push("/capture");
  };

  return (
    <Animated.View
      style={[styles.container, { bottom: bottomOffset }, animStyle]}
    >
      <Pressable
        onPress={handlePress}
        accessibilityRole="button"
        accessibilityLabel="Capture a spark"
        className="overflow-hidden rounded-full"
      >
        <View className="bg-accent-blue border-glass-border flex-row items-center rounded-full border px-5 py-3.5">
          <Text className="text-canvas mr-2 text-lg">&#x26A1;</Text>
          <Text className="font-body-semi text-canvas text-sm">Capture</Text>
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
    shadowColor: "#000000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 8,
  },
});
