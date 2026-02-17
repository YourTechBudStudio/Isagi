import { useQueryClient } from "@tanstack/react-query";
import { FileText } from "lucide-react-native";
import { useCallback } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";

import { useTriageState } from "@/hooks/useTriageState";
import { useORPC } from "@/services/ORPCContext";
import type { TriageItem } from "@/types/triage";

import { PlanItemCard } from "../plan/PlanItemCard";
import { ValidationError } from "../plan/ValidationError";
import { FinalizeButton } from "./FinalizeButton";

interface PlanTabProps {
  readonly sparkId: string;
  readonly isClosed: boolean;
}

/**
 * Plan/review tab — shows triage YAML items and the finalize action.
 *
 * Fetches triage state via React Query and refreshes when the SSE
 * stream signals session idle (handled by the parent hook).
 */
export function PlanTab({
  sparkId,
  isClosed,
}: PlanTabProps): React.ReactElement {
  const orpc = useORPC();
  const queryClient = useQueryClient();
  const { data, isLoading, isError } = useTriageState(sparkId);

  const handleRefresh = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: orpc.user.triage.state.queryOptions({ input: { sparkId } })
        .queryKey,
    });
  }, [queryClient, orpc, sparkId]);

  if (isLoading) {
    return (
      <View className="flex-1 items-center justify-center">
        <ActivityIndicator size="large" color="#c6a0f6" />
        <Text className="font-body text-text-tertiary mt-3 text-sm">
          Assimilating context...
        </Text>
      </View>
    );
  }

  if (isError || !data) {
    return (
      <View className="flex-1 items-center justify-center px-8">
        <Text className="font-body text-text-tertiary text-center text-sm">
          Could not load the plan. Tap to retry.
        </Text>
      </View>
    );
  }

  const items: readonly TriageItem[] = data.parsed?.items ?? [];

  // Group items by status for visual clarity
  const proposed = items.filter(i => i.status === "proposed");
  const approved = items.filter(i => i.status === "approved");
  const applied = items.filter(i => i.status === "applied");
  const rejected = items.filter(i => i.status === "rejected");

  return (
    <View className="flex-1">
      <ScrollView>
        <View className="px-4 pt-4 pb-8">
          {/* Validation error banner */}
          {data.validationError && (
            <ValidationError
              error={data.validationError}
              onRefresh={handleRefresh}
            />
          )}

          {/* Empty state */}
          {items.length === 0 && (
            <View className="items-center py-12">
              <FileText size={32} strokeWidth={1.5} color="#6e738d" />
              <Text className="font-display-medium text-text-tertiary mt-4 text-center text-sm">
                No items yet
              </Text>
              <Text className="font-body text-text-tertiary mt-1 text-center text-xs">
                The triager will propose items as the conversation develops.
              </Text>
            </View>
          )}

          {/* Approved items */}
          {approved.length > 0 && (
            <SectionHeader label="Approved" count={approved.length} />
          )}
          {approved.map(item => (
            <PlanItemCard key={item.id} item={item} />
          ))}

          {/* Proposed items */}
          {proposed.length > 0 && (
            <SectionHeader label="Proposed" count={proposed.length} />
          )}
          {proposed.map(item => (
            <PlanItemCard key={item.id} item={item} />
          ))}

          {/* Applied items */}
          {applied.length > 0 && (
            <SectionHeader label="Applied" count={applied.length} />
          )}
          {applied.map(item => (
            <PlanItemCard key={item.id} item={item} />
          ))}

          {/* Rejected items */}
          {rejected.length > 0 && (
            <SectionHeader label="Rejected" count={rejected.length} />
          )}
          {rejected.map(item => (
            <PlanItemCard key={item.id} item={item} />
          ))}
        </View>
      </ScrollView>

      {/* Finalize button pinned at bottom */}
      <View className="border-glass-border bg-canvas border-t pt-3 pb-6">
        <FinalizeButton
          sparkId={sparkId}
          items={items as TriageItem[]}
          isClosed={isClosed}
        />
      </View>
    </View>
  );
}

function SectionHeader({
  label,
  count,
}: {
  label: string;
  count: number;
}): React.ReactElement {
  return (
    <View className="mt-4 mb-2 flex-row items-center">
      <Text className="font-display-semi text-text-tertiary text-xs tracking-widest uppercase">
        {label}
      </Text>
      <View className="bg-canvas-elevated ml-2 rounded-full px-2 py-0.5">
        <Text className="font-body-semi text-text-tertiary text-[10px]">
          {count}
        </Text>
      </View>
    </View>
  );
}
