"use client";

import { Ruler, Droplets, Triangle, Sparkles, AlertTriangle } from "lucide-react";
import type { BlueprintAnalysis } from "@/lib/ai/blueprint-from-plans";

interface Props {
  analysis: BlueprintAnalysis;
}

const CONFIDENCE_META: Record<
  string,
  { label: string; classes: string }
> = {
  high: { label: "High confidence", classes: "bg-emerald-500/10 text-emerald-300 ring-emerald-500/40" },
  medium: { label: "Medium confidence", classes: "bg-amber-500/10 text-amber-300 ring-amber-500/40" },
  low: { label: "Low confidence", classes: "bg-orange-500/10 text-orange-300 ring-orange-500/40" },
};

export default function BlueprintStats({ analysis }: Props) {
  const totals = analysis.totals;
  const conf = CONFIDENCE_META[analysis.confidence] ?? CONFIDENCE_META.low;
  const lf = totals.linear_feet_gutter;
  const lfDisplay =
    lf != null
      ? `${lf.toFixed(1)} LF`
      : "— (scale unknown)";

  return (
    <div className="space-y-3">
      {/* Top headline cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat
          Icon={Ruler}
          label="Gutter total"
          value={lfDisplay}
          accent="text-cyan-300"
        />
        <Stat
          Icon={Droplets}
          label="Downspouts"
          value={String(totals.downspout_count)}
          accent="text-sky-300"
        />
        <Stat
          Icon={Triangle}
          label="Outside miters"
          value={String(totals.outside_corner_miters)}
          accent="text-violet-300"
        />
        <Stat
          Icon={Triangle}
          label="Inside miters"
          value={String(totals.inside_corner_miters)}
          accent="text-violet-300/80"
        />
      </div>

      {/* Confidence + scale source */}
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ring-1 ${conf.classes}`}
        >
          <Sparkles size={12} />
          {conf.label}
        </span>
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-slate-800 text-slate-300 text-xs font-medium ring-1 ring-slate-700">
          Scale:{" "}
          {analysis.scale.feet_per_unit != null
            ? `1 unit = ${analysis.scale.feet_per_unit.toFixed(3)} ft (${analysis.scale.source})`
            : "pixels only"}
        </span>
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-slate-800 text-slate-300 text-xs font-medium ring-1 ring-slate-700">
          {analysis.gutter_runs.length} gutter run{analysis.gutter_runs.length === 1 ? "" : "s"}
        </span>
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-slate-800 text-slate-300 text-xs font-medium ring-1 ring-slate-700">
          {analysis.excluded_edges.length} edge{analysis.excluded_edges.length === 1 ? "" : "s"} excluded
        </span>
      </div>

      {/* AI notes */}
      {analysis.notes && analysis.notes.length > 0 && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-200">
          <div className="flex items-center gap-1.5 mb-1">
            <AlertTriangle size={13} />
            <span className="text-[11px] uppercase tracking-wider font-semibold">
              AI notes
            </span>
          </div>
          <ul className="ml-4 list-disc text-amber-200/90 text-[13px] space-y-0.5">
            {analysis.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

interface StatProps {
  Icon: typeof Ruler;
  label: string;
  value: string;
  accent: string;
}
function Stat({ Icon, label, value, accent }: StatProps) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-3">
      <div className="flex items-center gap-1.5 text-slate-500 text-[11px] uppercase tracking-wider mb-1">
        <Icon size={11} />
        {label}
      </div>
      <div className={`font-semibold text-xl ${accent}`}>{value}</div>
    </div>
  );
}
