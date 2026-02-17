import { router } from "expo-router";
import { Zap } from "lucide-react-native";
import { useCallback, useEffect } from "react";
import { Pressable, Text, View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from "react-native-reanimated";

import { GlassCard } from "@/components/ui/GlassCard";
import { useTriageList } from "@/hooks/useTriageList";

/**
 * Entry point to the Triager agent conversation.
 * Shows pending triage sparks and CTAs to open triage.
 *
 * Wired to the real `user.triage.list` API endpoint.
 */
export function SparkTriage(): React.ReactElement {
  const { data } = useTriageList();

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

  // Only show open (non-closed) triage items
  const openItems = (data ?? []).filter(i => i.closedAt === null);
  const waitingCount = openItems.filter(i => i.waitingOnUser).length;

  const handleOpenFirst = useCallback(() => {
    if (openItems.length > 0) {
      router.push(`/triage/${openItems[0].sparkId}` as any);
    } else {
      router.push("/triage" as any);
    }
  }, [openItems]);

  const handleViewAll = useCallback(() => {
    router.push("/triage" as any);
  }, []);

  // Don't render the card if there are no open triage items
  if (openItems.length === 0 && data !== undefined) {
    return <View />;
  }

  return (
    <View className="mb-7">
      <Animated.View style={animStyle}>
        <Text className="font-display-semi text-text-tertiary mb-3 text-xs tracking-widest uppercase">
          Sparks to develop
        </Text>

        <GlassCard tint="violet">
          {/* Spark count headline */}
          <View className="mb-4 flex-row items-center">
            <View className="bg-accent-violet-soft mr-3 h-10 w-10 items-center justify-center rounded-full">
              <Zap size={18} strokeWidth={2.1} color="#c6a0f6" />
            </View>
            <View className="flex-1">
              <Text className="font-display-semi text-text-primary text-base">
                {openItems.length} spark{openItems.length !== 1 ? "s" : ""}{" "}
                awaiting triage
              </Text>
              <Text className="font-body text-text-tertiary mt-0.5 text-xs">
                {waitingCount > 0
                  ? `${waitingCount} waiting on you. Unblock me.`
                  : "Raw ideas. Unrefined potential. Your move."}
              </Text>
            </View>
          </View>

          {/* Preview of latest sparks */}
          {openItems.slice(0, 2).map(item => (
            <Pressable
              key={item.sparkId}
              onPress={() => router.push(`/triage/${item.sparkId}` as any)}
              className="bg-canvas-elevated mb-2.5 rounded-xl px-4 py-3 active:opacity-80"
            >
              <Text
                className="font-body text-text-secondary text-sm leading-5"
                numberOfLines={2}
              >
                {item.sparkTitle}
              </Text>
              <Text className="font-body text-text-tertiary mt-1.5 text-[10px]">
                {item.waitingOnUser
                  ? "Waiting on you"
                  : item.statusType === "busy"
                    ? "Plotting..."
                    : "Idle"}
              </Text>
            </Pressable>
          ))}

          {/* CTAs */}
          <View className="mt-3 flex-row">
            <Pressable
              onPress={handleOpenFirst}
              accessibilityRole="button"
              accessibilityLabel="Develop a spark"
              className="bg-accent-violet-soft mr-2 flex-1 items-center rounded-2xl py-3.5"
            >
              <Text className="font-body-semi text-accent-violet text-sm">
                Develop a spark
              </Text>
            </Pressable>
            <Pressable
              onPress={handleViewAll}
              accessibilityRole="button"
              accessibilityLabel="View all triage items"
              className="bg-canvas-elevated items-center rounded-2xl px-4 py-3.5"
            >
              <Text className="font-body-semi text-text-secondary text-sm">
                View all
              </Text>
            </Pressable>
          </View>
        </GlassCard>
      </Animated.View>
    </View>
  );
}
