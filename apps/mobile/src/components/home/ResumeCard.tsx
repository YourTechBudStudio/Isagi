import { useEffect } from "react";
import { Pressable, Text, View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from "react-native-reanimated";

import { GlassCard } from "@/components/ui/GlassCard";
import type { ResumeItem } from "@/constants/mock-data";

interface ResumeCardProps {
  readonly item: ResumeItem | null;
}

/**
 * "Resume where you left off" — device-scoped, mobile-only.
 * Shows either the last active work item or a witty empty state.
 */
export function ResumeCard({ item }: ResumeCardProps): React.ReactElement {
  const opacity = useSharedValue(0);
  const translateY = useSharedValue(16);

  useEffect(() => {
    opacity.value = withDelay(200, withTiming(1, { duration: 700 }));
    translateY.value = withDelay(200, withTiming(0, { duration: 700 }));
  }, [opacity, translateY]);

  const animStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateY: translateY.value }],
  }));

  return (
    <View className="mb-7">
      <Animated.View style={animStyle}>
        <Text className="font-display-semi text-text-tertiary mb-3 text-xs tracking-widest uppercase">
          Resume
        </Text>

        <GlassCard tint="blue">
          {item ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Resume: ${item.workItemTitle}`}
            >
              <View className="flex-row items-center justify-between">
                <Text
                  className="font-display-semi text-text-primary flex-1 text-base"
                  numberOfLines={1}
                >
                  {item.workItemTitle}
                </Text>
                <Text className="font-body text-text-tertiary ml-3 text-xs">
                  {item.updatedAgo}
                </Text>
              </View>

              <Text
                className="font-body text-text-secondary mt-2.5 text-sm leading-5"
                numberOfLines={2}
              >
                {item.agentSnippet}
              </Text>

              <View className="bg-accent-blue-soft mt-4 self-start rounded-full px-4 py-2">
                <Text className="font-body-semi text-accent-blue text-xs">
                  Resume (mobile)
                </Text>
              </View>
            </Pressable>
          ) : (
            <View className="items-center py-5">
              <Text className="font-body-medium text-text-secondary text-sm">
                Nothing to resume. Suspicious.
              </Text>
              <Text className="font-body text-text-tertiary mt-1.5 text-xs">
                {"I'll allow it... for now."}
              </Text>
            </View>
          )}
        </GlassCard>
      </Animated.View>
    </View>
  );
}
