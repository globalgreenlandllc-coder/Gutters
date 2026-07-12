"use client";

import { useMemo } from "react";
import {
  VIEWBOX_W,
  VIEWBOX_H,
  BlueprintBackground,
} from "./aerial-shared";
import { PX_PER_FT } from "./aerial-constants";
import {
  bboxOfPoints,
  polylineLengthFt,
  reflexCorners,
  type Pt,
  type DBBox,
} from "@/lib/diagram-geom";
import type { Downspout, EditableLine, RoofStructure } from "@/lib/types";

/**
 * GutterDiagram — a light, brand-blue "drafting sheet" rendering of a
 * satellite/address takeoff, the way pro roof reports (EagleView / Roofr)
 * present measurements: a clean 2D top-down vector diagram derived from the
 * footprint at the trace's true px/ft scale, NOT colored lines painted on
 * the photo.
 *
 * GUTTER-FIRST (the product's differentiator): eaves are the bold hero line
 * in the water-blue brand color (gutter = where the water goes), each run
 * LF-labeled; rakes are de-emphasized dashed "no gutter" gable edges;
 * downspouts are numbered drops; inside corners get a miter chevron; the
 * roof skeleton (real detected ridges/valleys) is faint and decorative.
 *
 * All geometry is already in the 900×580 canvas viewBox (COVER-fit of the
 * tile), so nothing is reprojected. Purely a render + read-only summary math
 * over the SAME eaves the pricing path sums — it never changes a priced
 * total. `suggestedEaves` are un-priced interior-gutter hints; clicking one
 * (when onAcceptSuggested is provided) promotes it to a real eave.
 */

// Palette — the app's water-blue brand (#14688C) is the gutter.
const C = {
  eave: "#14688c",
  eaveInk: "#10475e",
  rake: "#a8977b",
  suggest: "#c8892b",
  suggestBg: "#fbf1de",
  drop: "#e8687a",
  mass: "rgba(20,58,74,.055)",
  massEdge: "rgba(20,58,74,.35)",
  skeleton: "rgba(20,58,74,.30)",
  chipFill: "rgba(255,255,255,.94)",
  chipStroke: "rgba(30,58,138,.35)",
  chipText: "#10475e",
  paper: "#f7f4ee",
};

const LABEL_MIN_FT = 6;

type SimpleLine = Pick<EditableLine, "id" | "points">;

function pathD(points: Pt[]): string {
  if (points.length === 0) return "";
  return (
    `M ${points[0].x} ${points[0].y} ` +
    points
      .slice(1)
      .map((p) => `L ${p.x} ${p.y}`)
      .join(" ")
  );
}

