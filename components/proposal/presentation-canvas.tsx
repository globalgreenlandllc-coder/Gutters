"use client";

import { useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  AerialImage,
  AerialBackground,
  BlueprintBackground,
  NeonDefs,
  VIEWBOX_W,
  VIEWBOX_H,
  pathFor,
  lineLengthFt,
} from "@/components/estimate/aerial-shared";
import type { Downspout, EditableLine } from "@/lib/types";

/**
 * Proposal-quality canvas. Same data shape as AerialCanvas but stripped
 * of the editor chrome:
 *   - No toolbar, no theme toggle, no layers panel.
 *   - Eaves render as a thin, even cyan stroke with a soft glow (no
 *     animated draw-in — clients see a finished drawing).
 *   - Rakes render as gray-dashed "no gutter" lines, also non-glowing.
 *   - Downspouts are small pinned dots — no pulsing halo. The pulse
 *     made sense in the editor as a "look here, AI placed this" cue;
 *     in the proposal it just creates visual chaos with 8+ markers.
 *   - LF labels show only on eaves ≥ 8 ft so short connector segments
 *     don't stack on top of each other; selected eaves always label.
 *   - Vertex handles fade in only when the eave is hovered or selected
 *     — so the drawing reads clean by default, but the contractor can
 *     still drag a corner to nudge it onto the real roof edge.
 */
