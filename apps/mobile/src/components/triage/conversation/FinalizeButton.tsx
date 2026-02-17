import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Rocket } from "lucide-react-native";
import { useCallback } from "react";
import { ActivityIndicator, Alert, Pressable, Text, View } from "react-native";

import { useORPC } from "@/services/ORPCContext";
import type { TriageItem } from "@/types/triage";

interface FinalizeButtonProps {
  readonly sparkId: string;
  readonly items: readonly TriageItem[];
  readonly isClosed: boolean;
}

/**
 * Single finalize action that calls `user.triage.apply`.
 *
 * Shows a confirmation warning if there are still-proposed items
 * (they will be auto-rejected on apply).
 */
export function FinalizeButton({
  sparkId,
  items,
  isClosed,
}: FinalizeButtonProps): React.ReactElement {
  const orpc = useORPC();
  const queryClient = useQueryClient();

  const applyMutation = useMutation({
    ...orpc.user.triage.apply.mutationOptions(),
    onSuccess() {
      // Refresh both list and state after apply
      void queryClient.invalidateQueries({
        queryKey: orpc.user.triage.state.queryOptions({ input: { sparkId } })
          .queryKey,
      });
      void queryClient.invalidateQueries({
        queryKey: orpc.user.triage.list.queryOptions({ input: undefined })
          .queryKey,
      });
    },
  });

  const proposedCount = items.filter(i => i.status === "proposed").length;
  const approvedCount = items.filter(i => i.status === "approved").length;

  const handleFinalize = useCallback(() => {
    if (proposedCount > 0) {
      Alert.alert(
        "Finalize triage?",
        `${approvedCount} item${approvedCount !== 1 ? "s" : ""} will be applied. ${proposedCount} proposed item${proposedCount !== 1 ? "s" : ""} will be rejected.`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Finalize",
            style: "destructive",
            onPress: () => applyMutation.mutate({ sparkId }),
          },
        ],
      );
    } else {
      applyMutation.mutate({ sparkId });
    }
  }, [sparkId, proposedCount, approvedCount, applyMutation]);

  if (isClosed) {
    return (
      <View className="bg-accent-green-soft mx-4 items-center rounded-2xl py-3.5">
        <Text className="font-body-semi text-accent-green text-sm">
          Triage complete
        </Text>
      </View>
    );
  }

  return (
    <Pressable
      onPress={handleFinalize}
      disabled={applyMutation.isPending || items.length === 0}
      accessibilityRole="button"
      accessibilityLabel="Finalize triage"
      className={`mx-4 flex-row items-center justify-center rounded-2xl py-3.5 ${
        items.length === 0 ? "bg-canvas-elevated" : "bg-accent-violet"
      }`}
    >
      {applyMutation.isPending ? (
        <ActivityIndicator size="small" color="#24273a" />
      ) : (
        <>
          <Rocket size={16} strokeWidth={2.2} color="#24273a" />
          <Text className="font-body-semi ml-2 text-sm text-[#24273a]">
            Approve the scheme
          </Text>
        </>
      )}
    </Pressable>
  );
}
