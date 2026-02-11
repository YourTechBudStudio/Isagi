import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from "react-native-reanimated";

import { FocusQueueItem } from "@/components/home/FocusQueueItem";
import type { FocusQueueItem as FocusQueueItemType } from "@/constants/mock-data";

/** Anti-overwhelm cap per spec. */
const DEFAULT_VISIBLE = 3;

interface FocusQueueProps {
  readonly items: readonly FocusQueueItemType[];
}

export function FocusQueue({ items }: FocusQueueProps): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const opacity = useSharedValue(0);
  const translateY = useSharedValue(16);

  useEffect(() => {
    opacity.value = withDelay(400, withTiming(1, { duration: 700 }));
    translateY.value = withDelay(400, withTiming(0, { duration: 700 }));
  }, [opacity, translateY]);

  const animStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateY: translateY.value }],
  }));

  const visibleItems = expanded ? items : items.slice(0, DEFAULT_VISIBLE);
  const hasMore = items.length > DEFAULT_VISIBLE;

  return (
    <View className="mb-7">
      <Animated.View style={animStyle}>
        {/* Section header */}
        <View className="mb-3 flex-row items-center justify-between">
          <Text className="font-display-semi text-text-tertiary text-xs tracking-widest uppercase">
            What needs you
          </Text>
          <View className="bg-accent-amber-soft rounded-full px-2.5 py-1">
            <Text className="font-body-semi text-accent-amber text-[10px]">
              {items.filter(i => i.type === "waiting").length} blocked
            </Text>
          </View>
        </View>

        {/* Items */}
        {visibleItems.map(item => (
          <FocusQueueItem key={item.id} item={item} />
        ))}

        {/* Show all / collapse toggle */}
        {hasMore && (
          <Pressable
            onPress={() => setExpanded(prev => !prev)}
            accessibilityRole="button"
            accessibilityLabel={
              expanded ? "Show fewer items" : "Show all items"
            }
            className="mt-2 items-center py-2"
          >
            <Text className="font-body-medium text-accent-blue text-sm">
              {expanded ? "Show less" : `Show all (${items.length})`}
            </Text>
          </Pressable>
        )}
      </Animated.View>
    </View>
  );
}
