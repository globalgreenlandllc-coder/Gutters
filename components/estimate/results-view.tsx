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
  planId,
}: {
  address: string;
  initial: EstimateResult;
  reused: boolean;
  /** New construction vs replacement. Affects the proposal scope-of-work
   *  language downstream; here we surface it as a chip in the top bar so
   *  the contractor sees what mode they're in. */
  jobType?: "new" | "replacement";
  /** When this estimate came from a plan upload, the PlanAnalysis id.
   *  Passed through to TopBar so the "Re-analyze" button can target
   *  the right row. */
  planId?: string;
}) {
  const [eaves, setEaves] = useState(initial.eaves);
  const [downspouts, setDownspouts] = useState(initial.downspouts);
  // Story count is editable from the property header — homeowners
  // sometimes second-guess a 2-story call when an attached garage
  // looks 1-story on satellite. Default seeded from the AI estimate;
  // contractor overrides with one click.
  const [stories, setStories] = useState(initial.measurements.stories);

  const liveEaveLF = Math.round(
    eaves.reduce((acc, l) => {
      const v = lineLengthFt(l);
      return acc + (Number.isFinite(v) ? v : 0);
    }, 0),
  );

  const measurements: Measurements = {
    ...initial.measurements,
    // Fall back to stored eaveLF when the live sum is 0 — happens
    // when all eaves were dropped at projection time (bad coords on
    // every gutter_run). Without this, the contractor sees "0 LF"
    // even though the stored takeoff has a real LF total.
    eaveLF: liveEaveLF > 0 ? liveEaveLF : initial.measurements.eaveLF,
    downspoutCount: downspouts.length,
    stories,
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
    roofStructure: initial.roofStructure,
    aerial: initial.aerial,
  };

  return (
    <div className="flex min-h-screen flex-col">
      <TopBar
        address={address}
        handoff={handoff}
        jobType={jobType}
        planId={planId}
      />

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
              onStoriesChange={setStories}
            />
            <div className="min-h-[520px] flex-1">
              <AerialCanvas
                eaves={eaves}
                rakes={initial.rakes}
                downspouts={downspouts}
                onEavesChange={setEaves}
                onDownspoutsChange={setDownspouts}
                aerialImageUrl={initial.aerial?.imageDataUrl}
                planSource={initial.planSource}
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
  onStoriesChange,
}: {
  address: string;
  measurements: Measurements;
  source: EstimateResult["source"];
  reused: boolean;
  durationMs: number;
  notes: string[];
  /** Optional callback to override the AI's story-count guess. When
   *  provided, renders the story segment as a clickable picker so the
   *  contractor can confirm or correct the AI's call in one tap. */
  onStoriesChange?: (n: 1 | 2 | 3) => void;
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
            {onStoriesChange ? (
              <span className="inline-flex items-center gap-1.5">
                <span className="text-[10px] uppercase tracking-wider text-zinc-400">
                  Stories
                </span>
                <span className="inline-flex overflow-hidden rounded-full border border-zinc-200 bg-zinc-50/50">
                  {([1, 2, 3] as const).map((n) => {
                    const active = measurements.stories === n;
                    return (
                      <button
                        key={n}
                        type="button"
                        onClick={() => onStoriesChange(n)}
                        className={
                          "px-2 py-0.5 text-xs font-semibold tabular-nums transition " +
                          (active
                            ? "bg-accent-600 text-white"
                            : "text-zinc-600 hover:bg-white hover:text-zinc-900")
                        }
                        title={`Set to ${n}-story`}
                      >
                        {n}
                      </button>
                    );
                  })}
                </span>
              </span>
            ) : (
              <span>
                <span className="text-zinc-700">
                  {measurements.stories}-story
                </span>{" "}
                single-family
              </span>
            )}
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