export function PresentationCanvas({
  eaves,
  rakes = [],
  downspouts,
  onEavesChange,
  onDownspoutsChange,
  aerialImageUrl,
  planMode,
}: {
  eaves: EditableLine[];
  rakes?: EditableLine[];
  downspouts: Downspout[];
  /** Optional — when omitted, the canvas renders strictly read-only
   *  (no drag handles ever). Provide to allow vertex/downspout nudges. */
  onEavesChange?: (next: EditableLine[]) => void;
  onDownspoutsChange?: (next: Downspout[]) => void;
  aerialImageUrl?: string;
  /** Plan-based takeoffs use a drafting-paper background instead of
   *  the cartoon yard scene. The cartoon makes sense on satellite-
   *  derived estimates (it's a fallback when imagery didn't load) but
   *  is visually wrong on plan-based proposals — the gutter trace was
   *  extracted from architectural plans, not from a satellite tile, so
   *  drawing it on a cartoon roof looks fake. */
  planMode?: boolean;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const editable = !!(onEavesChange || onDownspoutsChange);
  const [drag, setDrag] = useState<
    | { kind: "vertex"; lineId: string; index: number }
    | { kind: "downspout"; id: string }
    | null
  >(null);

  const totalEaveLF = useMemo(
    () => Math.round(eaves.reduce((acc, l) => acc + lineLengthFt(l), 0)),
    [eaves],
  );

  function svgPoint(e: React.PointerEvent): { x: number; y: number } {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const transformed = pt.matrixTransform(ctm.inverse());
    return { x: transformed.x, y: transformed.y };
  }

  function handlePointerMove(e: React.PointerEvent) {
    if (!drag) return;
    const p = svgPoint(e);
    if (drag.kind === "vertex" && onEavesChange) {
      onEavesChange(
        eaves.map((l) =>
          l.id === drag.lineId
            ? {
                ...l,
                points: l.points.map((pt, i) => (i === drag.index ? p : pt)),
              }
            : l,
        ),
      );
    } else if (drag.kind === "downspout" && onDownspoutsChange) {
      onDownspoutsChange(
        downspouts.map((d) => (d.id === drag.id ? { ...d, x: p.x, y: p.y } : d)),
      );
    }
  }

  function handlePointerUp() {
    setDrag(null);
  }

  function handleBackgroundClick() {
    setSelectedId(null);
  }

  // Smart label gate: skip eaves shorter than 8 ft unless hovered or
  // selected. Keeps a clean look on roofs with many short connector
  // jogs (the existing canvas showed labels at 6 ft and they stacked).
  const LABEL_MIN_FT = 8;

  return (
    <div
      className={
        "relative h-full w-full overflow-hidden rounded-2xl ring-1 " +
        (planMode
          ? "bg-[#f7f4ee] ring-indigo-200/40"
          : "bg-slate-950 ring-slate-900/50")
      }
    >
      {/* Floating total — replaces the editor's busy Legend strip */}
      <div
        className={
          "pointer-events-none absolute right-3 top-3 z-10 flex items-center gap-2 rounded-full border px-3 py-1.5 text-[11px] font-medium shadow-card backdrop-blur " +
          (planMode
            ? "border-cyan-700/30 bg-[#f7f4ee]/85 text-cyan-900"
            : "border-cyan-500/30 bg-slate-950/80 text-cyan-100")
        }
      >
        <span
          className={
            planMode
              ? "inline-block h-1.5 w-3 rounded-full bg-cyan-700"
              : "inline-block h-1.5 w-3 rounded-full bg-cyan-400 shadow-[0_0_6px_rgba(0,229,255,0.9)]"
          }
        />
        <span className="tabular-nums">
          <span
            className={planMode ? "font-semibold text-slate-900" : "font-semibold text-white"}
          >
            {totalEaveLF}
          </span>{" "}
          LF
        </span>
        <span
          className={
            planMode ? "h-3 w-px bg-cyan-800/30" : "h-3 w-px bg-cyan-500/30"
          }
        />
        <span
          className={
            planMode
              ? "inline-block h-1.5 w-1.5 rounded-full bg-slate-900"
              : "inline-block h-1.5 w-1.5 rounded-full bg-fuchsia-400 shadow-[0_0_6px_rgba(255,43,214,0.9)]"
          }
        />
        <span className="tabular-nums">
          <span
            className={planMode ? "font-semibold text-slate-900" : "font-semibold text-white"}
          >
            {downspouts.length}
          </span>{" "}
          drops
        </span>
      </div>

      <svg
        ref={svgRef}
        viewBox={`0 0 ${VIEWBOX_W} ${VIEWBOX_H}`}
        preserveAspectRatio="xMidYMid slice"
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerDown={handleBackgroundClick}
        className="h-full w-full touch-none select-none"
        style={{ minHeight: 360 }}
      >
        <NeonDefs />
        {aerialImageUrl ? (
          <AerialImage imageDataUrl={aerialImageUrl} />
        ) : planMode ? (
          <BlueprintBackground />
        ) : (
          <AerialBackground />
        )}
        {/* Subtle scrim so cyan + pink pop against bright satellite
            imagery. Skipped in plan mode — the drafting-paper
            background is already light and a dark scrim on top would
            wash out the architectural feel. */}
        {!planMode && (
          <rect
            x={0}
            y={0}
            width={VIEWBOX_W}
            height={VIEWBOX_H}
            fill="rgba(2,6,23,0.32)"
            pointerEvents="none"
          />
        )}

        {/* Rakes — gray-dashed, low-opacity, non-interactive.
            On the drafting-paper plan background we use a darker
            indigo so the dashes stay legible on warm off-white. */}
        {rakes.map((line) => (
          <motion.path
            key={line.id}
            d={pathFor(line)}
            stroke={planMode ? "#1e3a8a" : "#94a3b8"}
            strokeWidth={1.75}
            strokeDasharray="5 4"
            strokeLinecap="round"
            fill="none"
            opacity={planMode ? 0.45 : 0.55}
            pointerEvents="none"
            initial={{ opacity: 0 }}
            animate={{ opacity: planMode ? 0.45 : 0.55 }}
            transition={{ duration: 0.4, delay: 0.1 }}
          />
        ))}

        {/* Eaves — clean stroke, soft glow, no draw-in animation */}
        {eaves.map((line) => {
          const isSelected = selectedId === line.id;
          const isHover = hoverId === line.id;
          const active = isSelected || isHover;
          return (
            <g key={line.id}>
              {/* Wider invisible hit area so hover/select is forgiving */}
              <path
                d={pathFor(line)}
                stroke="transparent"
                strokeWidth={18}
                fill="none"
                style={{ cursor: editable ? "pointer" : "default" }}
                onPointerEnter={() => setHoverId(line.id)}
                onPointerLeave={() =>
                  setHoverId((h) => (h === line.id ? null : h))
                }
                onPointerDown={(e) => {
                  if (!editable) return;
                  e.stopPropagation();
                  setSelectedId(line.id);
                }}
              />
              <motion.path
                d={pathFor(line)}
                stroke={
                  planMode
                    ? // Plan mode: architectural-ink palette. Saturated
                      // cyan/sky still reads as "gutter" but no glow —
                      // glows clip on print and look fake on paper.
                      active
                      ? "#0891b2"
                      : "#0e7490"
                    : active
                      ? "#a3f7ff"
                      : "#00e5ff"
                }
                strokeWidth={active ? 3.5 : 2.5}
                strokeLinecap="round"
                fill="none"
                pointerEvents="none"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.35 }}
                style={{
                  filter: planMode
                    ? undefined
                    : active
                      ? "drop-shadow(0 0 6px rgba(0,229,255,0.85))"
                      : "drop-shadow(0 0 3px rgba(0,229,255,0.55))",
                }}
              />

              {/* Vertex handles — only when hovered/selected */}
              {editable &&
                active &&
                line.points.map((pt, idx) => (
                  <motion.circle
                    key={idx}
                    cx={pt.x}
                    cy={pt.y}
                    r={5}
                    fill="#0b1220"
                    stroke="#a3f7ff"
                    strokeWidth={2}
                    initial={{ opacity: 0, scale: 0.5 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ duration: 0.15 }}
                    style={{ cursor: "grab" }}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      setDrag({ kind: "vertex", lineId: line.id, index: idx });
                    }}
                  />
                ))}

              <SegmentLabel
                line={line}
                emphasized={active}
                minFt={active ? 0 : LABEL_MIN_FT}
                planMode={planMode}
              />
            </g>
          );
        })}

        {/* Downspouts — small clean pins, no pulse halo */}
        {downspouts.map((d) => {
          const isSelected = selectedId === d.id;
          return (
            <g
              key={d.id}
              onPointerDown={(e) => {
                if (!editable) return;
                e.stopPropagation();
                setSelectedId(d.id);
                if (onDownspoutsChange) {
                  setDrag({ kind: "downspout", id: d.id });
                }
              }}
              style={{ cursor: editable ? "grab" : "default" }}
            >
              <motion.circle
                cx={d.x}
                cy={d.y}
                r={isSelected ? 7 : 5.5}
                fill={planMode ? "#0f172a" : "#ff2bd6"}
                stroke={planMode ? "#f7f4ee" : "white"}
                strokeWidth={planMode ? 2 : 1.8}
                initial={{ opacity: 0, scale: 0.6 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.25 }}
                style={{
                  filter: planMode
                    ? undefined
                    : "drop-shadow(0 0 4px rgba(255,43,214,0.7))",
                }}
              />
              <circle
                cx={d.x}
                cy={d.y}
                r={1.8}
                fill={planMode ? "#f7f4ee" : "#fff0fb"}
              />
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/**
 * Compact LF label. Always renders perpendicular to the eave so it
 * floats off the line rather than crossing it. Selected eaves get a
 * larger pill; unselected short eaves are skipped entirely.
 */
function SegmentLabel({
  line,
  emphasized,
  minFt,
  planMode,
}: {
  line: EditableLine;
  emphasized: boolean;
  minFt: number;
  planMode?: boolean;
}) {
  if (line.points.length < 2) return null;
  const a = line.points[0];
  const b = line.points[line.points.length - 1];
  const len = Math.round(lineLengthFt(line));
  if (len < minFt) return null;

  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const norm = Math.hypot(dx, dy) || 1;
  const offset = emphasized ? 14 : 10;
  const nx = (-dy / norm) * offset;
  const ny = (dx / norm) * offset;
  const cx = (a.x + b.x) / 2;
  const cy = (a.y + b.y) / 2;
  // Always offset away from canvas center so labels don't escape the
  // viewBox on corner eaves near the image edge.
  const towardCenter = (cx - VIEWBOX_W / 2) * nx + (cy - VIEWBOX_H / 2) * ny;
  const sign = towardCenter > 0 ? -1 : 1;
  const labelCx = cx + nx * sign;
  const labelCy = cy + ny * sign;

  const w = emphasized ? 52 : 38;
  const h = emphasized ? 18 : 14;
  const fontSize = emphasized ? 10 : 9;

  return (
    <motion.g
      pointerEvents="none"
      initial={{ opacity: 0, scale: 0.85 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.2, delay: 0.15 }}
    >
      <rect
        x={labelCx - w / 2}
        y={labelCy - h / 2}
        width={w}
        height={h}
        rx={emphasized ? 5 : 3.5}
        fill={planMode ? "#f7f4ee" : "rgba(2,6,23,0.85)"}
        stroke={
          planMode
            ? emphasized
              ? "#0e7490"
              : "rgba(14, 116, 144, 0.55)"
            : emphasized
              ? "#67e8f9"
              : "rgba(103,232,249,0.45)"
        }
        strokeWidth={emphasized ? 1.2 : 0.8}
      />
      <text
        x={labelCx}
        y={labelCy + (emphasized ? 3.5 : 3)}
        textAnchor="middle"
        fill={
          planMode
            ? emphasized
              ? "#155e75"
              : "#0e7490"
            : emphasized
              ? "#a5f3fc"
              : "#67e8f9"
        }
        fontSize={fontSize}
        fontWeight={600}
        fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
      >
        {len} ft
      </text>
    </motion.g>
  );
}
