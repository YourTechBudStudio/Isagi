import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";

import {
  type Container,
  MOCK_CONTAINERS,
  MOCK_WORKSTREAMS,
  type Workstream,
} from "@/constants/mock-data";

import { TagPicker } from "./TagPicker";

type PickerMode = "workstream" | "container" | null;

interface TagBarProps {
  readonly selectedWorkstreams: readonly string[];
  readonly selectedContainers: readonly string[];
  readonly onToggleWorkstream: (id: string) => void;
  readonly onToggleContainer: (id: string) => void;
}

/**
 * Horizontal chip bar for selecting workstreams (#) and containers (@).
 * Tapping a chip opens its TagPicker inline below.
 */
export function TagBar({
  selectedWorkstreams,
  selectedContainers,
  onToggleWorkstream,
  onToggleContainer,
}: TagBarProps): React.ReactElement {
  const [openPicker, setOpenPicker] = useState<PickerMode>(null);

  const togglePicker = useCallback((mode: PickerMode) => {
    setOpenPicker(prev => (prev === mode ? null : mode));
  }, []);

  // Filter containers: scoped to selected workstreams when any are chosen
  const visibleContainers = useMemo(() => {
    if (selectedWorkstreams.length === 0) return MOCK_CONTAINERS;
    return MOCK_CONTAINERS.filter(
      (c: Container) =>
        c.workstreamId === null || selectedWorkstreams.includes(c.workstreamId),
    );
  }, [selectedWorkstreams]);

  const workstreamLabel = useMemo(() => {
    if (selectedWorkstreams.length === 0) return "Workstream";
    if (selectedWorkstreams.length === 1) {
      const ws = MOCK_WORKSTREAMS.find(
        (w: Workstream) => w.id === selectedWorkstreams[0],
      );
      return ws?.label ?? "Workstream";
    }
    return `${String(selectedWorkstreams.length)} workstreams`;
  }, [selectedWorkstreams]);

  const containerLabel = useMemo(() => {
    if (selectedContainers.length === 0) return "Container";
    if (selectedContainers.length === 1) {
      const ct = MOCK_CONTAINERS.find(
        (c: Container) => c.id === selectedContainers[0],
      );
      return ct?.label ?? "Container";
    }
    return `${String(selectedContainers.length)} containers`;
  }, [selectedContainers]);

  return (
    <View className="mb-3">
      {/* Chip row */}
      <View className="flex-row gap-2">
        {/* Workstream chip */}
        <Pressable
          onPress={() => togglePicker("workstream")}
          className={`flex-row items-center rounded-full px-3 py-1.5 ${
            selectedWorkstreams.length > 0
              ? "bg-accent-blue-soft"
              : "bg-glass border-glass-border border"
          }`}
        >
          <Text
            className={`mr-1 text-xs ${
              selectedWorkstreams.length > 0
                ? "text-accent-blue"
                : "text-text-tertiary"
            }`}
          >
            #
          </Text>
          <Text
            className={`font-body-medium text-xs ${
              selectedWorkstreams.length > 0
                ? "text-accent-blue"
                : "text-text-secondary"
            }`}
          >
            {workstreamLabel}
          </Text>
        </Pressable>

        {/* Container chip */}
        <Pressable
          onPress={() => togglePicker("container")}
          className={`flex-row items-center rounded-full px-3 py-1.5 ${
            selectedContainers.length > 0
              ? "bg-accent-violet-soft"
              : "bg-glass border-glass-border border"
          }`}
        >
          <Text
            className={`mr-1 text-xs ${
              selectedContainers.length > 0
                ? "text-accent-violet"
                : "text-text-tertiary"
            }`}
          >
            @
          </Text>
          <Text
            className={`font-body-medium text-xs ${
              selectedContainers.length > 0
                ? "text-accent-violet"
                : "text-text-secondary"
            }`}
          >
            {containerLabel}
          </Text>
        </Pressable>
      </View>

      {/* Inline picker */}
      {openPicker === "workstream" ? (
        <View className="mt-2">
          <TagPicker
            title="Select workstreams"
            options={MOCK_WORKSTREAMS}
            selected={selectedWorkstreams}
            onToggle={onToggleWorkstream}
            onClose={() => setOpenPicker(null)}
          />
        </View>
      ) : null}

      {openPicker === "container" ? (
        <View className="mt-2">
          <TagPicker
            title="Select containers"
            options={visibleContainers}
            selected={selectedContainers}
            onToggle={onToggleContainer}
            onClose={() => setOpenPicker(null)}
          />
        </View>
      ) : null}
    </View>
  );
}
