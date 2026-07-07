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
  high: { label: "High confidence", classes: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  medium: { label: "Medium confidence", classes: "bg-amber-50 text-amber-700 border-amber-200" },
  low: { label: "Low confidence", classes: "bg-rose-50 text-rose-700 border-rose-200" },
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
      {/* KPI row — one bordered surface, cells split by dividers */}
      <div className="surface grid grid-cols-2 divide-y divide-zinc-100 shadow-card md:grid-cols-4 md:divide-x md:divide-y-0">
        <Stat Icon={Ruler} label="Gutter total" value={lfDisplay} />
        <Stat
          Icon={Droplets}
          label="Downspouts"
          value={String(totals.downspout_count)}
        />
        <Stat
          Icon={Triangle}
          label="Outside miters"
          value={String(totals.outside_corner_miters)}
        />
        <Stat
          Icon={Triangle}
          label="Inside miters"
          value={String(totals.inside_corner_miters)}
        />
      </div>

      {/* Confidence + scale source */}
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium ${conf.classes}`}
        >
          <Sparkles size={12} />
          {conf.label}
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-700">
          Scale:{" "}
          {analysis.scale.feet_per_unit != null
            ? `1 unit = ${analysis.scale.feet_per_unit.toFixed(3)} ft (${analysis.scale.source})`
            : "pixels only"}
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-700">
          {analysis.gutter_runs.length} gutter run{analysis.gutter_runs.length === 1 ? "" : "s"}
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-700">
          {analysis.excluded_edges.length} edge{analysis.excluded_edges.length === 1 ? "" : "s"} excluded
        </span>
      </div>

      {/* AI notes */}
      {analysis.notes && analysis.notes.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          <div className="mb-1 flex items-center gap-1.5">
            <AlertTriangle size={13} />
            <span className="font-label text-[11px]">AI notes</span>
          </div>
          <ul className="ml-4 list-disc space-y-0.5 text-[13px] text-amber-800/90">
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
}
function Stat({ Icon, label, value }: StatProps) {
  return (
    <div className="p-4">
      <div className="flex items-center gap-1.5 text-sm text-zinc-500">
        <Icon size={13} className="text-zinc-400" />
        {label}
      </div>
      <div className="mt-1 text-[22px] font-semibold tabular-nums tracking-tight text-zinc-900">
        {value}
      </div>
    </div>
  );
}
