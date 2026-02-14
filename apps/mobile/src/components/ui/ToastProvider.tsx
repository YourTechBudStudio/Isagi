import type { PropsWithChildren } from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { StyleSheet, Text, View } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

type ToastTone = "success" | "error" | "info";

interface ToastState {
  readonly id: number;
  readonly title: string;
  readonly tone: ToastTone;
  readonly durationMs: number;
}

interface ToastOptions {
  readonly tone?: ToastTone;
  readonly durationMs?: number;
}

interface ToastContextValue {
  readonly show: (title: string, options?: ToastOptions) => void;
  readonly success: (
    title: string,
    options?: Omit<ToastOptions, "tone">,
  ) => void;
  readonly error: (title: string, options?: Omit<ToastOptions, "tone">) => void;
  readonly info: (title: string, options?: Omit<ToastOptions, "tone">) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const TONE_BG: Record<ToastTone, string> = {
  success: "bg-canvas-elevated",
  error: "bg-canvas-elevated",
  info: "bg-canvas-elevated",
};

const TONE_BORDER: Record<ToastTone, string> = {
  success: "border-l-accent-green",
  error: "border-l-accent-red",
  info: "border-l-accent-blue",
};

const TONE_TEXT: Record<ToastTone, string> = {
  success: "text-accent-green",
  error: "text-accent-red",
  info: "text-accent-blue",
};

const TONE_LABEL: Record<ToastTone, string> = {
  success: "Mission accomplished",
  error: "Uh oh",
  info: "Intel",
};

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used inside ToastProvider");
  }
  return ctx;
}

export function ToastProvider({
  children,
}: PropsWithChildren): React.ReactElement {
  const [toast, setToast] = useState<ToastState | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idRef = useRef(0);

  const clearTimer = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const show = useCallback(
    (title: string, options?: ToastOptions) => {
      const tone = options?.tone ?? "info";
      const durationMs = options?.durationMs ?? 2000;

      idRef.current += 1;
      clearTimer();
      setToast({ id: idRef.current, title, tone, durationMs });

      timeoutRef.current = setTimeout(() => {
        setToast(null);
        timeoutRef.current = null;
      }, durationMs);
    },
    [clearTimer],
  );

  const success = useCallback(
    (title: string, options?: Omit<ToastOptions, "tone">) =>
      show(title, { ...options, tone: "success" }),
    [show],
  );

  const error = useCallback(
    (title: string, options?: Omit<ToastOptions, "tone">) =>
      show(title, { ...options, tone: "error" }),
    [show],
  );

  const info = useCallback(
    (title: string, options?: Omit<ToastOptions, "tone">) =>
      show(title, { ...options, tone: "info" }),
    [show],
  );

  useEffect(() => clearTimer, [clearTimer]);

  return (
    <ToastContext.Provider value={{ show, success, error, info }}>
      {children}
      <ToastHost toast={toast} />
    </ToastContext.Provider>
  );
}

function ToastHost({
  toast,
}: {
  toast: ToastState | null;
}): React.ReactElement | null {
  const insets = useSafeAreaInsets();

  if (!toast) {
    return null;
  }

  return (
    <View pointerEvents="box-none" style={styles.root}>
      <Animated.View
        key={toast.id}
        entering={FadeIn.duration(200)}
        exiting={FadeOut.duration(150)}
        style={[styles.toastWrap, { bottom: insets.bottom + 20 }]}
      >
        <View
          className={`${TONE_BG[toast.tone]} ${TONE_BORDER[toast.tone]} border-glass-border rounded-2xl border border-l-2 px-4 py-3`}
        >
          <Text
            className={`font-body-semi ${TONE_TEXT[toast.tone]} text-xs tracking-widest uppercase`}
          >
            {TONE_LABEL[toast.tone]}
          </Text>
          <Text className="font-body text-text-primary mt-1 text-sm leading-5">
            {toast.title}
          </Text>
        </View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 9999,
    elevation: 9999,
    alignItems: "center",
    justifyContent: "flex-end",
  },
  toastWrap: {
    position: "absolute",
    left: 16,
    right: 16,
  },
});
