import * as Haptics from "expo-haptics";
import { Server, ShieldCheck } from "lucide-react-native";
import { useCallback, useState } from "react";
import {
  Alert,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { NebulaBackground } from "@/components/ui/NebulaBackground";
import { useToast } from "@/components/ui/ToastProvider";
import { normalizeApiUrl, setAppConfig } from "@/services/appConfig";
import { useAppConfig } from "@/services/AppConfigContext";
import { createORPC } from "@/services/orpc";

const URL_HINTS: readonly { label: string; value: string }[] = [
  { label: "iOS simulator", value: "http://localhost:13000" },
  { label: "Android emulator", value: "http://10.0.2.2:13000" },
  { label: "Physical device", value: "http://192.168.1.42:13000" },
];

async function pingServer(params: {
  apiUrl: string;
  userApiKey: string;
}): Promise<void> {
  const { client } = createORPC(params);
  await client.user.health.ping();
}

/**
 * First-launch setup screen.
 *
 * Collects API URL + API key, persists them once, and updates in-memory config
 * so the rest of the app can immediately use oRPC without a restart.
 */
export default function SetupScreen(): React.ReactElement {
  const { setConfig } = useAppConfig();
  const toast = useToast();

  const [apiUrl, setApiUrl] = useState("");
  const [userApiKey, setUserApiKey] = useState("dev-isagi");
  const [saving, setSaving] = useState(false);

  const handleSave = useCallback(async () => {
    const trimmedUrl = apiUrl.trim();
    const trimmedKey = userApiKey.trim();

    if (!trimmedUrl) {
      Alert.alert("Missing URL", "Add your API URL first.");
      return;
    }

    if (!trimmedKey) {
      Alert.alert("Missing API key", "Add your API key first.");
      return;
    }

    Keyboard.dismiss();
    setSaving(true);

    try {
      const normalizedUrl = normalizeApiUrl(trimmedUrl);
      await pingServer({ apiUrl: normalizedUrl, userApiKey: trimmedKey });

      const savedConfig = await setAppConfig({
        apiUrl: normalizedUrl,
        userApiKey: trimmedKey,
      });

      setConfig(savedConfig);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      toast.success("Connection verified. Your ideas have nowhere to hide.");
    } catch {
      setSaving(false);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      toast.error("Can't reach the mothership. Double-check URL and key.");
    }
  }, [apiUrl, setConfig, toast, userApiKey]);

  const canSave = apiUrl.trim().length > 0 && userApiKey.trim().length > 0;

  return (
    <NebulaBackground>
      <SafeAreaView className="flex-1" edges={["top", "bottom"]}>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentInsetAdjustmentBehavior="automatic"
        >
          <View className="px-6 pt-8 pb-10">
            <View className="mb-8 px-1">
              <Text className="font-display text-text-primary text-3xl tracking-tight">
                First things first.
              </Text>
              <Text className="font-body text-text-secondary mt-2 text-base leading-6">
                Point me at your Isagi server so I can start scheming.
              </Text>
            </View>

            <View className="bg-accent-blue-soft border-glass-border rounded-2xl border p-5">
              <View className="mb-5">
                <View className="mb-2.5 flex-row items-center">
                  <Server size={14} strokeWidth={2} color="#8aadf4" />
                  <Text className="font-display-semi text-text-secondary ml-2 text-xs tracking-widest uppercase">
                    Server URL
                  </Text>
                </View>

                <TextInput
                  className="font-body-medium bg-canvas border-glass-border text-text-primary rounded-xl border px-4 py-3.5 text-base"
                  value={apiUrl}
                  onChangeText={setApiUrl}
                  placeholder={
                    Platform.OS === "android"
                      ? "http://10.0.2.2:13000"
                      : "http://localhost:13000"
                  }
                  placeholderTextColor="#6e738d"
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="off"
                  textContentType="URL"
                  keyboardType="url"
                  returnKeyType="next"
                  editable={!saving}
                />

                <View className="mt-2.5 flex-row flex-wrap">
                  {URL_HINTS.map(hint => (
                    <Pressable
                      key={hint.label}
                      onPress={() => setApiUrl(hint.value)}
                      disabled={saving}
                      className="bg-canvas-subtle border-glass-border mr-2 mb-2 rounded-lg border px-3 py-1.5"
                    >
                      <Text className="font-body text-text-tertiary text-xs">
                        {hint.label}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </View>

              <View>
                <View className="mb-2.5 flex-row items-center">
                  <ShieldCheck size={14} strokeWidth={2} color="#a6da95" />
                  <Text className="font-display-semi text-text-secondary ml-2 text-xs tracking-widest uppercase">
                    API Key
                  </Text>
                </View>

                <TextInput
                  className="font-body-medium bg-canvas border-glass-border text-text-primary rounded-xl border px-4 py-3.5 text-base"
                  value={userApiKey}
                  onChangeText={setUserApiKey}
                  placeholder="dev-isagi"
                  placeholderTextColor="#6e738d"
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="off"
                  textContentType="none"
                  returnKeyType="done"
                  onSubmitEditing={handleSave}
                  editable={!saving}
                />

                <Text className="font-body text-text-tertiary mt-2 text-xs leading-5">
                  You only set this once. URL is auto-normalized to include
                  <Text className="font-body-semi text-text-secondary">
                    {" "}
                    /api
                  </Text>
                  .
                </Text>
              </View>
            </View>

            <Pressable
              onPress={handleSave}
              disabled={!canSave || saving}
              accessibilityRole="button"
              accessibilityLabel="Save configuration"
              className={`mt-5 items-center rounded-xl py-4 ${
                canSave && !saving
                  ? "bg-accent-blue"
                  : "bg-accent-blue opacity-40"
              }`}
            >
              <Text
                className={`font-display-semi text-sm ${
                  canSave && !saving ? "text-canvas" : "text-canvas opacity-60"
                }`}
              >
                {saving ? "Checking..." : "Lock it in"}
              </Text>
            </Pressable>

            <View className="mt-4 items-center">
              <Text className="font-body text-text-tertiary text-xs">
                One-time setup. I remember everything.
              </Text>
            </View>
          </View>
        </ScrollView>
      </SafeAreaView>
    </NebulaBackground>
  );
}
