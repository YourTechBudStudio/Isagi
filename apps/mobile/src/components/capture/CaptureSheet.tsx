import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { useCallback, useState } from "react";
import {
  Dimensions,
  KeyboardAvoidingView,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";

import { SparkInput } from "./SparkInput";
import { TagBar } from "./TagBar";

const SCREEN_HEIGHT = Dimensions.get("window").height;

/** Minimum sheet height — comfortable for one-liners (~40% of screen). */
const MIN_SHEET_HEIGHT = SCREEN_HEIGHT * 0.4;

/** Maximum sheet height (~90% of screen). */
const MAX_SHEET_HEIGHT = SCREEN_HEIGHT * 0.9;

/**
 * Bottom-sheet capture surface.
 *
 * Starts at ~40% height and grows as text content expands,
 * capping at ~90%. Dark scrim behind dismisses on tap.
 *
 * All Animated.View usage avoids className to prevent NativeWind v5
 * style-override conflicts. Visual styles use inline StyleSheet only
 * on Animated.View; className is used freely on plain View/Text/Pressable.
 */
export function CaptureSheet(): React.ReactElement {
  const [text, setText] = useState("");
  const [selectedWorkstreams, setSelectedWorkstreams] = useState<string[]>([]);
  const [selectedContainers, setSelectedContainers] = useState<string[]>([]);
  const [inputHeight, setInputHeight] = useState(100);

  // Dynamic sheet height: grows with content, clamped between min and max.
  // Account for tag bar (~48), submit row (~56), padding (~80).
  const contentOverhead = 184;
  const desiredHeight = inputHeight + contentOverhead;
  const sheetHeight = Math.min(
    MAX_SHEET_HEIGHT,
    Math.max(MIN_SHEET_HEIGHT, desiredHeight),
  );

  const handleToggleWorkstream = useCallback((id: string) => {
    setSelectedWorkstreams(prev =>
      prev.includes(id) ? prev.filter(w => w !== id) : [...prev, id],
    );
  }, []);

  const handleToggleContainer = useCallback((id: string) => {
    setSelectedContainers(prev =>
      prev.includes(id) ? prev.filter(c => c !== id) : [...prev, id],
    );
  }, []);

  const handleSubmit = useCallback(() => {
    if (!text.trim() && selectedWorkstreams.length === 0) return;

    // Mock: log and close
    console.log("[Spark Captured]", {
      text,
      workstreams: selectedWorkstreams,
      containers: selectedContainers,
    });

    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    router.back();
  }, [text, selectedWorkstreams, selectedContainers]);

  const handleDismiss = useCallback(() => {
    router.back();
  }, []);

  const hasContent = text.trim().length > 0;

  return (
    <View className="flex-1 justify-end">
      {/* Scrim — uses inline styles on Animated.View to avoid NativeWind conflicts */}
      <Animated.View
        entering={FadeIn.duration(180)}
        exiting={FadeOut.duration(120)}
        style={styles.scrim}
      >
        <Pressable onPress={handleDismiss} style={styles.scrimPressable} />
      </Animated.View>

      {/* Sheet — padding behavior pushes content above keyboard on both platforms */}
      <KeyboardAvoidingView behavior="padding">
        <View style={[styles.sheet, { height: sheetHeight }]}>
          {/* Drag handle */}
          <View className="items-center pt-3 pb-1">
            <View className="bg-text-tertiary h-1 w-10 rounded-full opacity-50" />
          </View>

          {/* Content */}
          <View className="flex-1 px-5 pt-2 pb-3">
            {/* Tag bar */}
            <TagBar
              selectedWorkstreams={selectedWorkstreams}
              selectedContainers={selectedContainers}
              onToggleWorkstream={handleToggleWorkstream}
              onToggleContainer={handleToggleContainer}
            />

            {/* Text input */}
            <SparkInput
              value={text}
              onChangeText={setText}
              onContentSizeChange={setInputHeight}
            />

            {/* Submit row */}
            <View className="flex-row items-center justify-end pt-3">
              <Pressable
                onPress={handleSubmit}
                disabled={!hasContent}
                className={`flex-row items-center rounded-full border px-5 py-2.5 ${
                  hasContent
                    ? "bg-accent-blue-soft border-accent-blue/20"
                    : "bg-glass border-glass-border"
                }`}
              >
                <Text className="mr-1.5 text-sm">{"\u26A1"}</Text>
                <Text
                  className={`font-body-semi text-sm ${
                    hasContent ? "text-accent-blue" : "text-text-tertiary"
                  }`}
                >
                  Capture
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  scrim: {
    ...StyleSheet.absoluteFillObject,
  },
  scrimPressable: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.6)",
  },
  sheet: {
    backgroundColor: "#363a4f",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    overflow: "hidden",
  },
});
