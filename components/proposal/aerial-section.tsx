"use client";

import { Ruler } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { AerialReadonly } from "@/components/estimate/aerial-shared";
import { sampleEaves, sampleDownspouts } from "@/lib/mock-estimate";
import type { Proposal } from "@/lib/proposal-mock";
import { SectionHeader } from "./packages-section";

export function AerialSection({ proposal }: { proposal: Proposal }) {
  return (
    <section data-section="aerial" className="space-y-4">
      <SectionHeader
        title="What we measured"
        sub="Eaves and downspouts traced from aerial imagery."
      />
      <div className="space-y-3">
        <AerialReadonly
          eaves={sampleEaves}
          downspouts={sampleDownspouts}
          className="aspect-[16/10]"
        />
        <div className="flex flex-wrap items-center gap-2">
          <Badge>
            <Ruler className="h-3 w-3" />
            {proposal.measurements.eaveLF} LF eaves
          </Badge>
          <Badge tone="neutral">
            {proposal.measurements.downspoutCount} downspouts
          </Badge>
          <Badge tone="neutral">
            {proposal.measurements.outsideCorners +
              proposal.measurements.insideCorners}{" "}
            corners
          </Badge>
          <Badge tone="neutral">{proposal.measurements.stories}-story</Badge>
          <Badge tone="neutral">
            {proposal.measurements.wasteFactorPct}% waste
          </Badge>
        </div>
      </div>
    </section>
  );
}
