import { router } from "expo-router";
import { ArrowLeft, Inbox, RefreshCw } from "lucide-react-native";
import { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { TriageFilterBar } from "@/components/triage/inbox/TriageFilterBar";
import { TriageListItem } from "@/components/triage/inbox/TriageListItem";
import { NebulaBackground } from "@/components/ui/NebulaBackground";
import { useTriageList } from "@/hooks/useTriageList";
import type { TriageFilter, TriageListItem as TItem } from "@/types/triage";

/**
 * Triage inbox — list of all triage sessions with filter chips.
 *
 * Sorted: waiting first, then busy, then idle. Within each bucket,
 * most recently updated first.
 */
export default function TriageInboxScreen(): React.ReactElement {
  const { data, isLoading, refetch, isRefetching } = useTriageList();
  const [filter, setFilter] = useState<TriageFilter>("all");

  const handleOpenConversation = useCallback((sparkId: string) => {
    router.push(`/triage/${sparkId}` as any);
  }, []);

  // Compute filter counts
  const counts = useMemo(() => {
    const items = data ?? [];
    return {
      all: items.length,
      waiting: items.filter(i => i.waitingOnUser && !i.closedAt).length,
      in_progress: items.filter(i => i.statusType === "busy" && !i.closedAt)
        .length,
      idle: items.filter(
        i => i.statusType === "idle" && !i.waitingOnUser && !i.closedAt,
      ).length,
      closed: items.filter(i => i.closedAt !== null).length,
      error: items.filter(i => i.lastValidationError !== null).length,
    };
  }, [data]);

  // Filter + sort
  const filteredItems = useMemo(() => {
    let items = data ?? [];

    switch (filter) {
      case "waiting":
        items = items.filter(i => i.waitingOnUser && !i.closedAt);
        break;
      case "in_progress":
        items = items.filter(i => i.statusType === "busy" && !i.closedAt);
        break;
      case "idle":
        items = items.filter(
          i => i.statusType === "idle" && !i.waitingOnUser && !i.closedAt,
        );
        break;
      case "closed":
        items = items.filter(i => i.closedAt !== null);
        break;
      case "error":
        items = items.filter(i => i.lastValidationError !== null);
        break;
    }

    // Sort: waiting > busy > idle, then by updatedAt desc
    return [...items].sort((a, b) => {
      const priority = (i: TItem) => {
        if (i.waitingOnUser && !i.closedAt) return 0;
        if (i.statusType === "busy" && !i.closedAt) return 1;
        if (!i.closedAt) return 2;
        return 3;
      };
      const pa = priority(a);
      const pb = priority(b);
      if (pa !== pb) return pa - pb;
      return b.updatedAt - a.updatedAt;
    });
  }, [data, filter]);

  return (
    <NebulaBackground>
      <SafeAreaView className="flex-1" edges={["top"]}>
        {/* Header */}
        <View className="flex-row items-center justify-between px-5 pt-3 pb-4">
          <Pressable
            onPress={() => router.back()}
            accessibilityRole="button"
            accessibilityLabel="Go back"
            className="h-10 w-10 items-center justify-center rounded-full"
          >
            <ArrowLeft size={20} strokeWidth={2} color="#cad3f5" />
          </Pressable>
          <Text className="font-display-semi text-text-primary text-lg">
            Triage Inbox
          </Text>
          <Pressable
            onPress={() => refetch()}
            disabled={isRefetching}
            accessibilityRole="button"
            accessibilityLabel="Refresh list"
            className="h-10 w-10 items-center justify-center rounded-full"
          >
            {isRefetching ? (
              <ActivityIndicator size="small" color="#6e738d" />
            ) : (
              <RefreshCw size={18} strokeWidth={2} color="#6e738d" />
            )}
          </Pressable>
        </View>

        {/* Filter bar */}
        <TriageFilterBar active={filter} onChange={setFilter} counts={counts} />

        {/* List */}
        {isLoading ? (
          <View className="flex-1 items-center justify-center">
            <ActivityIndicator size="large" color="#c6a0f6" />
          </View>
        ) : filteredItems.length === 0 ? (
          <View className="flex-1 items-center justify-center px-8">
            <Inbox size={40} strokeWidth={1.5} color="#6e738d" />
            <Text className="font-display-medium text-text-tertiary mt-4 text-center text-sm">
              {filter === "all"
                ? "Nothing to unblock. Suspicious. I'll allow it."
                : `No ${filter.replace("_", " ")} items.`}
            </Text>
          </View>
        ) : (
          <FlatList
            data={filteredItems}
            keyExtractor={item => item.sparkId}
            renderItem={({ item }) => (
              <TriageListItem item={item} onPress={handleOpenConversation} />
            )}
            contentContainerClassName="px-5 pb-8"
            showsVerticalScrollIndicator={false}
          />
        )}
      </SafeAreaView>
    </NebulaBackground>
  );
}
