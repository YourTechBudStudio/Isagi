import { router, useLocalSearchParams } from "expo-router";
import { ArrowLeft } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import PagerView from "react-native-pager-view";
import { SafeAreaView } from "react-native-safe-area-context";

import { ChatComposer } from "@/components/triage/conversation/ChatComposer";
import { ChatTab } from "@/components/triage/conversation/ChatTab";
import { PlanTab } from "@/components/triage/conversation/PlanTab";
import { SessionStatusBar } from "@/components/triage/conversation/SessionStatusBar";
import { useTriageList } from "@/hooks/useTriageList";
import { useTriageMessages } from "@/hooks/useTriageMessages";
import { useTriageSSE } from "@/hooks/useTriageSSE";
import { useTriageMessagesActions } from "@/store/triage-messages.selectors";
import type { MessageInfo, MessagePart } from "@/types/triage";

const TAB_CHAT = 0;
const TAB_REVIEW = 1;

export default function TriageConversationScreen(): React.ReactElement {
  const params = useLocalSearchParams<{ sparkId?: string }>();
  const sparkId = params.sparkId ?? "";
  const [activeTab, setActiveTab] = useState<number>(TAB_CHAT);
  const pagerRef = useRef<PagerView>(null);
  const lastHydratedAtRef = useRef(0);
  const actions = useTriageMessagesActions();

  const {
    data: messagesData,
    dataUpdatedAt: messagesUpdatedAt,
    isLoading: messagesLoading,
  } = useTriageMessages(sparkId);

  const { data: triageList } = useTriageList();
  const triageItem = useMemo(
    () => triageList?.find(t => t.sparkId === sparkId),
    [triageList, sparkId],
  );
  const isClosed =
    triageItem?.closedAt !== null && triageItem?.closedAt !== undefined;

  useEffect(() => {
    if (!messagesData) {
      return;
    }

    if (messagesUpdatedAt === lastHydratedAtRef.current) {
      return;
    }

    actions.hydrate(
      messagesData as readonly {
        info: MessageInfo;
        parts: MessagePart[];
      }[],
    );
    lastHydratedAtRef.current = messagesUpdatedAt;
  }, [messagesData, messagesUpdatedAt, actions]);

  useTriageSSE(sparkId);

  useEffect(() => {
    return () => {
      actions.clear();
      lastHydratedAtRef.current = 0;
    };
  }, [actions]);

  const selectChat = useCallback(() => {
    setActiveTab(TAB_CHAT);
    pagerRef.current?.setPage(TAB_CHAT);
  }, []);

  const selectReview = useCallback(() => {
    setActiveTab(TAB_REVIEW);
    pagerRef.current?.setPage(TAB_REVIEW);
  }, []);

  const handlePageSelected = useCallback(
    (event: { nativeEvent: { position: number } }) => {
      setActiveTab(event.nativeEvent.position);
    },
    [],
  );

  return (
    <SafeAreaView
      edges={["top", "bottom"]}
      style={{ flex: 1, backgroundColor: "#24273a" }}
    >
      <View className="bg-canvas flex-row items-center px-5 pt-3 pb-2">
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Go back"
          className="mr-3 h-10 w-10 items-center justify-center rounded-full"
        >
          <ArrowLeft size={20} strokeWidth={2} color="#cad3f5" />
        </Pressable>
        <Text className="font-display-medium text-text-primary text-base">
          {triageItem?.sparkTitle ?? "Triage"}
        </Text>
      </View>

      <SessionStatusBar />

      <View className="border-glass-border border-b">
        <View className="flex-row">
          <Pressable
            onPress={selectChat}
            accessibilityRole="tab"
            accessibilityState={{ selected: activeTab === TAB_CHAT }}
            className={`flex-1 items-center justify-center border-b-2 py-3 ${
              activeTab === TAB_CHAT
                ? "border-accent-violet"
                : "border-transparent"
            }`}
          >
            <Text
              className={`font-display-medium text-sm ${
                activeTab === TAB_CHAT
                  ? "text-text-primary"
                  : "text-text-tertiary"
              }`}
            >
              Chat
            </Text>
          </Pressable>
          <Pressable
            onPress={selectReview}
            accessibilityRole="tab"
            accessibilityState={{ selected: activeTab === TAB_REVIEW }}
            className={`flex-1 items-center justify-center border-b-2 py-3 ${
              activeTab === TAB_REVIEW
                ? "border-accent-violet"
                : "border-transparent"
            }`}
          >
            <Text
              className={`font-display-medium text-sm ${
                activeTab === TAB_REVIEW
                  ? "text-text-primary"
                  : "text-text-tertiary"
              }`}
            >
              Review
            </Text>
          </Pressable>
        </View>
      </View>

      <PagerView
        ref={pagerRef}
        style={{ flex: 1 }}
        initialPage={TAB_CHAT}
        onPageSelected={handlePageSelected}
      >
        <View key="chat" style={{ flex: 1 }}>
          <View className="flex-1">
            <ChatTab isLoading={messagesLoading} />
          </View>
          <ChatComposer sparkId={sparkId} />
        </View>
        <View key="review" style={{ flex: 1 }}>
          <PlanTab sparkId={sparkId} isClosed={isClosed} />
        </View>
      </PagerView>
    </SafeAreaView>
  );
}
