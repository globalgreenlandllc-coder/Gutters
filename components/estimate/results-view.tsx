"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import {
  Building2,
  Camera,
  RefreshCcw,
  Ruler,
  Sparkles,
} from "lucide-react";
import { TopBar } from "./top-bar";
import { AerialCanvas, lineLengthFt } from "./aerial-canvas";
import { PricingPanel } from "./pricing-panel";
import { Badge } from "@/components/ui/badge";
import type { Measurements } from "@/lib/types";
import type { EstimateResult } from "@/lib/ai";
import type { EstimateHandoff } from "@/lib/estimate-handoff";

export function ResultsView({
  address,
  initial,
  reused,
  jobType = "replacement",
}: {
  address: string;
  initial: EstimateResult;
  reused: boolean;
  /** New construction vs replacement. Affects the proposal scope-of-work
   *  language downstream; here we surface it as a chip in the top bar so
   *  the contractor sees what mode they're in. */
  jobType?: "new" | "replacement";
}) {
  const [eaves, setEaves] = useState(initial.eaves);
  const [downspouts, setDownspouts] = useState(initial.downspouts);

  const liveEaveLF = Math.round(
    eaves.reduce((acc, l) => acc + lineLengthFt(l), 0),
  );

  const measurements: Measurements = {
    ...initial.measurements,
    eaveLF: liveEaveLF || initial.measurements.eaveLF,
    downspoutCount: downspouts.length,
  };

  // Single handoff payload — captured at click-time by either button.
  // Recomputed each render so live edits to eaves / downspouts are
  // included in whatever the contractor sends to /proposal.
  const handoff: Omit<EstimateHandoff, "capturedAt"> = {
    address,
    measurements,
    eaves,
    rakes: initial.rakes,
    downspouts,
    aerial: initial.aerial,
  };

  return (
    <div className="flex min-h-screen flex-col">
      <TopBar address={address} handoff={handoff} jobType={jobType} />

      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="flex-1"
      >
        <div className="mx-auto grid max-w-[1600px] gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_440px]">
          <div className="flex flex-col gap-4">
            <PropertyHeader
              address={address}
              measurements={measurements}
              source={initial.source}
              reused={reused}
              durationMs={initial.durationMs}
              notes={initial.notes}
            />
            <div className="min-h-[520px] flex-1">
              <AerialCanvas
                eaves={eaves}
                rakes={initial.rakes}
                downspouts={downspouts}
                onEavesChange={setEaves}
                onDownspoutsChange={setDownspouts}
                aerialImageUrl={initial.aerial?.imageDataUrl}
                roofStructure={initial.roofStructure}
              />
            </div>
            <SiteContext />
          </div>

          <div className="lg:sticky lg:top-[72px] lg:self-start">
            <div className="rounded-2xl border border-zinc-200 bg-white shadow-card">
              <div className="h-[calc(100vh-7rem)] overflow-hidden lg:max-h-[calc(100vh-7rem)]">
                <PricingPanel measurements={measurements} handoff={handoff} />
              </div>
            </div>
          </div>
        </div>
      </motion.div>
    </div>
  );
}

function PropertyHeader({
  address,
  measurements,
  source,
  reused,
  durationMs,
  notes,
}: {
  address: string;
  measurements: Measurements;
  source: EstimateResult["source"];
  reused: boolean;
  durationMs: number;
  notes: string[];
}) {
  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Building2 className="h-4 w-4 text-zinc-400" />
            <h1 className="truncate font-display text-lg font-semibold tracking-tight text-zinc-900">
              {address}
            </h1>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-zinc-500">
            <span>
              <span className="text-zinc-700">{measurements.stories}-story</span>{" "}
              single-family
            </span>
            <span>·</span>
            <span>
              <span className="text-zinc-700">
                {measurements.outsideCorners + measurements.insideCorners}
              </span>{" "}
              corners
            </span>
            <span>·</span>
            <span>
              <span className="text-zinc-700">
                {measurements.wasteFactorPct}%
              </span>{" "}
              waste factor
            </span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge>
            <Ruler className="h-3 w-3" />
            {measurements.eaveLF} LF eaves
          </Badge>
          <Badge tone="neutral">
            {measurements.downspoutCount} downspouts
          </Badge>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-zinc-100 pt-3 text-xs text-zinc-500">
        <SourceBadge source={source} />
        {reused && (
          <Badge tone="neutral">
            <RefreshCcw className="h-3 w-3" />
            Reused (no credit)
          </Badge>
        )}
        <span>· {durationMs} ms</span>
        {notes.map((n) => (
          <span key={n} className="rounded-full bg-zinc-100 px-2 py-0.5">
            {n}
          </span>
        ))}
      </div>
    </div>
  );
}

function SourceBadge({ source }: { source: EstimateResult["source"] }) {
  if (source === "ai") {
    return (
      <Badge tone="accent">
        <Sparkles className="h-3 w-3" />
        AI takeoff
      </Badge>
    );
  }
  if (source === "partial") {
    return (
      <Badge tone="amber">
        <Sparkles className="h-3 w-3" />
        Partial AI · geometry pending
      </Badge>
    );
  }
  return (
    <Badge tone="violet">
      <Sparkles className="h-3 w-3" />
      Mock data
    </Badge>
  );
}

function SiteContext() {
  const items = [
    { label: "Front facade", note: "Exposure: South" },
    { label: "Driveway side", note: "Easy ladder access" },
    { label: "Backyard", note: "Tree overhang — gutter guards rec." },
  ];
  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-card">
      <div className="flex items-center gap-2">
        <Camera className="h-4 w-4 text-zinc-400" />
        <span className="text-xs font-medium uppercase tracking-wider text-zinc-500">
          Site context
        </span>
      </div>
      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
        {items.map((it) => (
          <div
            key={it.label}
            className="rounded-xl border border-zinc-200 bg-zinc-50/40 p-3"
          >
            <div className="text-sm font-medium text-zinc-900">{it.label}</div>
            <div className="mt-0.5 text-xs text-zinc-500">{it.note}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
