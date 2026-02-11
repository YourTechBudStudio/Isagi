import { useEffect } from "react";
import { Text, View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from "react-native-reanimated";

const GREETINGS: Record<string, { greeting: string; quip: string }> = {
  morning: {
    greeting: "Good morning.",
    quip: "I've been scheming while you slept.",
  },
  afternoon: {
    greeting: "Good afternoon.",
    quip: "Your backlog isn't going to conquer itself.",
  },
  evening: {
    greeting: "Good evening.",
    quip: "I've been plotting while you were away.",
  },
  night: {
    greeting: "Still up?",
    quip: "Bold move. Let's make it count.",
  },
};

function getTimeOfDay(): string {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 22) return "evening";
  return "night";
}

export function Greeting(): React.ReactElement {
  const opacity = useSharedValue(0);
  const translateY = useSharedValue(12);
  const quipOpacity = useSharedValue(0);
  const quipTranslateY = useSharedValue(8);

  useEffect(() => {
    opacity.value = withTiming(1, { duration: 800 });
    translateY.value = withTiming(0, { duration: 800 });
    quipOpacity.value = withDelay(400, withTiming(1, { duration: 600 }));
    quipTranslateY.value = withDelay(400, withTiming(0, { duration: 600 }));
  }, [opacity, translateY, quipOpacity, quipTranslateY]);

  const greetingStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateY: translateY.value }],
  }));

  const quipStyle = useAnimatedStyle(() => ({
    opacity: quipOpacity.value,
    transform: [{ translateY: quipTranslateY.value }],
  }));

  const tod = getTimeOfDay();
  const { greeting, quip } = GREETINGS[tod]!;

  return (
    <View className="mb-8 px-1">
      <Animated.View style={greetingStyle}>
        <Text className="font-display text-text-primary text-3xl tracking-tight">
          {greeting}
        </Text>
      </Animated.View>

      <Animated.View style={quipStyle}>
        <Text className="font-body text-text-secondary mt-2 text-base leading-6">
          {quip}
        </Text>
      </Animated.View>
    </View>
  );
}
