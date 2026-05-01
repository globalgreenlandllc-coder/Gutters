"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { Camera, Building2, Ruler } from "lucide-react";
import { TopBar } from "./top-bar";
import { AerialCanvas, lineLengthFt } from "./aerial-canvas";
import { PricingPanel } from "./pricing-panel";
import { Badge } from "@/components/ui/badge";
import {
  sampleEaves,
  sampleDownspouts,
  sampleMeasurements,
} from "@/lib/mock-estimate";
import type { Measurements } from "@/lib/types";

export function ResultsView({ address }: { address: string }) {
  const [eaves, setEaves] = useState(sampleEaves);
  const [downspouts, setDownspouts] = useState(sampleDownspouts);

  const liveEaveLF = Math.round(
    eaves.reduce((acc, l) => acc + lineLengthFt(l), 0),
  );

  const measurements: Measurements = {
    ...sampleMeasurements,
    eaveLF: liveEaveLF || sampleMeasurements.eaveLF,
    downspoutCount: downspouts.length,
  };

  return (
    <div className="flex min-h-screen flex-col">
      <TopBar address={address} />

      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="flex-1"
      >
        <div className="mx-auto grid max-w-[1600px] gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_440px]">
          <div className="flex flex-col gap-4">
            <PropertyHeader address={address} measurements={measurements} />
            <div className="min-h-[520px] flex-1">
              <AerialCanvas
                eaves={eaves}
                downspouts={downspouts}
                onEavesChange={setEaves}
                onDownspoutsChange={setDownspouts}
              />
            </div>
            <SiteContext />
          </div>

          <div className="lg:sticky lg:top-[72px] lg:self-start">
            <div className="rounded-2xl border border-zinc-200 bg-white shadow-card">
              <div className="h-[calc(100vh-7rem)] overflow-hidden lg:max-h-[calc(100vh-7rem)]">
                <PricingPanel measurements={measurements} />
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
}: {
  address: string;
  measurements: Measurements;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-zinc-200 bg-white p-4 shadow-card">
      <div>
        <div className="flex items-center gap-2">
          <Building2 className="h-4 w-4 text-zinc-400" />
          <h1 className="font-display text-lg font-semibold tracking-tight text-zinc-900">
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
