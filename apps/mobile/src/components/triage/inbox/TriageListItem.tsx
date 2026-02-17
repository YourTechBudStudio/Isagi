import {
  AlertTriangle,
  Clock,
  Loader2,
  MessageCircle,
  Pause,
} from "lucide-react-native";
import { memo } from "react";
import { Pressable, Text, View } from "react-native";

import type { TriageListItem as TriageListItemType } from "@/types/triage";

interface TriageListItemProps {
  readonly item: TriageListItemType;
  readonly onPress: (sparkId: string) => void;
}

function formatTimeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Single row in the triage inbox list.
 */
function TriageListItemInner({
  item,
  onPress,
}: TriageListItemProps): React.ReactElement {
  const isClosed = item.closedAt !== null;
  const hasError = item.lastValidationError !== null;

  // Status indicator
  let StatusIcon = Pause;
  let statusColor = "#6e738d";
  let statusLabel = "Idle";

  if (item.waitingOnUser && !isClosed) {
    StatusIcon = MessageCircle;
    statusColor = "#8aadf4";
    statusLabel = "Waiting on you";
  } else if (item.statusType === "busy") {
    StatusIcon = Loader2;
    statusColor = "#f5a97f";
    statusLabel = "Plotting...";
  } else if (isClosed) {
    StatusIcon = Clock;
    statusColor = "#6e738d";
    statusLabel = "Closed";
  }

  return (
    <Pressable
      onPress={() => onPress(item.sparkId)}
      accessibilityRole="button"
      accessibilityLabel={`Open triage for ${item.sparkTitle}`}
      className="border-glass-border bg-canvas-subtle mb-3 rounded-xl border px-4 py-3.5 active:opacity-80"
    >
      <View className="flex-row items-start justify-between">
        <View className="mr-3 flex-1">
          <Text
            className="font-display-medium text-text-primary text-sm leading-5"
            numberOfLines={2}
          >
            {item.sparkTitle}
          </Text>
        </View>
        <Text className="font-body text-text-tertiary text-[10px]">
          {formatTimeAgo(item.updatedAt)}
        </Text>
      </View>

      <View className="mt-2.5 flex-row items-center">
        <StatusIcon size={12} strokeWidth={2.2} color={statusColor} />
        <Text className="font-body text-text-secondary ml-1.5 text-xs">
          {statusLabel}
        </Text>

        {hasError && (
          <View className="ml-3 flex-row items-center">
            <AlertTriangle size={10} strokeWidth={2.5} color="#ed8796" />
            <Text className="font-body text-accent-red ml-1 text-[10px]">
              Schema issue
            </Text>
          </View>
        )}
      </View>
    </Pressable>
  );
}

export const TriageListItem = memo(TriageListItemInner);
