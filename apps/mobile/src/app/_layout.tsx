import "./global.css";
import "react-native-reanimated";

import {
  Sora_400Regular,
  Sora_500Medium,
  Sora_600SemiBold,
  Sora_700Bold,
} from "@expo-google-fonts/sora";
import {
  SourceSans3_400Regular,
  SourceSans3_500Medium,
  SourceSans3_600SemiBold,
  SourceSans3_700Bold,
} from "@expo-google-fonts/source-sans-3";
import { QueryClientProvider } from "@tanstack/react-query";
import { useFonts } from "expo-font";
import { router, Stack, usePathname } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect, useMemo, useState } from "react";

import { ToastProvider } from "@/components/ui/ToastProvider";
import { type AppConfig, getAppConfig } from "@/services/appConfig";
import { AppConfigProvider } from "@/services/AppConfigContext";
import { createORPC } from "@/services/orpc";
import { ORPCProvider } from "@/services/ORPCContext";
import { createQueryClient } from "@/services/queryClient";

SplashScreen.preventAutoHideAsync();

export default function RootLayout(): React.ReactElement | null {
  const pathname = usePathname();
  const [loaded, error] = useFonts({
    Sora_400Regular,
    Sora_500Medium,
    Sora_600SemiBold,
    Sora_700Bold,
    SourceSans3_400Regular,
    SourceSans3_500Medium,
    SourceSans3_600SemiBold,
    SourceSans3_700Bold,
  });

  const [config, setConfig] = useState<AppConfig | null>(null);
  const [configChecked, setConfigChecked] = useState(false);

  // Load config from SecureStore on mount
  useEffect(() => {
    getAppConfig().then(cfg => {
      setConfig(cfg);
      setConfigChecked(true);
    });
  }, []);

  // Hide splash once fonts + config check are both done
  useEffect(() => {
    if ((loaded || error) && configChecked) {
      SplashScreen.hideAsync();
    }
  }, [loaded, error, configChecked]);

  // Keep navigation in sync with config state.
  useEffect(() => {
    if (!configChecked) {
      return;
    }

    if (!config && pathname !== "/setup") {
      router.replace("/setup");
      return;
    }

    if (config && pathname === "/setup") {
      router.replace("/");
    }
  }, [configChecked, config, pathname]);

  // Create query client once (stable across re-renders)
  const queryClient = useMemo(() => createQueryClient(), []);

  // Create oRPC utils when config becomes available
  const orpcUtils = useMemo(() => {
    if (!config) return null;
    return createORPC(config).orpc;
  }, [config]);

  // Wait for fonts + config check before rendering anything
  if (!loaded && !error) return null;
  if (!configChecked) return null;

  return (
    <QueryClientProvider client={queryClient}>
      <AppConfigProvider value={{ config, configChecked, setConfig }}>
        <ToastProvider>
          <ORPCProvider value={orpcUtils}>
            <Stack screenOptions={{ headerShown: false }}>
              <Stack.Screen name="index" />
              <Stack.Screen
                name="capture"
                options={{
                  presentation: "transparentModal",
                  animation: "none",
                  headerShown: false,
                }}
              />
              <Stack.Screen name="triage" />
              <Stack.Screen
                name="setup"
                options={{
                  headerShown: false,
                  gestureEnabled: false,
                }}
              />
            </Stack>
            <StatusBar style="light" />
          </ORPCProvider>
        </ToastProvider>
      </AppConfigProvider>
    </QueryClientProvider>
  );
}
