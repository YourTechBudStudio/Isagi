import { Loader2, Pause, RotateCw } from "lucide-react-native";
import { Text, View } from "react-native";

import { useSessionStatus } from "@/store/triage-messages.selectors";

/**
 * Compact status bar showing the session's current state.
 * Renders at the top of the conversation screen.
 */
export function SessionStatusBar(): React.ReactElement | null {
  const status = useSessionStatus();

  if (!status) return null;

  switch (status.type) {
    case "busy":
      return (
        <View className="bg-accent-amber-soft flex-row items-center justify-center px-4 py-2">
          <Loader2 size={12} strokeWidth={2.5} color="#f5a97f" />
          <Text className="font-body-semi text-accent-amber ml-2 text-xs">
            Plotting...
          </Text>
        </View>
      );

    case "retry":
      return (
        <View className="bg-accent-red-soft flex-row items-center justify-center px-4 py-2">
          <RotateCw size={12} strokeWidth={2.5} color="#ed8796" />
          <Text className="font-body-semi text-accent-red ml-2 text-xs">
            Retrying (attempt {status.attempt})...
          </Text>
        </View>
      );

    case "idle":
      return (
        <View className="bg-accent-green-soft flex-row items-center justify-center px-4 py-2">
          <Pause size={12} strokeWidth={2.5} color="#a6da95" />
          <Text className="font-body-semi text-accent-green ml-2 text-xs">
            Waiting on you
          </Text>
        </View>
      );

    default:
      return null;
  }
}
