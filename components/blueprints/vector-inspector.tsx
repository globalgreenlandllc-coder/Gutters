import { Ruler, Tag, Spline } from "lucide-react";

/** One extracted page (see lib/ai/pdf-vectors.ts PdfPageVectors). */
export type PageVectors = {
  page: number;
  sheet?: string;
  widthPt: number;
  heightPt: number;
  dimensions: { s: string; x: number; y: number }[];
  labels: { s: string; x: number; y: number }[];
  segments: number[][];
};

/** Shape of analysisJson._vectorGeometry (PlanVectors). Legacy rows stored
 *  a single flat page; page.tsx normalizes those into { footprint }. */
export type ExtractedVectors = {
  footprint: PageVectors | null;
  roof: PageVectors | null;
};

/** Debug SVG + lists for one extracted page. The SVG flips Y (PDF origin is
 *  bottom-left) so it reads the same way up as the plan. */
function PagePanel({
  title,
  subtitle,
  accent,
  v,
}: {
  title: string;
  subtitle: string;
  accent: string;
  v: PageVectors;
}) {
  const W = v.widthPt || 1;
  const H = v.heightPt || 1;
  const stroke = Math.max(W, H) / 500;
  const dot = Math.max(W, H) / 220;

  return (
    <section className="rounded-xl border border-white/10 bg-zinc-950 p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-400">
        <span className="font-semibold tracking-tight text-white">{title}</span>
        <span>
          {v.sheet ? `${v.sheet} · ` : ""}page {v.page}
        </span>
        <span>
          {W}×{H} pt
        </span>
        <span className="inline-flex items-center gap-1">
          <Spline size={12} /> {v.segments.length} segments
        </span>
        <span className="inline-flex items-center gap-1">
          <Ruler size={12} /> {v.dimensions.length} dimensions
        </span>
        <span className="inline-flex items-center gap-1">
          <Tag size={12} /> {v.labels.length} labels
        </span>
      </div>

      <p className="text-xs text-zinc-400">{subtitle}</p>

      <div className="overflow-hidden rounded-lg border border-white/10 bg-ink">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="h-auto w-full"
          preserveAspectRatio="xMidYMid meet"
        >
          <g transform={`translate(0 ${H}) scale(1 -1)`}>
            {v.segments.map((s, i) => (
              <line
                key={`s${i}`}
                x1={s[0]}
                y1={s[1]}
                x2={s[2]}
                y2={s[3]}
                stroke={accent}
                strokeWidth={stroke}
                strokeLinecap="round"
              />
            ))}
            {v.dimensions.map((d, i) => (
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

      {v.dimensions.length > 0 && (
        <div className="text-xs text-zinc-300">
          <div className="font-label text-[10px] text-zinc-300">Dimensions</div>
          <div className="mt-1 font-mono leading-relaxed text-zinc-400">
            {v.dimensions.map((d) => d.s).join("   ")}
          </div>
        </div>
      )}
      {v.labels.length > 0 && (
        <div className="text-xs text-zinc-300">
          <div className="font-label text-[10px] text-zinc-300">Labels</div>
          <div className="mt-1 font-mono leading-relaxed text-zinc-400">
            {v.labels.map((d) => d.s).join("   ")}
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * Debug view of what the vector-PDF extractor actually pulled off a plan.
 * The footprint panel (cyan) is the AUTHORITATIVE building outline read from
 * the foundation/floor plan; the roof panel (violet) is the roof-plan lines
 * used only for edge classification. Reached via
 * /dashboard/blueprints/[id]?inspect=1.
 */
export function VectorInspector({ vg }: { vg: ExtractedVectors }) {
  return (
    <div className="space-y-4">
      {/* Server component — entrance is CSS-only (.anim-enter + stagger),
          matching the banners on the blueprint detail page. */}
      {vg.footprint ? (
        <div className="anim-enter">
          <PagePanel
            title="Building outline (authoritative footprint)"
            subtitle="Cyan = drawn outline from the foundation/floor plan — the outermost loop should be the building footprint. Amber dots = dimension labels. This is what Stage 2 snaps the footprint to."
            accent="#2dd4bf"
            v={vg.footprint}
          />
        </div>
      ) : (
        <div className="anim-enter rounded-xl border border-white/10 bg-zinc-950 p-4 text-sm text-zinc-300">
          No building-outline vectors were extracted (no readable foundation /
          floor-plan vector layer). Stage 2 ran without a footprint outline.
        </div>
      )}
      {vg.roof && (
        <div className="anim-enter stagger-2">
          <PagePanel
            title="Roof-plan lines (edge cross-reference)"
            subtitle="Violet = roof-plan strokes (ridges/hips/valleys + edges). Used only to classify eave-vs-rake — the footprint is NOT snapped to these (may be a dense framing/truss sheet)."
            accent="#a78bfa"
            v={vg.roof}
          />
        </div>
      )}
    </div>
  );
}
