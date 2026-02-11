import { useCallback, useMemo, useState } from "react";
import {
  FlatList,
  type ListRenderItemInfo,
  Pressable,
  Text,
  TextInput,
  View,
} from "react-native";

interface TagOption {
  readonly id: string;
  readonly label: string;
}

interface TagPickerProps {
  readonly title: string;
  readonly options: readonly TagOption[];
  readonly selected: readonly string[];
  readonly onToggle: (id: string) => void;
  readonly onClose: () => void;
}

/**
 * Dropdown-style multi-select picker for workstreams (#) or containers (@).
 * Renders as a compact list with search filtering and checkmarks.
 */
export function TagPicker({
  title,
  options,
  selected,
  onToggle,
  onClose,
}: TagPickerProps): React.ReactElement {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    if (!query.trim()) return options;
    const q = query.toLowerCase();
    return options.filter(o => o.label.toLowerCase().includes(q));
  }, [options, query]);

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<TagOption>) => {
      const isSelected = selected.includes(item.id);
      return (
        <Pressable
          onPress={() => onToggle(item.id)}
          className="flex-row items-center px-4 py-3"
        >
          <View
            className={`mr-3 h-5 w-5 items-center justify-center rounded ${
              isSelected ? "bg-spark" : "border-text-tertiary border"
            }`}
          >
            {isSelected ? (
              <Text className="text-xs font-bold text-[#24273a]">
                {"\u2713"}
              </Text>
            ) : null}
          </View>
          <Text
            className={`font-body-medium text-sm ${
              isSelected ? "text-text-primary" : "text-text-secondary"
            }`}
          >
            {item.label}
          </Text>
        </Pressable>
      );
    },
    [selected, onToggle],
  );

  const keyExtractor = useCallback((item: TagOption) => item.id, []);

  return (
    <View className="bg-canvas-elevated border-glass-border rounded-2xl border">
      {/* Header */}
      <View className="border-glass-border flex-row items-center justify-between border-b px-4 py-3">
        <Text className="font-display-medium text-text-primary text-sm">
          {title}
        </Text>
        <Pressable onPress={onClose} hitSlop={12}>
          <Text className="font-body-semi text-text-tertiary text-xs">
            Done
          </Text>
        </Pressable>
      </View>

      {/* Search */}
      {options.length > 4 ? (
        <View className="border-glass-border border-b px-4 py-2">
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Filter..."
            placeholderTextColor="#6e738d"
            className="font-body text-text-primary text-sm"
          />
        </View>
      ) : null}

      {/* Options */}
      <FlatList
        data={filtered as TagOption[]}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        className="max-h-[200px]"
      />

      {filtered.length === 0 ? (
        <View className="items-center py-4">
          <Text className="font-body text-text-tertiary text-xs">
            Nothing matches. Try a different search?
          </Text>
        </View>
      ) : null}
    </View>
  );
}
