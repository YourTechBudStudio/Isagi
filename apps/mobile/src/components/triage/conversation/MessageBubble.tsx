import { Bot, User } from "lucide-react-native";
import { memo } from "react";
import { Text, View } from "react-native";

import {
  useMessageInfo,
  useMessagePart,
  useMessagePartIds,
} from "@/store/triage-messages.selectors";

import { MessagePart } from "./MessagePart";

interface MessageBubbleProps {
  readonly messageId: string;
}

/**
 * Renders a single message (user or assistant) with all its parts.
 *
 * Subscribes to the Zustand store via selectors so only this bubble
 * re-renders when its data changes during streaming.
 */
function MessageBubbleInner({
  messageId,
}: MessageBubbleProps): React.ReactElement | null {
  const info = useMessageInfo(messageId);
  const partIds = useMessagePartIds(messageId);

  if (!info) return null;

  const isUser = info.role === "user";

  return (
    <View className={`mb-5 ${isUser ? "items-end" : "items-start"}`}>
      {/* Role indicator */}
      <View className="mb-1.5 flex-row items-center">
        {isUser ? (
          <>
            <Text className="font-display-medium text-text-tertiary mr-1.5 text-[10px] tracking-wider uppercase">
              You
            </Text>
            <View className="bg-accent-blue-soft h-5 w-5 items-center justify-center rounded-full">
              <User size={10} strokeWidth={2.5} color="#8aadf4" />
            </View>
          </>
        ) : (
          <>
            <View className="bg-accent-violet-soft h-5 w-5 items-center justify-center rounded-full">
              <Bot size={10} strokeWidth={2.5} color="#c6a0f6" />
            </View>
            <Text className="font-display-medium text-text-tertiary ml-1.5 text-[10px] tracking-wider uppercase">
              Isagi
            </Text>
          </>
        )}
      </View>

      {/* Message content */}
      <View
        className={`max-w-[92%] rounded-2xl px-4 py-3 ${
          isUser
            ? "bg-accent-blue-soft rounded-tr-md"
            : "bg-canvas-subtle rounded-tl-md"
        }`}
      >
        {partIds.length > 0 ? (
          partIds.map(partId => <MessagePartRow key={partId} partId={partId} />)
        ) : (
          <Text className="font-body text-text-tertiary text-sm italic">
            ...
          </Text>
        )}
      </View>
    </View>
  );
}

const MessagePartRow = memo(function MessagePartRow({
  partId,
}: {
  readonly partId: string;
}): React.ReactElement | null {
  const part = useMessagePart(partId);
  if (!part) {
    return null;
  }

  return <MessagePart part={part} />;
});

export const MessageBubble = memo(MessageBubbleInner);
