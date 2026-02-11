import { Pressable, Text, View } from "react-native";

import type { FocusQueueItem as FocusQueueItemType } from "@/constants/mock-data";

interface FocusQueueItemProps {
  readonly item: FocusQueueItemType;
}

/**
 * Single row in the Focus Queue.
 * "Waiting on you" items get a warm amber accent.
 * "Suggested next" items use the primary blue accent.
 */
export function FocusQueueItem({
  item,
}: FocusQueueItemProps): React.ReactElement {
  const isWaiting = item.type === "waiting";

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${isWaiting ? "Waiting on you" : "Suggested next"}: ${item.title}`}
      className="mb-3"
    >
      <View className="border-glass-border bg-glass flex-row items-start rounded-2xl border p-4">
        {/* Accent bar */}
        <View
          className={`mt-0.5 mr-3.5 h-11 w-1 rounded-full ${
            isWaiting ? "bg-accent-amber" : "bg-accent-blue"
          }`}
        />

        <View className="flex-1">
          {/* Type chip + timestamp */}
          <View className="mb-1.5 flex-row items-center">
            <View
              className={`mr-2 rounded-full px-2.5 py-0.5 ${
                isWaiting ? "bg-accent-amber-soft" : "bg-accent-blue-soft"
              }`}
            >
              <Text
                className={`font-body-medium text-[10px] tracking-wider uppercase ${
                  isWaiting ? "text-accent-amber" : "text-accent-blue"
                }`}
              >
                {isWaiting ? "Waiting on you" : "Suggested next"}
              </Text>
            </View>
            <Text className="font-body text-text-tertiary text-[10px]">
              {item.updatedAgo}
            </Text>
          </View>

          {/* Title */}
          <Text
            className="font-display-medium text-text-primary text-sm"
            numberOfLines={1}
          >
            {item.title}
          </Text>

          {/* Subtitle */}
          <Text
            className="font-body text-text-secondary mt-1 text-xs leading-5"
            numberOfLines={2}
          >
            {item.subtitle}
          </Text>
        </View>
      </View>
    </Pressable>
  );
}
