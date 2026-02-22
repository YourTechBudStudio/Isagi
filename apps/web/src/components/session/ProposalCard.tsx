import { CheckCircle2, CircleDashed, XCircle } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { SurfaceCard } from "@/components/ui/SurfaceCard";

type ProposalStatus = "approved" | "rejected" | "pending";

type ProposalCardProps = {
  readonly status: ProposalStatus;
  readonly title: string;
  readonly subtitle: string;
  readonly dependencyLabel?: string;
};

export function ProposalCard({
  status,
  title,
  subtitle,
  dependencyLabel,
}: ProposalCardProps) {
  if (status === "approved") {
    return (
      <SurfaceCard tone="green" className="rounded-xl p-4 transition-all">
        <div className="mb-2 flex items-start justify-between">
          <div className="text-accent-green flex items-center gap-2 text-sm font-semibold">
            <CheckCircle2 className="h-4 w-4" />
            Approved
          </div>
        </div>
        <h3 className="text-text-primary mb-1 font-medium">{title}</h3>
        <p className="text-text-secondary text-sm">{subtitle}</p>
      </SurfaceCard>
    );
  }

  if (status === "rejected") {
    return (
      <SurfaceCard
        tone="elevated"
        className="rounded-xl border-white/5 bg-white/2 p-4 opacity-60 grayscale transition-all"
      >
        <div className="mb-2 flex items-start justify-between">
          <div className="text-text-tertiary flex items-center gap-2 text-sm font-semibold">
            <XCircle className="h-4 w-4" />
            Rejected
          </div>
          <button className="text-text-tertiary hover:text-text-primary text-xs underline decoration-white/20 underline-offset-2">
            Restore
          </button>
        </div>
        <h3 className="text-text-primary mb-1 font-medium line-through decoration-white/20">
          {title}
        </h3>
        <p className="text-text-secondary text-sm line-through decoration-white/20">
          {subtitle}
        </p>
      </SurfaceCard>
    );
  }

  return (
    <SurfaceCard
      tone="violet"
      className="group relative overflow-hidden rounded-xl p-4"
    >
      <div className="bg-accent-violet/10 pointer-events-none absolute top-0 right-0 h-24 w-24 translate-x-1/2 -translate-y-1/2 rounded-full blur-2xl" />

      <div className="relative z-10 mb-3 flex items-start justify-between">
        <div className="text-accent-violet flex items-center gap-2 text-sm font-semibold">
          <CircleDashed className="h-4 w-4" />
          Pending Review
        </div>
        <button className="text-text-tertiary hover:text-text-primary text-xs transition-colors">
          Edit
        </button>
      </div>

      <div className="relative z-10 mb-4">
        <h3 className="text-text-primary mb-1 text-[15px] font-medium">
          {title}
        </h3>
        <p className="text-text-secondary mb-3 text-sm">{subtitle}</p>
        {dependencyLabel ? (
          <div className="text-text-tertiary rounded-lg bg-black/20 p-2.5 font-mono text-xs">
            Depends on: {dependencyLabel}
          </div>
        ) : null}
      </div>

      <div className="relative z-10 flex items-center gap-2">
        <Button
          variant="ghost"
          size="md"
          className="bg-accent-green/10 hover:bg-accent-green/20 text-accent-green border-accent-green/20 flex-1 border"
        >
          Approve
        </Button>
        <Button
          variant="ghost"
          size="md"
          className="bg-accent-red/10 hover:bg-accent-red/20 text-accent-red border-accent-red/20 flex-1 border"
        >
          Reject
        </Button>
      </div>
    </SurfaceCard>
  );
}
