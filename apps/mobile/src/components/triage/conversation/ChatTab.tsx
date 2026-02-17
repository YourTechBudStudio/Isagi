import { useEffect, useRef } from "react";
import { ActivityIndicator, FlatList, Text, View } from "react-native";

import { useMessageOrder } from "@/store/triage-messages.selectors";

import { MessageBubble } from "./MessageBubble";

interface ChatTabProps {
  readonly isLoading: boolean;
}

/**
 * Chat transcript tab — message list + composer.
 *
 * Renders message bubbles from the Zustand store. The store is hydrated
 * by the parent screen; SSE events update it in real time.
 */
export function ChatTab({ isLoading }: ChatTabProps): React.ReactElement {
  const messageOrder = useMessageOrder();
  const listRef = useRef<FlatList>(null);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (messageOrder.length > 0) {
      // Small delay to let the layout settle
      const timer = setTimeout(() => {
        listRef.current?.scrollToEnd({ animated: true });
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [messageOrder.length]);

  if (isLoading) {
    return (
      <View className="flex-1 items-center justify-center">
        <ActivityIndicator size="large" color="#c6a0f6" />
        <Text className="font-body text-text-tertiary mt-3 text-sm">
          Rehydrating your brain cache...
        </Text>
      </View>
    );
  }

  if (messageOrder.length === 0) {
    return (
      <View className="flex-1">
        <View className="flex-1 items-center justify-center px-8">
          <Text className="font-display-medium text-text-tertiary text-center text-sm">
            No messages yet. The triager is warming up.
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View className="flex-1">
      <FlatList
        ref={listRef}
        style={{ flex: 1 }}
        data={messageOrder}
        keyExtractor={id => id}
        renderItem={({ item: messageId }) => (
          <MessageBubble messageId={messageId} />
        )}
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingTop: 12,
          paddingBottom: 16,
        }}
        showsVerticalScrollIndicator={false}
      />
    </View>
  );
}