function midpointOf(points: Pt[]): Pt {
  const a = points[0];
  const b = points[points.length - 1];
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function GutterDiagram({
  eaves,
  rakes = [],
  downspouts,
  suggestedEaves = [],
  roofStructure,
  pxPerFt,
  address,
  confidence,
  onAcceptSuggested,
  className,
}: {
  eaves: EditableLine[];
  rakes?: EditableLine[];
  downspouts: Downspout[];
  /** Un-priced interior-gutter hints (dashed amber). */
  suggestedEaves?: EditableLine[];
  roofStructure?: RoofStructure;
  /** Satellite trace's canvas-px-per-foot. Falls back to the plan constant
   *  only so labels never divide by undefined; satellite always passes it. */
  pxPerFt?: number;
  address?: string;
  /** 0–1 trace confidence → drives the header badge. */
  confidence?: number;
  /** When provided, suggested runs become clickable to promote into eaves. */
  onAcceptSuggested?: (line: EditableLine) => void;
  className?: string;
}) {
  const scale = Number.isFinite(pxPerFt) && (pxPerFt ?? 0) > 0 ? pxPerFt! : PX_PER_FT;

  const perimeter = roofStructure?.perimeter ?? [];
  const hasPerimeter = perimeter.length >= 3;

  const bbox: DBBox | null = useMemo(() => {
    if (hasPerimeter) return bboxOfPoints(perimeter);
    const pts = eaves.flatMap((e) => e.points);
    return bboxOfPoints(pts);
  }, [hasPerimeter, perimeter, eaves]);

  const centroid: Pt = useMemo(() => {
    if (bbox) return { x: (bbox.minX + bbox.maxX) / 2, y: (bbox.minY + bbox.maxY) / 2 };
    return { x: VIEWBOX_W / 2, y: VIEWBOX_H / 2 };
  }, [bbox]);

  const insideCorners = useMemo(
    () => (hasPerimeter ? reflexCorners(perimeter) : []),
    [hasPerimeter, perimeter],
  );

  const totalEaveLF = useMemo(
    () => Math.round(eaves.reduce((s, e) => s + polylineLengthFt(e.points, scale), 0)),
    [eaves, scale],
  );

  const suggestedLF = useMemo(
    () =>
      Math.round(
        suggestedEaves.reduce((s, e) => s + polylineLengthFt(e.points, scale), 0),
      ),
    [suggestedEaves, scale],
  );

  // Scale bar: a 10 ft segment at the trace's px/ft (clamped so it never
  // dominates a tiny-scale plan fallback).
  const scaleBarPx = Math.max(24, Math.min(180, 10 * scale));

  // Real detected roof seams (decorative, faint). Satellite has no hips.
  const skeleton: { pts: Pt[]; dash: boolean }[] = [
    ...(roofStructure?.ridges ?? []).map((l) => ({ pts: l.points, dash: false })),
    ...(roofStructure?.valleys ?? []).map((l) => ({ pts: l.points, dash: true })),
  ].filter((l) => l.pts.length >= 2);

  const orientationChips: { label: string; at: Pt }[] = bbox
    ? [
        { label: "BACK", at: { x: (bbox.minX + bbox.maxX) / 2, y: bbox.minY - 16 } },
        { label: "FRONT", at: { x: (bbox.minX + bbox.maxX) / 2, y: bbox.maxY + 16 } },
        { label: "LEFT", at: { x: bbox.minX - 22, y: (bbox.minY + bbox.maxY) / 2 } },
        { label: "RIGHT", at: { x: bbox.maxX + 22, y: (bbox.minY + bbox.maxY) / 2 } },
      ].filter(
        (c) => c.at.x > 8 && c.at.x < VIEWBOX_W - 8 && c.at.y > 8 && c.at.y < VIEWBOX_H - 8,
      )
    : [];

  const confPct = confidence != null ? Math.round(confidence * 100) : null;

  return (
    <div
      className={
        "relative h-full w-full overflow-hidden rounded-2xl ring-1 ring-indigo-200/40 " +
        (className ?? "")
      }
      style={{ background: C.paper }}
    >
      <svg
        viewBox={`0 0 ${VIEWBOX_W} ${VIEWBOX_H}`}
        preserveAspectRatio="xMidYMid meet"
        className="h-full w-full select-none"
        style={{ minHeight: 320 }}
        role="img"
        aria-label="Gutter measurement diagram"
      >
        <BlueprintBackground />

        {/* Filled roof mass so the building reads as a solid shape */}
        {hasPerimeter && (
          <path
            d={pathD(perimeter) + " Z"}
            fill={C.mass}
            stroke={C.massEdge}
            strokeWidth={1.4}
            strokeLinejoin="round"
          />
        )}

        {/* Faint real roof seams (ridges solid, valleys dashed) */}
        {skeleton.map((l, i) => (
          <path
            key={`sk-${i}`}
            d={pathD(l.pts)}
            fill="none"
            stroke={C.skeleton}
            strokeWidth={1.1}
            strokeDasharray={l.dash ? "5 4" : "1 5"}
            strokeLinecap="round"
          />
        ))}

        {/* Rakes — de-emphasized dashed "no gutter" gable edges */}
        {rakes.map((line) => (
          <path
            key={line.id}
            d={pathD(line.points)}
            fill="none"
            stroke={C.rake}
            strokeWidth={2.4}
            strokeDasharray="6 4"
            strokeLinecap="round"
            opacity={0.85}
          />
        ))}

        {/* Suggested interior gutters — un-priced amber dashed hints */}
        {suggestedEaves.map((line) => {
          if (line.points.length < 2) return null;
          const m = midpointOf(line.points);
          const clickable = !!onAcceptSuggested;
          return (
            <g key={line.id}>
              <path
                d={pathD(line.points)}
                fill="none"
                stroke={C.suggest}
                strokeWidth={2.6}
                strokeDasharray="7 5"
                strokeLinecap="round"
              />
              {/* Tap-to-add affordance */}
              <g
                onClick={clickable ? () => onAcceptSuggested!(line) : undefined}
                style={{ cursor: clickable ? "pointer" : "default" }}
              >
                <circle cx={m.x} cy={m.y} r={9} fill={C.suggestBg} stroke={C.suggest} strokeWidth={1.2} />
                <path
                  d={`M ${m.x - 4} ${m.y} H ${m.x + 4} M ${m.x} ${m.y - 4} V ${m.y + 4}`}
                  stroke={C.suggest}
                  strokeWidth={1.6}
                  strokeLinecap="round"
                />
              </g>
            </g>
          );
        })}

        {/* Eaves — the hero. Bold water-blue with LF labels. */}
        {eaves.map((line) => (
          <path
            key={line.id}
            d={pathD(line.points)}
            fill="none"
            stroke={C.eave}
            strokeWidth={4}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
        {eaves.map((line) => (
          <EaveLabel key={`lbl-${line.id}`} line={line} pxPerFt={scale} centroid={centroid} />
        ))}

        {/* Inside-corner miter chevrons */}
        {insideCorners.map((p, i) => (
          <circle
            key={`ic-${i}`}
            cx={p.x}
            cy={p.y}
            r={4.5}
            fill="none"
            stroke={C.eave}
            strokeWidth={1.6}
            opacity={0.9}
          />
        ))}

        {/* Downspouts — numbered coral drops */}
        {downspouts.map((d, i) => (
          <g key={d.id}>
            <circle cx={d.x} cy={d.y} r={8} fill={C.drop} stroke="#fff" strokeWidth={1.8} />
            <text
              x={d.x}
              y={d.y + 3}
              textAnchor="middle"
              fontSize={9}
              fontWeight={700}
              fill="#fff"
              fontFamily="ui-sans-serif, system-ui"
            >
              {i + 1}
            </text>
          </g>
        ))}

        {/* Orientation chips (paired with the north arrow for true bearing) */}
        {orientationChips.map((c) => {
          const w = c.label.length * 6.2 + 12;
          return (
            <g key={c.label}>
              <rect
                x={c.at.x - w / 2}
                y={c.at.y - 7}
                width={w}
                height={14}
                rx={3}
                fill={C.chipFill}
                stroke={C.chipStroke}
                strokeWidth={0.8}
              />
              <text
                x={c.at.x}
                y={c.at.y + 3.4}
                textAnchor="middle"
                fontSize={8}
                fontWeight={700}
                letterSpacing="1"
                fill={C.chipText}
                fontFamily="ui-sans-serif, system-ui"
              >
                {c.label}
              </text>
            </g>
          );
        })}

        {/* North arrow (tile is north-up) */}
        <g transform={`translate(${VIEWBOX_W - 44}, 40)`}>
          <line x1={0} y1={26} x2={0} y2={2} stroke={C.eave} strokeWidth={2} />
          <path d={`M -4 8 L 0 0 L 4 8`} fill="none" stroke={C.eave} strokeWidth={2} strokeLinejoin="round" />
          <text x={0} y={40} textAnchor="middle" fontSize={11} fontWeight={700} fill={C.eaveInk} fontFamily="ui-sans-serif, system-ui">
            N
          </text>
        </g>

        {/* Scale bar */}
        <g transform={`translate(40, ${VIEWBOX_H - 40})`} fontFamily="ui-monospace, monospace" fontSize={9} fill="#5a7583">
          <line x1={0} y1={0} x2={scaleBarPx} y2={0} stroke="#5a7583" strokeWidth={1.4} />
          <line x1={0} y1={-4} x2={0} y2={4} stroke="#5a7583" strokeWidth={1.4} />
          <line x1={scaleBarPx} y1={-4} x2={scaleBarPx} y2={4} stroke="#5a7583" strokeWidth={1.4} />
          <text x={0} y={14}>0</text>
          <text x={scaleBarPx} y={14} textAnchor="end">10 ft</text>
        </g>
      </svg>

      {/* HTML overlays — crisp text that scales with the container */}
      <div className="pointer-events-none absolute left-3 top-3 max-w-[60%]">
        {address && (
          <div
            className="truncate rounded-md bg-white/85 px-2.5 py-1 font-mono text-[11px] font-medium text-[#10475e] ring-1 ring-[#14688c]/20"
            title={address}
          >
            {address}
          </div>
        )}
      </div>
      <div className="pointer-events-none absolute right-3 top-3 flex items-center gap-2">
        {confPct != null && (
          <span
            className={
              "inline-flex items-center gap-1 rounded-full px-2 py-1 text-[10px] font-semibold " +
              (confPct >= 70
                ? "bg-emerald-500/12 text-emerald-700"
                : "bg-amber-500/14 text-amber-700")
            }
          >
            <span className="h-1.5 w-1.5 rounded-full bg-current" />
            {confPct >= 70 ? "High confidence" : `${confPct}% confidence`}
          </span>
        )}
        <span className="inline-flex items-center gap-1.5 rounded-full bg-[#14688c] px-2.5 py-1 text-[11px] font-semibold text-white tabular-nums">
          {totalEaveLF} LF
          <span className="opacity-60">·</span>
          {downspouts.length} drops
        </span>
      </div>
      {suggestedEaves.length > 0 && (
        <div className="pointer-events-none absolute bottom-3 left-1/2 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-[#c8892b] px-2.5 py-1 text-[10px] font-semibold text-white">
          {suggestedEaves.length} suggested interior {suggestedEaves.length === 1 ? "run" : "runs"}
          {onAcceptSuggested ? " · tap ＋ to add" : ` · +${suggestedLF} LF`}
        </div>
      )}
    </div>
  );
}

/** Compact LF pill, offset perpendicular to the run and away from the roof
 *  centroid so labels sit outside the outline instead of crossing it. */
function EaveLabel({
  line,
  pxPerFt,
  centroid,
}: {
  line: SimpleLine;
  pxPerFt: number;
  centroid: Pt;
}) {
  if (line.points.length < 2) return null;
  const len = Math.round(polylineLengthFt(line.points, pxPerFt));
  if (len < LABEL_MIN_FT) return null;
  const a = line.points[0];
  const b = line.points[line.points.length - 1];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const norm = Math.hypot(dx, dy) || 1;
  let nx = (-dy / norm) * 12;
  let ny = (dx / norm) * 12;
  const cx = (a.x + b.x) / 2;
  const cy = (a.y + b.y) / 2;
  // Kick the label to the side away from the centroid.
  if ((cx - centroid.x) * nx + (cy - centroid.y) * ny < 0) {
    nx = -nx;
    ny = -ny;
  }
  const lx = cx + nx;
  const ly = cy + ny;
  const w = 42;
  return (
    <g pointerEvents="none">
      <rect x={lx - w / 2} y={ly - 8} width={w} height={16} rx={3.5} fill={C.paper} stroke={C.eave} strokeWidth={0.8} />
      <text
        x={lx}
        y={ly + 3.5}
        textAnchor="middle"
        fontSize={10}
        fontWeight={600}
        fill={C.eaveInk}
        fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
      >
        {len} ft
      </text>
    </g>
  );
}
