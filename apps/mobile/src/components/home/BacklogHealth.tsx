import { useEffect } from "react";
import { Text, View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from "react-native-reanimated";

import type { BacklogMetrics } from "@/constants/mock-data";

interface BacklogHealthProps {
  readonly metrics: BacklogMetrics;
}

interface MetricPillProps {
  readonly label: string;
  readonly value: number;
  readonly color: string;
  readonly bgColor: string;
}

function MetricPill({
  label,
  value,
  color,
  bgColor,
}: MetricPillProps): React.ReactElement {
  return (
    <View className={`flex-1 items-center rounded-2xl py-4 ${bgColor}`}>
      <Text className={`font-display text-xl ${color}`}>{value}</Text>
      <Text
        className="font-body text-text-tertiary mt-1 text-[10px]"
        numberOfLines={1}
      >
        {label}
      </Text>
    </View>
  );
}

/**
 * Compact glanceable health indicators for the backlog.
 * Answers: "Am I going to run dry?"
 */
export function BacklogHealth({
  metrics,
}: BacklogHealthProps): React.ReactElement {
  const opacity = useSharedValue(0);
  const translateY = useSharedValue(16);

  useEffect(() => {
    opacity.value = withDelay(800, withTiming(1, { duration: 700 }));
    translateY.value = withDelay(800, withTiming(0, { duration: 700 }));
  }, [opacity, translateY]);

  const animStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateY: translateY.value }],
  }));

  return (
    <View className="mb-10">
      <Animated.View style={animStyle}>
        <View className="mb-3 flex-row items-center justify-between">
          <Text className="font-display-semi text-text-tertiary text-xs tracking-widest uppercase">
            Backlog health
          </Text>
          <Text className="font-body text-text-tertiary text-[10px]">
            Am I going to run dry?
          </Text>
        </View>

        <View className="flex-row gap-2.5">
          <MetricPill
            label="Storylines"
            value={metrics.storylinesReady}
            color="text-accent-green"
            bgColor="bg-accent-green-soft"
          />
          <MetricPill
            label="Drafts"
            value={metrics.draftsReady}
            color="text-accent-blue"
            bgColor="bg-accent-blue-soft"
          />
          <MetricPill
            label="Sparks"
            value={metrics.sparksAwaiting}
            color="text-accent-violet"
            bgColor="bg-accent-violet-soft"
          />
          <MetricPill
            label="Blocked"
            value={metrics.waitingOnYou}
            color="text-accent-amber"
            bgColor="bg-accent-amber-soft"
          />
        </View>
      </Animated.View>
    </View>
  );
}
