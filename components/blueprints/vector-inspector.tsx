import { Ruler, Tag, Spline } from "lucide-react";

/** Shape of analysisJson._vectorGeometry (see lib/ai/pdf-vectors.ts). */
export type ExtractedVectors = {
  page: number;
  widthPt: number;
  heightPt: number;
  dimensions: { s: string; x: number; y: number }[];
  labels: { s: string; x: number; y: number }[];
  segments: number[][];
};

/**
 * Debug view of what the vector-PDF extractor actually pulled off a plan —
 * the dimensions/labels and the drawn line segments handed to Stage 2 as
 * ground truth. The SVG flips Y (PDF origin is bottom-left) so it reads
 * the same way up as the plan. Reached via /dashboard/blueprints/[id]?inspect=1.
 */
export function VectorInspector({ vg }: { vg: ExtractedVectors }) {
  const W = vg.widthPt || 1;
  const H = vg.heightPt || 1;
  const stroke = Math.max(W, H) / 500;
  const dot = Math.max(W, H) / 220;

  return (
    <section className="rounded-xl border border-slate-700 bg-slate-900/60 p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-300">
        <span className="font-semibold text-white">
          Extracted vector layer (debug)
        </span>
        <span>page {vg.page}</span>
        <span>
          {W}×{H} pt
        </span>
        <span className="inline-flex items-center gap-1">
          <Spline size={12} /> {vg.segments.length} segments
        </span>
        <span className="inline-flex items-center gap-1">
          <Ruler size={12} /> {vg.dimensions.length} dimensions
        </span>
        <span className="inline-flex items-center gap-1">
          <Tag size={12} /> {vg.labels.length} labels
        </span>
      </div>

      <p className="text-xs text-slate-400">
        Cyan = drawn line segments (the footprint should be visible in the long
        orthogonal ones). Amber dots = where dimension labels sit. This is what
        Stage 2 receives as ground truth.
      </p>

      <div className="overflow-hidden rounded-lg border border-slate-700 bg-slate-950">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="h-auto w-full"
          preserveAspectRatio="xMidYMid meet"
        >
          <g transform={`translate(0 ${H}) scale(1 -1)`}>
            {vg.segments.map((s, i) => (
              <line
                key={`s${i}`}
                x1={s[0]}
                y1={s[1]}
                x2={s[2]}
                y2={s[3]}
                stroke="#2dd4bf"
                strokeWidth={stroke}
                strokeLinecap="round"
              />
            ))}
            {vg.dimensions.map((d, i) => (
              <circle
                key={`d${i}`}
                cx={d.x}
                cy={d.y}
                r={dot}
                fill="#f59e0b"
                opacity={0.85}
              />
            ))}
          </g>
        </svg>
      </div>

      {vg.dimensions.length > 0 && (
        <div className="text-xs text-slate-300">
          <div className="font-medium text-slate-200">Dimensions</div>
          <div className="mt-1 font-mono leading-relaxed text-slate-400">
            {vg.dimensions.map((d) => d.s).join("   ")}
          </div>
        </div>
      )}
      {vg.labels.length > 0 && (
        <div className="text-xs text-slate-300">
          <div className="font-medium text-slate-200">Labels</div>
          <div className="mt-1 font-mono leading-relaxed text-slate-400">
            {vg.labels.map((d) => d.s).join("   ")}
          </div>
        </div>
      )}
    </section>
  );
}
