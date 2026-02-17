import Markdown from "@ronradtke/react-native-markdown-display";
import {
  Brain,
  CheckCircle2,
  Loader2,
  Terminal,
  XCircle,
} from "lucide-react-native";
import { memo } from "react";
import { Text, View } from "react-native";

import type { MessagePart as MessagePartType } from "@/types/triage";

interface MessagePartProps {
  readonly part: MessagePartType;
}

// ── Markdown styles (Catppuccin Macchiato) ──

const mdStyles = {
  body: {
    color: "#cad3f5",
    fontFamily: "SourceSans3_400Regular",
    fontSize: 15,
    lineHeight: 22,
  },
  heading1: {
    color: "#cad3f5",
    fontFamily: "Sora_600SemiBold",
    fontSize: 20,
    marginTop: 16,
    marginBottom: 8,
  },
  heading2: {
    color: "#cad3f5",
    fontFamily: "Sora_600SemiBold",
    fontSize: 17,
    marginTop: 14,
    marginBottom: 6,
  },
  heading3: {
    color: "#cad3f5",
    fontFamily: "Sora_500Medium",
    fontSize: 15,
    marginTop: 12,
    marginBottom: 4,
  },
  code_inline: {
    backgroundColor: "rgba(138, 173, 244, 0.12)",
    color: "#8aadf4",
    fontFamily: "monospace",
    fontSize: 13,
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 4,
  },
  fence: {
    backgroundColor: "#2e3244",
    borderColor: "rgba(255, 255, 255, 0.06)",
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    marginVertical: 8,
  },
  code_block: {
    color: "#cad3f5",
    fontFamily: "monospace",
    fontSize: 13,
    lineHeight: 19,
  },
  link: {
    color: "#8aadf4",
    textDecorationLine: "underline" as const,
  },
  list_item: {
    marginVertical: 2,
  },
  strong: {
    fontFamily: "SourceSans3_700Bold",
    color: "#cad3f5",
  },
  em: {
    fontStyle: "italic" as const,
  },
  blockquote: {
    backgroundColor: "rgba(198, 160, 246, 0.08)",
    borderLeftColor: "#c6a0f6",
    borderLeftWidth: 3,
    paddingLeft: 12,
    paddingVertical: 4,
    marginVertical: 8,
  },
  paragraph: {
    marginVertical: 4,
  },
};

/** Render a text part with markdown support. */
function TextPart({ part }: MessagePartProps): React.ReactElement {
  const text = part.text ?? "";

  if (!text) {
    return <View />;
  }

  return <Markdown style={mdStyles}>{text}</Markdown>;
}

/** Render a reasoning/thinking block — always expanded per user preference. */
function ReasoningPart({ part }: MessagePartProps): React.ReactElement {
  const text = part.text ?? "";

  return (
    <View className="bg-accent-violet-soft border-glass-border my-2 rounded-xl border p-4">
      <View className="mb-2 flex-row items-center">
        <Brain size={14} strokeWidth={2} color="#c6a0f6" />
        <Text className="font-display-medium text-accent-violet ml-2 text-xs tracking-wider uppercase">
          Thinking
        </Text>
      </View>
      {text ? (
        <Markdown
          style={{
            ...mdStyles,
            body: { ...mdStyles.body, color: "#a5adcb", fontSize: 14 },
          }}
        >
          {text}
        </Markdown>
      ) : (
        <Text className="font-body text-text-tertiary text-sm italic">
          Reasoning...
        </Text>
      )}
    </View>
  );
}

/** Render a tool call as a compact activity indicator. */
function ToolPart({ part }: MessagePartProps): React.ReactElement {
  const state = part.state as
    | { status: string; title?: string; tool?: string; error?: string }
    | undefined;
  const toolName = (part.tool as string) ?? "tool";
  const status = state?.status ?? "pending";
  const title = state?.title ?? toolName;

  const statusIcon =
    status === "completed" ? (
      <CheckCircle2 size={12} strokeWidth={2.5} color="#a6da95" />
    ) : status === "error" ? (
      <XCircle size={12} strokeWidth={2.5} color="#ed8796" />
    ) : (
      <Loader2 size={12} strokeWidth={2.5} color="#6e738d" />
    );

  return (
    <View className="my-1 flex-row items-center rounded-lg px-1 py-1.5">
      <Terminal size={12} strokeWidth={2} color="#6e738d" />
      <Text
        className="font-body text-text-tertiary ml-2 flex-1 text-xs"
        numberOfLines={1}
      >
        {title}
      </Text>
      <View className="ml-2">{statusIcon}</View>
    </View>
  );
}

/** Render step_start / step_finish as subtle dividers. */
function StepPart({ part }: MessagePartProps): React.ReactElement {
  if (part.type === "step-finish") {
    return <View className="bg-glass-border my-2 h-px" />;
  }
  // step-start: render nothing visible
  return <View />;
}

/** Fallback for unknown part types — render safely as a grey chip. */
function UnknownPart({ part }: MessagePartProps): React.ReactElement {
  return (
    <View className="bg-canvas-subtle my-1 self-start rounded-md px-3 py-1.5">
      <Text className="font-body text-text-tertiary text-xs">{part.type}</Text>
    </View>
  );
}

/**
 * Route a message part to the correct renderer based on `part.type`.
 */
function MessagePartInner({ part }: MessagePartProps): React.ReactElement {
  switch (part.type) {
    case "text":
      return <TextPart part={part} />;
    case "reasoning":
      return <ReasoningPart part={part} />;
    case "tool":
      return <ToolPart part={part} />;
    case "step-start":
    case "step-finish":
      return <StepPart part={part} />;
    default:
      return <UnknownPart part={part} />;
  }
}

export const MessagePart = memo(MessagePartInner);
