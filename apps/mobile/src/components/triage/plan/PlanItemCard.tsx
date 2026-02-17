import { CheckCircle2, Circle, CircleDot, XCircle } from "lucide-react-native";
import { memo } from "react";
import { Text, View } from "react-native";

import type { TriageItem } from "@/types/triage";

interface PlanItemCardProps {
  readonly item: TriageItem;
}

const STATUS_CONFIG: Record<
  TriageItem["status"],
  { label: string; color: string; bg: string; Icon: typeof Circle }
> = {
  proposed: {
    label: "Proposed",
    color: "#8aadf4",
    bg: "bg-accent-blue-soft",
    Icon: CircleDot,
  },
  approved: {
    label: "Approved",
    color: "#a6da95",
    bg: "bg-accent-green-soft",
    Icon: CheckCircle2,
  },
  rejected: {
    label: "Rejected",
    color: "#ed8796",
    bg: "bg-accent-red-soft",
    Icon: XCircle,
  },
  applied: {
    label: "Applied",
    color: "#a6da95",
    bg: "bg-accent-green-soft",
    Icon: CheckCircle2,
  },
};

const KIND_LABELS: Record<TriageItem["kind"], string> = {
  container: "Container",
  work_item: "Work Item",
  derived_spark: "Spark",
};

/**
 * Single plan item card showing kind, title, workstream, and status.
 */
function PlanItemCardInner({ item }: PlanItemCardProps): React.ReactElement {
  const { label, color, bg, Icon } = STATUS_CONFIG[item.status];

  return (
    <View className="border-glass-border bg-canvas-subtle mb-3 rounded-xl border p-4">
      {/* Top row: kind badge + status badge */}
      <View className="mb-2 flex-row items-center justify-between">
        <View className="bg-canvas-elevated rounded-md px-2 py-0.5">
          <Text className="font-body-semi text-text-tertiary text-[10px] tracking-wider uppercase">
            {KIND_LABELS[item.kind]}
          </Text>
        </View>
        <View
          className={`${bg} flex-row items-center rounded-full px-2.5 py-1`}
        >
          <Icon size={10} strokeWidth={2.5} color={color} />
          <Text
            className="font-body-semi ml-1 text-[10px] tracking-wider uppercase"
            /* NativeWind can't do dynamic color, use style for this one exception */
          >
            {label}
          </Text>
        </View>
      </View>

      {/* Title */}
      <Text className="font-display-medium text-text-primary text-sm leading-5">
        {item.title ?? item.id}
      </Text>

      {/* Workstream */}
      <Text className="font-body text-text-tertiary mt-1 text-xs">
        {item.workstream}
        {item.container_ref ? ` / ${item.container_ref}` : ""}
      </Text>
    </View>
  );
}

export const PlanItemCard = memo(PlanItemCardInner);
