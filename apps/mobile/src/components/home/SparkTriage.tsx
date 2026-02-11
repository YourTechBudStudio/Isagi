import { useEffect } from "react";
import { Pressable, Text, View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from "react-native-reanimated";

import { GlassCard } from "@/components/ui/GlassCard";
import type { SparkItem } from "@/constants/mock-data";

interface SparkTriageProps {
  readonly sparks: readonly SparkItem[];
}

/**
 * Entry point to the Triager agent conversation.
 * Shows pending sparks that need development + a CTA to dive in.
 */
export function SparkTriage({ sparks }: SparkTriageProps): React.ReactElement {
  const opacity = useSharedValue(0);
  const translateY = useSharedValue(16);

  useEffect(() => {
    opacity.value = withDelay(600, withTiming(1, { duration: 700 }));
    translateY.value = withDelay(600, withTiming(0, { duration: 700 }));
  }, [opacity, translateY]);

  const animStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateY: translateY.value }],
  }));

  return (
    <View className="mb-7">
      <Animated.View style={animStyle}>
        <Text className="font-display-semi text-text-tertiary mb-3 text-xs tracking-widest uppercase">
          Sparks to develop
        </Text>

        <GlassCard>
          {/* Spark count headline */}
          <View className="mb-4 flex-row items-center">
            <View className="bg-accent-violet-soft mr-3 h-10 w-10 items-center justify-center rounded-full">
              <Text className="text-lg">&#x26A1;</Text>
            </View>
            <View className="flex-1">
              <Text className="font-display-semi text-text-primary text-base">
                {sparks.length} spark{sparks.length !== 1 ? "s" : ""} awaiting
                triage
              </Text>
              <Text className="font-body text-text-tertiary mt-0.5 text-xs">
                Raw ideas. Unrefined potential. Your move.
              </Text>
            </View>
          </View>

          {/* Preview of latest sparks */}
          {sparks.slice(0, 2).map(spark => (
            <View
              key={spark.id}
              className="border-glass-border bg-canvas-subtle mb-2.5 rounded-xl border px-4 py-3"
            >
              <Text
                className="font-body text-text-secondary text-sm leading-5"
                numberOfLines={2}
              >
                {`\u201C${spark.text}\u201D`}
              </Text>
              <Text className="font-body text-text-tertiary mt-1.5 text-[10px]">
                {spark.capturedAgo}
              </Text>
            </View>
          ))}

          {/* CTA */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Develop a spark"
            className="bg-accent-violet-soft mt-3 items-center rounded-2xl py-3.5"
          >
            <Text className="font-body-semi text-accent-violet text-sm">
              Develop a spark
            </Text>
          </Pressable>
        </GlassCard>
      </Animated.View>
    </View>
  );
}
