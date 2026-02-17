import { useMutation } from "@tanstack/react-query";
import { Send } from "lucide-react-native";
import { useCallback, useState } from "react";
import { ActivityIndicator, Pressable, TextInput, View } from "react-native";

import { useORPC } from "@/services/ORPCContext";

interface ChatComposerProps {
  readonly sparkId: string;
}

/**
 * Chat input + send button at the bottom of the chat tab.
 *
 * Calls `user.triage.send` on submit. Input is cleared immediately
 * on send — the SSE stream will surface the agent's response.
 */
export function ChatComposer({
  sparkId,
}: ChatComposerProps): React.ReactElement {
  const orpc = useORPC();
  const [text, setText] = useState("");

  const sendMutation = useMutation({
    ...orpc.user.triage.send.mutationOptions(),
  });

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || sendMutation.isPending) return;

    setText("");
    sendMutation.mutate({ sparkId, text: trimmed });
  }, [text, sparkId, sendMutation]);

  return (
    <View className="border-glass-border bg-canvas flex-row items-end border-t px-4 pt-2 pb-2">
      <TextInput
        className="font-body text-text-primary bg-canvas-subtle mr-3 max-h-28 min-h-[44px] flex-1 rounded-2xl px-4 py-3 text-[15px]"
        placeholder="Message the triager..."
        placeholderTextColor="#6e738d"
        value={text}
        onChangeText={setText}
        onSubmitEditing={handleSend}
        multiline
        returnKeyType="default"
        blurOnSubmit={false}
        editable={!sendMutation.isPending}
      />
      <Pressable
        onPress={handleSend}
        disabled={!text.trim() || sendMutation.isPending}
        accessibilityRole="button"
        accessibilityLabel="Send message"
        className={`mb-0.5 h-11 w-11 items-center justify-center rounded-full ${
          text.trim() ? "bg-accent-blue" : "bg-canvas-elevated"
        }`}
      >
        {sendMutation.isPending ? (
          <ActivityIndicator size="small" color="#24273a" />
        ) : (
          <Send
            size={18}
            strokeWidth={2.2}
            color={text.trim() ? "#24273a" : "#6e738d"}
          />
        )}
      </Pressable>
    </View>
  );
}
