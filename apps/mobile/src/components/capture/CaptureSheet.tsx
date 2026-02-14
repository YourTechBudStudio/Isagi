import { useMutation } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { Send } from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Dimensions,
  Keyboard,
  type KeyboardEvent,
  Platform,
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useToast } from "@/components/ui/ToastProvider";
import { useORPC } from "@/services/ORPCContext";

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
  const insets = useSafeAreaInsets();
  const orpc = useORPC();
  const toast = useToast();
  const [text, setText] = useState("");
  const [selectedWorkstreams, setSelectedWorkstreams] = useState<string[]>([]);
  const [selectedContainers, setSelectedContainers] = useState<string[]>([]);
  const [inputHeight, setInputHeight] = useState(100);
  const keyboardOffset = useSharedValue(0);

  // TODO: Bind selectedWorkstreams and selectedContainers to the API once the
  //       backend supports tags in the capture contract.
  const captureMutation = useMutation(
    orpc.user.sparks.capture.mutationOptions({
      onSuccess: () => {
        toast.success("Spark captured.");
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        router.back();
      },
      onError: () => {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        Alert.alert(
          "Capture failed",
          "Couldn't save your spark. Check your connection and try again.",
        );
      },
    }),
  );

  // Dynamic sheet height: grows with content, clamped between min and max.
  // Account for tag bar (~48), submit row (~56), padding (~80).
  const contentOverhead = 184;
  const desiredHeight = inputHeight + contentOverhead;
  const baseSheetHeight = Math.min(
    MAX_SHEET_HEIGHT,
    Math.max(MIN_SHEET_HEIGHT, desiredHeight),
  );
  const sheetHeight = baseSheetHeight + insets.bottom;

  useEffect(() => {
    const showEvent =
      Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent =
      Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";

    const handleShow = (event: KeyboardEvent): void => {
      const keyboardHeight =
        Platform.OS === "android"
          ? event.endCoordinates.height
          : Math.max(0, event.endCoordinates.height - insets.bottom);
      const duration = event.duration ?? 220;
      keyboardOffset.value = withTiming(keyboardHeight, {
        duration,
        easing: Easing.out(Easing.cubic),
      });
    };

    const handleHide = (event?: KeyboardEvent): void => {
      const duration = event?.duration ?? 200;
      keyboardOffset.value = withTiming(0, {
        duration,
        easing: Easing.out(Easing.cubic),
      });
    };

    const showSubscription = Keyboard.addListener(showEvent, handleShow);
    const hideSubscription = Keyboard.addListener(hideEvent, handleHide);

    return () => {
      showSubscription.remove();
      hideSubscription.remove();
    };
  }, [insets.bottom, keyboardOffset]);

  const sheetLiftStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: -keyboardOffset.value }],
  }));

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
    const trimmed = text.trim();
    if (!trimmed) return;

    captureMutation.mutate({ text: trimmed });
  }, [text, captureMutation]);

  const handleDismiss = useCallback(() => {
    if (text.trim().length > 0) {
      Keyboard.dismiss();
      Alert.alert(
        "Discard spark?",
        "You have unsaved changes that will be lost.",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Discard",
            style: "destructive",
            onPress: () => {
              router.back();
            },
          },
        ],
      );
      return;
    }

    router.back();
  }, [text]);

  const hasContent = text.trim().length > 0;
  const isSubmitting = captureMutation.isPending;

  return (
    <View style={styles.root}>
      {/* Scrim — uses inline styles on Animated.View to avoid NativeWind conflicts */}
      <Animated.View
        entering={FadeIn.duration(180)}
        exiting={FadeOut.duration(120)}
        style={styles.scrim}
      >
        <Pressable onPress={handleDismiss} style={styles.scrimPressable} />
      </Animated.View>

      <Animated.View style={sheetLiftStyle}>
        <View
          style={[
            styles.sheet,
            { height: sheetHeight, paddingBottom: insets.bottom },
          ]}
        >
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
            <View className="mt-auto flex-row items-center justify-end pt-3">
              <Pressable
                onPress={handleSubmit}
                disabled={!hasContent || isSubmitting}
                accessibilityRole="button"
                accessibilityLabel="Submit spark"
                className={`h-11 w-11 items-center justify-center rounded-full border ${
                  hasContent && !isSubmitting
                    ? "bg-accent-blue-soft border-accent-blue/20"
                    : "bg-glass border-glass-border"
                }`}
              >
                <Send
                  size={18}
                  strokeWidth={2.25}
                  color={hasContent && !isSubmitting ? "#8aadf4" : "#6e738d"}
                />
              </Pressable>
            </View>
          </View>
        </View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  scrim: {
    ...StyleSheet.absoluteFillObject,
  },
  root: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "flex-end",
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
