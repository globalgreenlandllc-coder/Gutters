"use client";

import { useMemo, useState } from "react";
import type { BlueprintAnalysis } from "@/lib/ai/blueprint-from-plans";

interface Props {
  analysis: BlueprintAnalysis;
  /** Optional underlying page image data URL — when supplied, renders the
   *  original plan beneath the AI overlay so the contractor can verify each
   *  line lands on the right edge. */
  backgroundDataUrl?: string;
  /** Optional intrinsic image size for the viewBox. Defaults to the bbox
   *  of the analysis points + a small margin. */
  imageWidth?: number;
  imageHeight?: number;
}

/**
 * SVG renderer for a Claude-generated gutter blueprint.
 *
 * Layer order (back → front):
 *   1. source plan image (if provided)
 *   2. building footprint outline (light gray polygon)
 *   3. excluded edges (gray-dashed — rakes/ridges/valleys for context)
 *   4. gutter runs (solid cyan, thick)
 *   5. downspouts (filled cyan circles)
 *   6. labels for highlighted run / downspout on hover
 */
export default function BlueprintCanvas({
  analysis,
  backgroundDataUrl,
  imageWidth,
  imageHeight,
}: Props) {
  const [hoveredRunId, setHoveredRunId] = useState<string | null>(null);
  const [hoveredDsId, setHoveredDsId] = useState<string | null>(null);

  // Compute a sensible viewBox if image size wasn't supplied.
  const viewBox = useMemo(() => {
    if (imageWidth && imageHeight) {
      return { x: 0, y: 0, w: imageWidth, h: imageHeight };
    }
    const xs: number[] = [];
    const ys: number[] = [];
    for (const p of analysis.building_footprint) {
      xs.push(p.x);
      ys.push(p.y);
    }
    for (const r of analysis.gutter_runs) {
      xs.push(r.start.x, r.end.x);
      ys.push(r.start.y, r.end.y);
    }
    for (const d of analysis.downspouts) {
      xs.push(d.at.x);
      ys.push(d.at.y);
    }
    if (xs.length === 0) {
      return { x: 0, y: 0, w: 1000, h: 800 };
    }
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const padX = Math.max(20, (maxX - minX) * 0.05);
    const padY = Math.max(20, (maxY - minY) * 0.05);
    return {
      x: minX - padX,
      y: minY - padY,
      w: maxX - minX + 2 * padX,
      h: maxY - minY + 2 * padY,
    };
  }, [analysis, imageWidth, imageHeight]);

  const footprintPoints = analysis.building_footprint
    .map((p) => `${p.x},${p.y}`)
    .join(" ");

  return (
    <div className="relative w-full overflow-hidden rounded-xl border border-white/10 bg-ink">
      <svg
        viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`}
        className="block w-full h-auto"
        preserveAspectRatio="xMidYMid meet"
      >
        {backgroundDataUrl && imageWidth && imageHeight && (
          <image
            href={backgroundDataUrl}
            x={0}
            y={0}
            width={imageWidth}
            height={imageHeight}
            opacity={0.45}
          />
        )}

        {/* Footprint outline */}
        {analysis.building_footprint.length >= 3 && (
          <polygon
            points={footprintPoints}
            fill="none"
            stroke="#94a3b8"
            strokeWidth={Math.max(1.5, viewBox.w / 600)}
            strokeLinejoin="round"
          />
        )}

        {/* Excluded edges (rakes/ridges/hips/valleys) — dashed for context */}
        {analysis.excluded_edges.map((e, i) => (
          <line
            key={`x-${i}`}
            x1={e.start.x}
            y1={e.start.y}
            x2={e.end.x}
            y2={e.end.y}
            stroke="#64748b"
            strokeWidth={Math.max(1.5, viewBox.w / 700)}
            strokeDasharray={`${Math.max(6, viewBox.w / 100)} ${Math.max(4, viewBox.w / 150)}`}
            strokeLinecap="round"
          >
            <title>{`${e.kind} — ${e.reason}`}</title>
          </line>
        ))}

        {/* Gutter runs — cyan, thick, the headline data */}
        {analysis.gutter_runs.map((r) => {
          const isHover = hoveredRunId === r.id;
          return (
            <g key={r.id}>
              <line
                x1={r.start.x}
                y1={r.start.y}
                x2={r.end.x}
                y2={r.end.y}
                stroke={isHover ? "#67e8f9" : "#06b6d4"}
                strokeWidth={Math.max(4, viewBox.w / 180)}
                strokeLinecap="round"
                onMouseEnter={() => setHoveredRunId(r.id)}
                onMouseLeave={() => setHoveredRunId((id) => (id === r.id ? null : id))}
                style={{ cursor: "pointer" }}
              >
                <title>
                  {`Gutter ${r.id} · ${r.side} side · ${r.length_ft != null ? `${r.length_ft.toFixed(1)} ft` : `${r.length_px.toFixed(0)} px`}`}
                </title>
              </line>
              {isHover && r.length_ft != null && (
                <text
                  x={(r.start.x + r.end.x) / 2}
                  y={(r.start.y + r.end.y) / 2 - 8}
                  textAnchor="middle"
                  fontSize={Math.max(10, viewBox.w / 80)}
                  fill="#67e8f9"
                  fontWeight={600}
                  style={{ pointerEvents: "none" }}
                >
                  {r.length_ft.toFixed(1)}′
                </text>
              )}
            </g>
          );
        })}

        {/* Downspouts */}
        {analysis.downspouts.map((d) => {
          const isHover = hoveredDsId === d.id;
          const r = Math.max(5, viewBox.w / 140);
          return (
            <g key={d.id}>
              <circle
                cx={d.at.x}
                cy={d.at.y}
                r={r}
                fill={isHover ? "#22d3ee" : "#0891b2"}
                stroke="#ffffff"
                strokeWidth={Math.max(1.5, viewBox.w / 600)}
                onMouseEnter={() => setHoveredDsId(d.id)}
                onMouseLeave={() => setHoveredDsId((id) => (id === d.id ? null : id))}
                style={{ cursor: "pointer" }}
              >
                <title>
                  {`Downspout ${d.id} · drops ${d.drop_direction} · ${d.reason.replace(/_/g, " ")}`}
                </title>
              </circle>
            </g>
          );
        })}
      </svg>

      {/* Legend */}
      <div className="absolute bottom-3 left-3 right-3 flex flex-wrap items-center gap-3 rounded-lg border border-white/10 bg-zinc-950/85 px-3 py-2 backdrop-blur-md">
        <div className="flex items-center gap-1.5">
          <span className="inline-block w-5 h-1 rounded bg-cyan-500" />
          <span className="font-label text-[10px] text-zinc-200">Gutter run</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="inline-block w-2 h-2 rounded-full bg-cyan-700 ring-1 ring-white" />
          <span className="font-label text-[10px] text-zinc-200">Downspout</span>
        </div>
        <div className="flex items-center gap-1.5">
          <svg width={20} height={4} className="overflow-visible">
            <line x1={0} y1={2} x2={20} y2={2} stroke="#64748b" strokeWidth={2} strokeDasharray="4 3" />
          </svg>
          <span className="font-label text-[10px] text-zinc-400">Excluded (rake / ridge / hip / valley)</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="inline-block w-5 h-px bg-zinc-400" />
          <span className="font-label text-[10px] text-zinc-400">Footprint</span>
        </div>
      </div>
    </div>
  );
}
