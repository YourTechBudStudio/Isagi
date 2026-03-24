import { X } from "lucide-react";

import { ScrollableArea } from "@/components/layout/ScrollableArea";
import { ProposalCard } from "@/components/session/ProposalCard";
import { IconButton } from "@/components/ui/IconButton";
import type { SessionProposal } from "@/lib/mock/session.mock";

type SessionShapingPanelProps = {
  readonly proposals: ReadonlyArray<SessionProposal>;
  readonly onClose: () => void;
};

export function SessionShapingPanel({
  proposals,
  onClose,
}: SessionShapingPanelProps) {
  return (
    <>
      <div className="flex h-16 shrink-0 items-center justify-between border-b border-white/5 px-5">
        <h2 className="text-text-tertiary flex items-center gap-2 text-xs font-semibold tracking-wider uppercase">
          <div className="bg-accent-blue/80 h-1.5 w-1.5 rounded-full shadow-[0_0_8px_rgba(138,173,244,0.8)]" />
          Proposed Actions
        </h2>
        <IconButton
          onClick={onClose}
          icon={<X className="h-4 w-4" />}
          variant="subtle"
          title="Close Panel"
        />
      </div>

      <ScrollableArea className="flex-1 space-y-4 p-5">
        {proposals.map(proposal => (
          <ProposalCard
            key={proposal.id}
            status={proposal.status}
            title={proposal.title}
            subtitle={proposal.subtitle}
            dependencyLabel={proposal.dependencyLabel}
          />
        ))}
      </ScrollableArea>
    </>
  );
}
