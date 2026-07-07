"use client";

import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { ChevronLeft, ChevronRight, RotateCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { COLOR_OPTIONS } from "@/lib/pricing";
import type { EstimateConfig } from "@/lib/types";

const ROTATE_STEP = 22; // degrees per arrow click
const SPIN_DPS = 36; // degrees per second when auto-spinning

const MATERIAL_BADGE: Record<
  EstimateConfig["material"],
  { label: string; ring: string; bg: string; text: string }
> = {
  aluminum: {
    label: "Aluminum",
    ring: "ring-zinc-300",
    bg: "bg-zinc-100",
    text: "text-zinc-700",
  },
  steel: {
    label: "Steel",
    ring: "ring-sky-300",
    bg: "bg-sky-50",
    text: "text-sky-700",
  },
  copper: {
    label: "Copper",
    ring: "ring-amber-300",
    bg: "bg-amber-50",
    text: "text-amber-800",
  },
};

/**
 * 3/4-perspective isometric preview of the gutter system. Switched
 * from a pure side elevation to a perspective view because the side
 * view made the gutter cross-section look like a faint curve — too
 * easy to mistake for "no design at all." Here we draw:
 *
 *   • A short run of the gutter as a 3D channel with a visible front
 *     face, top opening (parallelogram into perspective), and a cut
 *     end on the right that shows the K-style ogee or half-round
 *     cross-section.
 *   • A downspout that drops from the right end of the gutter,
 *     rendered as a 3D isometric prism: front face + right side depth
 *     face + top face. Box pipes (2×3 / 3×4) read as solid rectangles
 *     in perspective; round pipes (3″ / 4″) read as cylinders with
 *     elliptical top / band rings.
 *   • A clearly-rendered outlet hole on the gutter floor and the drop
 *     tube starting INSIDE the gutter, so the downspout visibly
 *     connects to the gutter.
 *   • Roof, fascia, siding, ground for context.
 *   • Accessories: drip edge, leaf guard mesh, heat tape, snow guards,
 *     rain chain (same toggles as before).
 *   • Cross-section badge in the corner explicitly draws the active
 *     downspout shape so a single glance confirms square vs round.
 */
export function GutterPreview({ config }: { config: EstimateConfig }) {
  const color = COLOR_OPTIONS.find((c) => c.id === config.color);
  const hex = color?.hex ?? "#f4f4f5";
  const mat = MATERIAL_BADGE[config.material];
  const acc = config.accessories;
  const halfRound = config.style === "half-round";

  // ─── ROTATION (Y-axis "turn around") ──────────────────────────
  // Wraps the SVG in a CSS perspective container and applies
  // rotateY. The geometry itself doesn't recompute — instead the
  // entire isometric scene tilts in 3D so the contractor can see the
  // front, cross-section side, and back faces by spinning. Arrow
  // buttons step ±ROTATE_STEP°; the spin button auto-rotates.
  const [angle, setAngle] = useState(0);
  const [spinning, setSpinning] = useState(false);
  const angleRef = useRef(angle);
  useEffect(() => {
    angleRef.current = angle;
  }, [angle]);
  useEffect(() => {
    if (!spinning) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      const next = (angleRef.current + dt * SPIN_DPS) % 360;
      angleRef.current = next;
      setAngle(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [spinning]);

  const turnLeft = () => {
    setSpinning(false);
    setAngle((a) => a - ROTATE_STEP);
  };
  const turnRight = () => {
    setSpinning(false);
    setAngle((a) => a + ROTATE_STEP);
  };
  const resetAngle = () => {
    setSpinning(false);
    setAngle(0);
  };
  const toggleSpin = () => setSpinning((s) => !s);

  // ─── GUTTER (3D run + cut end) ────────────────────────────────
  // The gutter sits horizontally across most of the preview. The
  // "length" makes the channel obvious as a channel. The cut-end on
  // the right is the K-style ogee or half-round profile.
  const gutterLeft = 90; // left end of the gutter run
  const gutterTop = 110; // top edge of the front face (where rim is)
  const gutterFrontH = halfRound ? 36 : 44; // height of the visible front face
  // Profile width (the "depth" into the scene). Bigger sizes get a
  // visibly bigger profile so 5 / 6 / 7 toggle is clearly perceived.
  const gutterDepth =
    config.size === "5" ? 34 : config.size === "6" ? 42 : 50;
  const gutterLen = 220; // horizontal length of the run
  const gutterRightX = gutterLeft + gutterLen; // X of the cut-end
  // Perspective offsets — the back of the gutter is up and to the
  // right of the front by these amounts. Gives the isometric feel.
  const perspX = gutterDepth * 0.55;
  const perspY = -gutterDepth * 0.55;

  // ─── DOWNSPOUT ────────────────────────────────────────────────
  const ds = config.downspoutSize;
  const dsRound = ds === "round-3" || ds === "round-4";
  const dsW = ds === "2x3" ? 30 : ds === "3x4" ? 38 : ds === "round-3" ? 32 : 40;
  const dsDepth = dsRound ? 0 : Math.max(10, dsW * 0.38);

  // Outlet sits about 80% along the gutter, on the front face.
  const outletCenterX = gutterLeft + gutterLen * 0.82;
  const outletY = gutterTop + gutterFrontH; // gutter floor (front face bottom)

  // Drop tube — top OVERLAPS into the gutter so the connection
  // visibly continues from gutter into downspout.
  const dropTop = outletY - 4;
  const dropBot = outletY + 22;
  // Offset elbow — jogs the run back toward the wall.
  const elbowBot = dropBot + 18;
  const jogX = 12;
  const runLeft = outletCenterX - dsW / 2 + jogX;
  const runTop = elbowBot;
  const runBot = 312;
  const kickBot = 340;

  const useRainChain = acc?.rainChain;
  const guardTier = acc?.guard ?? "none";

  // Helper: vertical pipe section with isometric depth on box pipes
  // and cylindrical shading on round pipes.
  const renderPipe = (x: number, y: number, w: number, h: number) => {
    if (dsRound) {
      return (
        <g>
          <rect x={x} y={y} width={w} height={h} fill={hex} />
          {/* Cylindrical shading */}
          <rect x={x} y={y} width={w * 0.2} height={h} fill="rgba(255,255,255,0.32)" />
          <rect x={x + w * 0.76} y={y} width={w * 0.24} height={h} fill="rgba(0,0,0,0.26)" />
          <rect x={x} y={y} width={w} height={h} fill="none" stroke="rgba(0,0,0,0.55)" strokeWidth="1" />
        </g>
      );
    }
    return (
      <g>
        {/* Front face */}
        <rect x={x} y={y} width={w} height={h} fill={hex} />
        {/* Matte highlight */}
        <rect x={x} y={y} width={w} height={h * 0.32} fill="rgba(255,255,255,0.18)" />
        {/* Right depth face */}
        <rect x={x + w} y={y} width={dsDepth} height={h} fill={hex} />
        <rect x={x + w} y={y} width={dsDepth} height={h} fill="rgba(0,0,0,0.35)" />
        {/* Outlines */}
        <rect x={x} y={y} width={w + dsDepth} height={h} fill="none" stroke="rgba(0,0,0,0.55)" strokeWidth="1" />
        <line x1={x + w} y1={y} x2={x + w} y2={y + h} stroke="rgba(0,0,0,0.45)" strokeWidth="0.7" />
      </g>
    );
  };

  // The K-style cross-section path (used for the right cut-end).
  // Drawn relative to (0,0); we translate it into place.
  const ogeePath = (W: number, H: number) =>
    `M 0 0
     L 0 ${H - 6}
     Q 0 ${H} 6 ${H}
     L ${W - 14} ${H}
     Q ${W - 2} ${H} ${W + 3} ${H - 12}
     C ${W + 9} ${H * 0.6} ${W - 8} ${H * 0.4} ${W - 2} 8
     Q ${W - 3} 0 ${W - 12} 0
     Z`;

  return (
    <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm">
      <div className="flex items-center justify-between gap-2 border-b border-zinc-100 bg-white/70 px-3 py-2 backdrop-blur">
        <div className="font-label text-[10px] text-zinc-500">
          Live preview
        </div>
        <div className="flex items-center gap-2">
          <div className="inline-flex items-center gap-0.5 rounded-full border border-zinc-200 bg-white p-0.5 shadow-sm">
            <button
              type="button"
              onClick={turnLeft}
              title="Turn left"
              aria-label="Turn left"
              className="inline-flex h-6 w-6 items-center justify-center rounded-full text-zinc-600 transition hover:bg-zinc-100 hover:text-zinc-900"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={toggleSpin}
              onDoubleClick={resetAngle}
              title={spinning ? "Stop spin (dbl-click to reset)" : "Auto-spin (dbl-click to reset)"}
              aria-label={spinning ? "Stop spin" : "Auto-spin"}
              aria-pressed={spinning}
              className={cn(
                "inline-flex h-6 w-6 items-center justify-center rounded-full transition",
                spinning
                  ? "bg-accent-600 text-white shadow-sm"
                  : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900",
              )}
            >
              <RotateCw
                className={cn("h-3.5 w-3.5", spinning && "animate-spin")}
              />
            </button>
            <button
              type="button"
              onClick={turnRight}
              title="Turn right"
              aria-label="Turn right"
              className="inline-flex h-6 w-6 items-center justify-center rounded-full text-zinc-600 transition hover:bg-zinc-100 hover:text-zinc-900"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
          <div
            className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ring-inset ${mat.bg} ${mat.text} ${mat.ring}`}
          >
            <span
              className="h-2 w-2 rounded-full ring-1 ring-inset ring-white/40"
              style={{ background: hex }}
            />
            {config.size}″ {halfRound ? "Half-Round" : "K-Style"} · {mat.label}
          </div>
        </div>
      </div>

      <div
        className="relative w-full"
        style={{ perspective: "1400px" }}
      >
        <motion.svg
          key={`${config.size}-${config.style}-${config.color}-${config.material}-${ds}-${guardTier}-${acc?.dripEdge}-${acc?.heatTape}-${acc?.iceGuard}-${useRainChain}`}
          viewBox="0 0 500 360"
          className="block h-72 w-full"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1, rotateY: angle }}
          transition={{
            opacity: { duration: 0.25 },
            rotateY: spinning
              ? { duration: 0 }
              : { type: "spring", damping: 22, stiffness: 160 },
          }}
          style={{
            transformStyle: "preserve-3d",
            transformOrigin: "50% 60%",
            willChange: "transform",
          }}
          aria-hidden
        >
          <defs>
            <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#bae6fd" />
              <stop offset="100%" stopColor="#f1f5f9" />
            </linearGradient>
            <linearGradient id="roof" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#334155" />
              <stop offset="100%" stopColor="#1e293b" />
            </linearGradient>
            <linearGradient id="fascia" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#fafafa" />
              <stop offset="100%" stopColor="#cbd5e1" />
            </linearGradient>
            <linearGradient id="siding" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#e7e5e4" />
              <stop offset="100%" stopColor="#a8a29e" />
            </linearGradient>
            {/* Top of the gutter looks brighter (catching sky) than the
                front face. Used on the top-opening parallelogram. */}
            <linearGradient id="gutter-top" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="rgba(0,0,0,0.6)" />
              <stop offset="100%" stopColor="rgba(0,0,0,0.32)" />
            </linearGradient>
            <linearGradient id="gutter-sheen" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="rgba(255,255,255,0.5)" />
              <stop offset="50%" stopColor="rgba(255,255,255,0)" />
              <stop offset="100%" stopColor="rgba(0,0,0,0.22)" />
            </linearGradient>
            <linearGradient id="ds-sheen" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="rgba(255,255,255,0.4)" />
              <stop offset="50%" stopColor="rgba(255,255,255,0)" />
              <stop offset="100%" stopColor="rgba(0,0,0,0.22)" />
            </linearGradient>
            <linearGradient id="drip-edge" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={hex} />
              <stop offset="100%" stopColor="rgba(0,0,0,0.15)" />
            </linearGradient>
            <pattern id="guard-screen" width="6" height="6" patternUnits="userSpaceOnUse">
              <rect width="6" height="6" fill="rgba(255,255,255,0.0)" />
              <line x1="0" y1="0" x2="6" y2="0" stroke="rgba(0,0,0,0.55)" strokeWidth="0.6" />
              <line x1="0" y1="0" x2="0" y2="6" stroke="rgba(0,0,0,0.55)" strokeWidth="0.6" />
            </pattern>
            <pattern id="guard-mesh" width="3.5" height="3.5" patternUnits="userSpaceOnUse">
              <rect width="3.5" height="3.5" fill="rgba(255,255,255,0.0)" />
              <line x1="0" y1="0" x2="3.5" y2="0" stroke="rgba(0,0,0,0.6)" strokeWidth="0.4" />
              <line x1="0" y1="0" x2="0" y2="3.5" stroke="rgba(0,0,0,0.6)" strokeWidth="0.4" />
            </pattern>
            <pattern id="guard-micro" width="2" height="2" patternUnits="userSpaceOnUse">
              <rect width="2" height="2" fill="rgba(255,255,255,0.0)" />
              <circle cx="1" cy="1" r="0.5" fill="rgba(0,0,0,0.7)" />
            </pattern>
            <filter id="soft-shadow" x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur in="SourceAlpha" stdDeviation="2" />
              <feOffset dx="0" dy="3" />
              <feComponentTransfer>
                <feFuncA type="linear" slope="0.34" />
              </feComponentTransfer>
              <feMerge>
                <feMergeNode />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {/* Sky + sun */}
          <rect x="0" y="0" width="500" height="360" fill="url(#sky)" />
          <circle cx="68" cy="46" r="34" fill="rgba(254,243,199,0.65)" />
          <circle cx="68" cy="46" r="18" fill="rgba(253,224,71,0.55)" />

          {/* Roof slope coming down from upper-left to just behind the
              gutter back-top. Drawn as a thick rotated slab so it
              reads as roof, not as a stick. */}
          {(() => {
            const roofStartX = 30;
            const roofStartY = 18;
            const roofEndX = gutterLeft + perspX + 6;
            const roofEndY = gutterTop + perspY - 4;
            const roofThick = 16;
            const dx = roofEndX - roofStartX;
            const dy = roofEndY - roofStartY;
            const len = Math.hypot(dx, dy) || 1;
            const nx = -dy / len;
            const ny = dx / len;
            const p1 = `${roofStartX},${roofStartY}`;
            const p2 = `${roofEndX},${roofEndY}`;
            const p3 = `${roofEndX + nx * roofThick},${roofEndY + ny * roofThick}`;
            const p4 = `${roofStartX + nx * roofThick},${roofStartY + ny * roofThick}`;
            const shingleCount = 12;
            return (
              <g>
                <polygon points={`${p1} ${p2} ${p3} ${p4}`} fill="url(#roof)" />
                {Array.from({ length: shingleCount }, (_, i) => {
                  const t = (i + 1) / (shingleCount + 1);
                  const sx = roofStartX + dx * t;
                  const sy = roofStartY + dy * t;
                  return (
                    <line
                      key={`tab-${i}`}
                      x1={sx}
                      y1={sy}
                      x2={sx + nx * 6}
                      y2={sy + ny * 6}
                      stroke="rgba(0,0,0,0.6)"
                      strokeWidth="0.8"
                    />
                  );
                })}
                <line
                  x1={roofStartX}
                  y1={roofStartY}
                  x2={roofEndX}
                  y2={roofEndY}
                  stroke="rgba(255,255,255,0.22)"
                  strokeWidth="1"
                />
                {acc?.iceGuard &&
                  Array.from({ length: 5 }, (_, i) => {
                    const t = 0.2 + i * 0.14;
                    const cx = roofStartX + dx * t;
                    const cy = roofStartY + dy * t;
                    const gxg = cx - nx * 2;
                    const gyg = cy - ny * 2;
                    return (
                      <polygon
                        key={`ice-${i}`}
                        points={`${gxg - 4},${gyg} ${gxg + 4},${gyg} ${gxg - nx * 7},${gyg - ny * 7}`}
                        fill="#e2e8f0"
                        stroke="rgba(0,0,0,0.5)"
                        strokeWidth="0.6"
                      />
                    );
                  })}
              </g>
            );
          })()}

          {/* Fascia board behind the gutter — drawn as a long
              rectangle running the length of the gutter. */}
          <polygon
            points={`${gutterLeft - 4},${gutterTop - 6}
                     ${gutterRightX + 4},${gutterTop - 6}
                     ${gutterRightX + 4},${gutterTop + gutterFrontH + 50}
                     ${gutterLeft - 4},${gutterTop + gutterFrontH + 50}`}
            fill="url(#fascia)"
            stroke="rgba(0,0,0,0.25)"
            strokeWidth="0.8"
          />

          {/* Wall siding below the fascia */}
          <rect
            x={gutterLeft - 4}
            y={gutterTop + gutterFrontH + 46}
            width={gutterRightX - gutterLeft + 8 + 60}
            height="120"
            fill="url(#siding)"
          />
          {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
            <line
              key={`siding-${i}`}
              x1={gutterLeft - 4}
              y1={gutterTop + gutterFrontH + 58 + i * 14}
              x2={gutterRightX + 64}
              y2={gutterTop + gutterFrontH + 58 + i * 14}
              stroke="rgba(0,0,0,0.22)"
              strokeWidth="0.7"
            />
          ))}

          {/* Drip edge tucked between roof + gutter back */}
          {acc?.dripEdge && (
            <g filter="url(#soft-shadow)">
              <polygon
                points={`${gutterLeft + perspX - 8},${gutterTop + perspY - 6}
                         ${gutterRightX + perspX - 8},${gutterTop + perspY - 6}
                         ${gutterRightX + perspX + 4},${gutterTop + perspY + 8}
                         ${gutterLeft + perspX + 4},${gutterTop + perspY + 8}`}
                fill="url(#drip-edge)"
                stroke="rgba(0,0,0,0.35)"
                strokeWidth="0.8"
              />
            </g>
          )}

          {/* ───── GUTTER 3D ASSEMBLY ───── */}
          <g filter="url(#soft-shadow)">
            {/* (a) TOP OPENING — parallelogram receding into the
                   distance. This is what most clearly says "gutter":
                   the dark trough you can see down INTO from above. */}
            <polygon
              points={`${gutterLeft},${gutterTop}
                       ${gutterRightX},${gutterTop}
                       ${gutterRightX + perspX},${gutterTop + perspY}
                       ${gutterLeft + perspX},${gutterTop + perspY}`}
              fill="url(#gutter-top)"
              stroke="rgba(0,0,0,0.55)"
              strokeWidth="1"
            />
            {/* Optional leaf-guard mesh stretched across the opening */}
            {guardTier !== "none" && (
              <polygon
                points={`${gutterLeft + 2},${gutterTop + 2}
                         ${gutterRightX - 2},${gutterTop + 2}
                         ${gutterRightX - 2 + perspX},${gutterTop + 2 + perspY}
                         ${gutterLeft + 2 + perspX},${gutterTop + 2 + perspY}`}
                fill={
                  guardTier === "screen"
                    ? "url(#guard-screen)"
                    : guardTier === "mesh"
                      ? "url(#guard-mesh)"
                      : "url(#guard-micro)"
                }
                stroke="rgba(0,0,0,0.45)"
                strokeWidth="0.6"
              />
            )}

            {/* (b) FRONT FACE of the gutter run — long ogee profile
                   shown as a single horizontal band the color of the
                   gutter, with a subtle vertical sheen. For half-round
                   the visual front face is the bottom-half of a circle
                   extruded along the length. Same band, different
                   bottom contour. */}
            <path
              d={
                halfRound
                  ? `M ${gutterLeft} ${gutterTop}
                     L ${gutterRightX} ${gutterTop}
                     Q ${gutterRightX + 4} ${gutterTop + gutterFrontH / 2} ${gutterRightX} ${gutterTop + gutterFrontH}
                     Q ${(gutterLeft + gutterRightX) / 2} ${gutterTop + gutterFrontH + 4} ${gutterLeft} ${gutterTop + gutterFrontH}
                     Q ${gutterLeft - 4} ${gutterTop + gutterFrontH / 2} ${gutterLeft} ${gutterTop} Z`
                  : `M ${gutterLeft} ${gutterTop}
                     L ${gutterRightX} ${gutterTop}
                     L ${gutterRightX} ${gutterTop + 8}
                     C ${gutterRightX - 2} ${gutterTop + gutterFrontH * 0.5} ${gutterRightX + 6} ${gutterTop + gutterFrontH * 0.7} ${gutterRightX} ${gutterTop + gutterFrontH - 4}
                     L ${gutterRightX - 6} ${gutterTop + gutterFrontH}
                     L ${gutterLeft + 6} ${gutterTop + gutterFrontH}
                     L ${gutterLeft} ${gutterTop + gutterFrontH - 4}
                     C ${gutterLeft + 6} ${gutterTop + gutterFrontH * 0.7} ${gutterLeft - 2} ${gutterTop + gutterFrontH * 0.5} ${gutterLeft} ${gutterTop + 8}
                     Z`
              }
              fill={hex}
              stroke="rgba(0,0,0,0.55)"
              strokeWidth="1"
            />
            {/* Sheen on front face */}
            <rect
              x={gutterLeft}
              y={gutterTop}
              width={gutterLen}
              height={gutterFrontH}
              fill="url(#gutter-sheen)"
              pointerEvents="none"
            />

            {/* (c) CUT END (right side) — the actual profile. K-style
                   ogee or half-round, drawn at the right edge of the
                   gutter run so the contractor sees the actual
                   cross-section. */}
            {halfRound ? (
              (() => {
                const r = gutterDepth / 2;
                const cx = gutterRightX + perspX / 2;
                const cy = gutterTop + perspY / 2 + r * 0.1;
                return (
                  <>
                    <ellipse
                      cx={cx}
                      cy={cy}
                      rx={r * 1.05}
                      ry={r * 0.5}
                      fill={hex}
                      stroke="rgba(0,0,0,0.55)"
                      strokeWidth="1"
                    />
                    {/* Inner dark cavity */}
                    <ellipse
                      cx={cx}
                      cy={cy - 1}
                      rx={r * 0.85}
                      ry={r * 0.36}
                      fill="rgba(0,0,0,0.4)"
                    />
                  </>
                );
              })()
            ) : (
              <g transform={`translate(${gutterRightX}, ${gutterTop})`}>
                <path
                  d={ogeePath(gutterDepth, gutterFrontH)}
                  fill={hex}
                  stroke="rgba(0,0,0,0.55)"
                  strokeWidth="1"
                />
                <path d={ogeePath(gutterDepth, gutterFrontH)} fill="url(#gutter-sheen)" />
              </g>
            )}

            {/* (d) HANGER bracket clipped to the back wall — a small
                   visible mounting clip every 24" feels right and
                   sells the gutter as "really attached to fascia." */}
            {Array.from(
              { length: Math.max(2, Math.floor(gutterLen / 70)) },
              (_, i) => {
                const t = (i + 0.5) / Math.max(2, Math.floor(gutterLen / 70));
                const cx = gutterLeft + gutterLen * t;
                return (
                  <g key={`hanger-${i}`}>
                    {/* The screw + bracket sits at the back of the
                        opening, so on the receding edge of the top
                        parallelogram. */}
                    <line
                      x1={cx + perspX * 0.6}
                      y1={gutterTop + perspY * 0.6}
                      x2={cx + perspX}
                      y2={gutterTop + perspY}
                      stroke="rgba(0,0,0,0.6)"
                      strokeWidth="1.4"
                    />
                    <circle
                      cx={cx + perspX}
                      cy={gutterTop + perspY}
                      r="1.4"
                      fill="rgba(0,0,0,0.7)"
                    />
                  </g>
                );
              },
            )}
          </g>

          {/* Heat-tape cable loops inside the trough */}
          {acc?.heatTape && (
            <path
              d={`M ${gutterLeft + 12} ${gutterTop + perspY * 0.35}
                  Q ${gutterLeft + gutterLen * 0.25} ${gutterTop + perspY * 0.7}
                    ${gutterLeft + gutterLen * 0.5} ${gutterTop + perspY * 0.35}
                  Q ${gutterLeft + gutterLen * 0.75} ${gutterTop + perspY * 0.7}
                    ${gutterRightX - 12} ${gutterTop + perspY * 0.35}`}
              fill="none"
              stroke="#dc2626"
              strokeWidth="1.8"
              strokeLinecap="round"
              opacity="0.95"
            />
          )}

          {/* ───── DOWNSPOUT or RAIN CHAIN ───── */}
          {useRainChain ? (
            <g>
              {Array.from({ length: 10 }, (_, i) => {
                const cy = outletY + 10 + i * 18;
                return (
                  <g key={`chain-${i}`}>
                    <path
                      d={`M ${outletCenterX - 6} ${cy} Q ${outletCenterX} ${cy + 10} ${outletCenterX + 6} ${cy} Z`}
                      fill="#b87333"
                      stroke="rgba(0,0,0,0.4)"
                      strokeWidth="0.6"
                    />
                    <line
                      x1={outletCenterX}
                      y1={cy + 8}
                      x2={outletCenterX}
                      y2={cy + 18}
                      stroke="#b87333"
                      strokeWidth="1.3"
                    />
                  </g>
                );
              })}
            </g>
          ) : (
            <g filter="url(#soft-shadow)">
              {/* OUTLET HOLE — dark ellipse / rect punched into the
                  gutter floor. Drawn so the drop tube clearly comes
                  from INSIDE the gutter. */}
              {dsRound ? (
                <ellipse
                  cx={outletCenterX}
                  cy={outletY - 1}
                  rx={dsW / 2 + 3}
                  ry="4"
                  fill="rgba(0,0,0,0.7)"
                />
              ) : (
                <rect
                  x={outletCenterX - dsW / 2 - 3}
                  y={outletY - 3}
                  width={dsW + 6}
                  height="6"
                  fill="rgba(0,0,0,0.7)"
                  rx="1"
                />
              )}

              {/* 1. DROP TUBE — top overlaps INTO the gutter via
                     dropTop = outletY - 4. */}
              {renderPipe(outletCenterX - dsW / 2, dropTop, dsW, dropBot - dropTop)}

              {/* 2. OFFSET ELBOW — parallelogram front + side */}
              <polygon
                points={`${outletCenterX - dsW / 2},${dropBot}
                         ${outletCenterX + dsW / 2},${dropBot}
                         ${runLeft + dsW},${elbowBot}
                         ${runLeft},${elbowBot}`}
                fill={hex}
                stroke="rgba(0,0,0,0.55)"
                strokeWidth="1"
              />
              <polygon
                points={`${outletCenterX - dsW / 2},${dropBot}
                         ${outletCenterX + dsW / 2},${dropBot}
                         ${runLeft + dsW},${elbowBot}
                         ${runLeft},${elbowBot}`}
                fill="url(#ds-sheen)"
              />
              {!dsRound && (
                <polygon
                  points={`${outletCenterX + dsW / 2},${dropBot}
                           ${outletCenterX + dsW / 2 + dsDepth},${dropBot}
                           ${runLeft + dsW + dsDepth},${elbowBot}
                           ${runLeft + dsW},${elbowBot}`}
                  fill={hex}
                  stroke="rgba(0,0,0,0.55)"
                  strokeWidth="0.7"
                />
              )}
              {!dsRound && (
                <polygon
                  points={`${outletCenterX + dsW / 2},${dropBot}
                           ${outletCenterX + dsW / 2 + dsDepth},${dropBot}
                           ${runLeft + dsW + dsDepth},${elbowBot}
                           ${runLeft + dsW},${elbowBot}`}
                  fill="rgba(0,0,0,0.35)"
                />
              )}

              {/* 3. VERTICAL RUN */}
              {renderPipe(runLeft, runTop, dsW, runBot - runTop)}

              {/* Top face of the vertical run — parallelogram for
                  square pipes, ellipse for round. This is the single
                  most useful indicator of "the pipe is actually
                  square" because the eye sees the shape directly. */}
              {dsRound ? (
                <ellipse
                  cx={runLeft + dsW / 2}
                  cy={runTop}
                  rx={dsW / 2 - 0.5}
                  ry="3"
                  fill="rgba(0,0,0,0.45)"
                  stroke="rgba(0,0,0,0.55)"
                  strokeWidth="0.7"
                />
              ) : (
                <polygon
                  points={`${runLeft},${runTop} ${runLeft + dsW},${runTop} ${runLeft + dsW + dsDepth},${runTop - dsDepth * 0.65} ${runLeft + dsDepth},${runTop - dsDepth * 0.65}`}
                  fill="rgba(0,0,0,0.45)"
                  stroke="rgba(0,0,0,0.55)"
                  strokeWidth="0.7"
                />
              )}

              {/* Round → bands. Box → wall straps. */}
              {dsRound
                ? [0.18, 0.5, 0.82].map((t, i) => (
                    <ellipse
                      key={`ring-${i}`}
                      cx={runLeft + dsW / 2}
                      cy={runTop + (runBot - runTop) * t}
                      rx={dsW / 2 + 2}
                      ry="3"
                      fill="none"
                      stroke="rgba(0,0,0,0.5)"
                      strokeWidth="1"
                    />
                  ))
                : [0.2, 0.55, 0.85].map((t, i) => {
                    const strapY = runTop + (runBot - runTop) * t - 1;
                    return (
                      <g key={`strap-${i}`}>
                        <rect
                          x={runLeft - 5}
                          y={strapY}
                          width={dsW + dsDepth + 10}
                          height="3"
                          fill="rgba(0,0,0,0.45)"
                        />
                        <rect
                          x={runLeft - 5}
                          y={strapY}
                          width="3"
                          height="3"
                          fill="rgba(0,0,0,0.65)"
                        />
                      </g>
                    );
                  })}

              {/* Front-face crimp seams on box pipes */}
              {!dsRound &&
                [0.33, 0.67].map((t, i) => (
                  <line
                    key={`crimp-${i}`}
                    x1={runLeft + 1}
                    y1={runTop + (runBot - runTop) * t}
                    x2={runLeft + dsW - 1}
                    y2={runTop + (runBot - runTop) * t}
                    stroke="rgba(0,0,0,0.22)"
                    strokeWidth="0.5"
                  />
                ))}

              {/* 4. KICK-OUT ELBOW with open mouth showing
                     cross-section (rectangle for box, ellipse for round). */}
              <polygon
                points={`${runLeft},${runBot}
                         ${runLeft + dsW},${runBot}
                         ${runLeft + dsW + 16},${kickBot}
                         ${runLeft + 16},${kickBot}`}
                fill={hex}
                stroke="rgba(0,0,0,0.55)"
                strokeWidth="1"
              />
              <polygon
                points={`${runLeft},${runBot}
                         ${runLeft + dsW},${runBot}
                         ${runLeft + dsW + 16},${kickBot}
                         ${runLeft + 16},${kickBot}`}
                fill="url(#ds-sheen)"
              />
              {!dsRound && (
                <>
                  <polygon
                    points={`${runLeft + dsW},${runBot}
                             ${runLeft + dsW + dsDepth},${runBot}
                             ${runLeft + dsW + 16 + dsDepth},${kickBot}
                             ${runLeft + dsW + 16},${kickBot}`}
                    fill={hex}
                    stroke="rgba(0,0,0,0.55)"
                    strokeWidth="0.7"
                  />
                  <polygon
                    points={`${runLeft + dsW},${runBot}
                             ${runLeft + dsW + dsDepth},${runBot}
                             ${runLeft + dsW + 16 + dsDepth},${kickBot}
                             ${runLeft + dsW + 16},${kickBot}`}
                    fill="rgba(0,0,0,0.35)"
                  />
                </>
              )}
              {/* Open mouth at the kick-out tip */}
              {dsRound ? (
                <ellipse
                  cx={runLeft + 16 + dsW / 2}
                  cy={kickBot}
                  rx={dsW / 2 - 1}
                  ry="3"
                  fill="rgba(0,0,0,0.75)"
                  stroke="rgba(0,0,0,0.6)"
                  strokeWidth="0.6"
                />
              ) : (
                <polygon
                  points={`${runLeft + 16},${kickBot}
                           ${runLeft + 16 + dsW},${kickBot}
                           ${runLeft + 16 + dsW + dsDepth * 0.7},${kickBot - dsDepth * 0.55}
                           ${runLeft + 16 + dsDepth * 0.7},${kickBot - dsDepth * 0.55}`}
                  fill="rgba(0,0,0,0.7)"
                  stroke="rgba(0,0,0,0.6)"
                  strokeWidth="0.6"
                />
              )}
            </g>
          )}

          {/* Ground / grass */}
          <rect x="0" y="344" width="500" height="16" fill="#86efac" opacity="0.55" />
          <line x1="0" y1="344" x2="500" y2="344" stroke="rgba(0,0,0,0.2)" strokeWidth="0.6" />
          {Array.from({ length: 24 }, (_, i) => (
            <line
              key={`grass-${i}`}
              x1={i * 21 + 4}
              y1="344"
              x2={i * 21 + 6}
              y2="340"
              stroke="rgba(22,101,52,0.5)"
              strokeWidth="0.7"
            />
          ))}

          {/* Cross-section badge — explicit shape indicator */}
          {!useRainChain && (
            <g transform="translate(452, 60)">
              <rect
                x="-32"
                y="-30"
                width="64"
                height="62"
                rx="8"
                fill="rgba(255,255,255,0.95)"
                stroke="rgba(0,0,0,0.2)"
                strokeWidth="1"
              />
              <text
                x="0"
                y="-18"
                textAnchor="middle"
                fontSize="6"
                fontWeight="700"
                fill="rgba(0,0,0,0.55)"
                letterSpacing="0.6"
              >
                CROSS-SECTION
              </text>
              {dsRound ? (
                <circle
                  cx="0"
                  cy="4"
                  r={ds === "round-3" ? 9 : 12}
                  fill={hex}
                  stroke="rgba(0,0,0,0.55)"
                  strokeWidth="1.2"
                />
              ) : (
                <rect
                  x={ds === "2x3" ? -6 : -8}
                  y={ds === "2x3" ? -8 : -10}
                  width={ds === "2x3" ? 12 : 16}
                  height={ds === "2x3" ? 20 : 24}
                  fill={hex}
                  stroke="rgba(0,0,0,0.55)"
                  strokeWidth="1.2"
                  rx="0.5"
                />
              )}
              <text
                x="0"
                y={26}
                textAnchor="middle"
                fontSize="8"
                fontWeight="600"
                fill="#0f172a"
              >
                {ds === "2x3"
                  ? "2×3″"
                  : ds === "3x4"
                    ? "3×4″"
                    : ds === "round-3"
                      ? "3″ round"
                      : "4″ round"}
              </text>
            </g>
          )}

          {/* Gutter callout */}
          <g>
            <line
              x1={gutterLeft + gutterLen * 0.4 + perspX * 0.5}
              y1={gutterTop + perspY * 0.5}
              x2={gutterLeft + gutterLen * 0.5}
              y2={gutterTop + perspY - 30}
              stroke="rgba(0,0,0,0.45)"
              strokeWidth="0.7"
            />
            <rect
              x={gutterLeft + gutterLen * 0.5 - 50}
              y={gutterTop + perspY - 50}
              width="100"
              height="22"
              rx="5"
              fill="rgba(255,255,255,0.95)"
              stroke="rgba(0,0,0,0.18)"
            />
            <text
              x={gutterLeft + gutterLen * 0.5}
              y={gutterTop + perspY - 34}
              textAnchor="middle"
              fontSize="10"
              fontFamily="ui-sans-serif, system-ui"
              fill="#0f172a"
              fontWeight="700"
            >
              {config.size}″ {halfRound ? "Half-Round" : "K-Style"}
            </text>
          </g>

          {/* Downspout callout */}
          {!useRainChain && (
            <g>
              <line
                x1={runLeft + dsW + dsDepth + 4}
                y1={(runTop + runBot) / 2}
                x2={runLeft + dsW + dsDepth + 50}
                y2={(runTop + runBot) / 2 - 16}
                stroke="rgba(0,0,0,0.45)"
                strokeWidth="0.7"
              />
              <rect
                x={runLeft + dsW + dsDepth + 48}
                y={(runTop + runBot) / 2 - 28}
                width="96"
                height="22"
                rx="5"
                fill="rgba(255,255,255,0.95)"
                stroke="rgba(0,0,0,0.18)"
              />
              <text
                x={runLeft + dsW + dsDepth + 96}
                y={(runTop + runBot) / 2 - 13}
                textAnchor="middle"
                fontSize="10"
                fontFamily="ui-sans-serif, system-ui"
                fill="#0f172a"
                fontWeight="700"
              >
                {ds === "2x3"
                  ? "2×3″ downspout"
                  : ds === "3x4"
                    ? "3×4″ downspout"
                    : ds === "round-3"
                      ? "3″ round"
                      : "4″ round"}
              </text>
            </g>
          )}

          {/* Rain-chain callout */}
          {useRainChain && (
            <g>
              <line
                x1={outletCenterX + 8}
                y1={260}
                x2={outletCenterX + 70}
                y2={236}
                stroke="rgba(0,0,0,0.5)"
                strokeWidth="0.7"
              />
              <rect
                x={outletCenterX + 60}
                y={222}
                width="100"
                height="22"
                rx="5"
                fill="rgba(255,255,255,0.95)"
                stroke="rgba(0,0,0,0.18)"
              />
              <text
                x={outletCenterX + 110}
                y={238}
                textAnchor="middle"
                fontSize="10"
                fontFamily="ui-sans-serif, system-ui"
                fill="#0f172a"
                fontWeight="700"
              >
                Copper rain chain
              </text>
            </g>
          )}
        </motion.svg>

        <div className="absolute bottom-2 right-3 inline-flex items-center gap-1.5 rounded-full bg-white/85 px-2 py-0.5 text-[10px] font-medium text-zinc-700 shadow-sm ring-1 ring-inset ring-zinc-200">
          <span
            className="h-2 w-2 rounded-full ring-1 ring-inset ring-white/50"
            style={{ background: hex }}
          />
          {color?.name ?? "Custom color"}
        </div>
        <div className="absolute bottom-2 left-3 inline-flex items-center gap-1.5 rounded-full bg-white/85 px-2 py-0.5 text-[10px] font-medium text-zinc-700 shadow-sm ring-1 ring-inset ring-zinc-200">
          3/4 perspective · approx scale
          {angle !== 0 && (
            <span className="text-zinc-500">
              · {Math.round(((angle % 360) + 540) % 360 - 180)}°
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
