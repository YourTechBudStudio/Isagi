import { Stack } from "expo-router";

/**
 * Triage sub-navigator. Provides a stack for:
 * - Inbox list (index)
 * - Conversation detail ([sparkId])
 */
export default function TriageLayout(): React.ReactElement {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: "#24273a" },
      }}
    >
      <Stack.Screen name="index" />
      <Stack.Screen name="[sparkId]" />
    </Stack>
  );
}
