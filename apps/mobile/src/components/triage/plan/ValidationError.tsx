import { AlertTriangle } from "lucide-react-native";
import { Pressable, Text, View } from "react-native";

interface ValidationErrorProps {
  readonly error: string;
  readonly onRefresh?: () => void;
}

/**
 * Non-blocking error banner for triage YAML validation failures.
 * Keeps the chat usable while surfacing the issue.
 */
export function ValidationError({
  error,
  onRefresh,
}: ValidationErrorProps): React.ReactElement {
  return (
    <View className="bg-accent-red-soft border-glass-border mx-4 mb-3 rounded-xl border p-4">
      <View className="mb-2 flex-row items-center">
        <AlertTriangle size={14} strokeWidth={2.2} color="#ed8796" />
        <Text className="font-display-medium text-accent-red ml-2 text-xs tracking-wider uppercase">
          Schema issue
        </Text>
      </View>
      <Text
        className="font-body text-text-secondary text-xs leading-4"
        numberOfLines={3}
      >
        {error}
      </Text>
      <Text className="font-body text-text-tertiary mt-1.5 text-[10px]">
        The agent is attempting an automated fix.
      </Text>
      {onRefresh && (
        <Pressable
          onPress={onRefresh}
          accessibilityRole="button"
          accessibilityLabel="Refresh triage state"
          className="mt-2.5 self-start"
        >
          <Text className="font-body-semi text-accent-red text-xs">
            Refresh
          </Text>
        </Pressable>
      )}
    </View>
  );
}
