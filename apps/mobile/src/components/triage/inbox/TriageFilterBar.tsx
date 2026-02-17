import { memo, useCallback } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";

import type { TriageFilter } from "@/types/triage";

interface TriageFilterBarProps {
  readonly active: TriageFilter;
  readonly onChange: (filter: TriageFilter) => void;
  readonly counts: Record<TriageFilter, number>;
}

const FILTERS: { key: TriageFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "waiting", label: "Waiting" },
  { key: "in_progress", label: "In Progress" },
  { key: "idle", label: "Idle" },
  { key: "closed", label: "Closed" },
  { key: "error", label: "Errors" },
];

function FilterChip({
  filter,
  count,
  isActive,
  onPress,
}: {
  filter: TriageFilter;
  count: number;
  isActive: boolean;
  onPress: (f: TriageFilter) => void;
}): React.ReactElement {
  const handlePress = useCallback(() => onPress(filter), [filter, onPress]);

  return (
    <Pressable
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityState={{ selected: isActive }}
      accessibilityLabel={`Filter by ${filter}`}
      className={`mr-2 flex-row items-center rounded-full px-3.5 py-2 ${
        isActive ? "bg-accent-violet" : "bg-canvas-elevated"
      }`}
    >
      <Text
        className={`font-body-semi text-xs ${
          isActive ? "text-[#24273a]" : "text-text-secondary"
        }`}
      >
        {FILTERS.find(f => f.key === filter)?.label}
      </Text>
      {count > 0 && (
        <View
          className={`ml-1.5 min-w-[18px] items-center rounded-full px-1 py-0.5 ${
            isActive ? "bg-[rgba(36,39,58,0.2)]" : "bg-canvas-subtle"
          }`}
        >
          <Text
            className={`font-body-semi text-[10px] ${
              isActive ? "text-[#24273a]" : "text-text-tertiary"
            }`}
          >
            {count}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

/**
 * Horizontal scrolling filter bar for the triage inbox.
 */
function TriageFilterBarInner({
  active,
  onChange,
  counts,
}: TriageFilterBarProps): React.ReactElement {
  return (
    <View className="mb-4">
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View className="flex-row px-5">
          {FILTERS.map(f => (
            <FilterChip
              key={f.key}
              filter={f.key}
              count={counts[f.key]}
              isActive={active === f.key}
              onPress={onChange}
            />
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

export const TriageFilterBar = memo(TriageFilterBarInner);
