"use client";

import { motion } from "framer-motion";
import { COLOR_OPTIONS } from "@/lib/pricing";
import type { EstimateConfig } from "@/lib/types";

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
 * Realistic side-elevation preview of the configured gutter system.
 * Drawn as a single SVG with layered scene elements so the homeowner
 * can see the whole assembly the way it'll sit on their house:
 *
 *   • Sloped roof with shingle courses at the top
 *   • Drip-edge flashing tucked between shingles and gutter (toggle)
 *   • Fascia board behind the gutter
 *   • Cross-section of the gutter — K-style or half-round — with the
 *     selected color filling both gutter and downspout
 *   • Outlet drop at the gutter floor + offset elbow above the
 *     downspout, so the pipe visibly connects to the gutter
 *   • Downspout running down past the wall siding to a kick-out elbow
 *     at the bottom
 *   • Leaf-protection mesh stretched across the open top when enabled
 *     (different patterns per guard tier: screen / mesh / micro-mesh)
 *   • Decorative copper rain chain hanging from the outlet when chosen
 *     in place of a regular downspout
 *   • Heat-tape cable looped along the inside of the gutter when on
 *     (red zig-zag pattern over the gutter floor)
 *   • Snow / ice guards as small triangles up the roof slope when on
 *
 * The geometry is roughly to-scale relative to size: a 7" gutter is
 * visibly wider than a 5" one, and a round downspout is a cylinder
 * vs the rectangular box for 2×3 / 3×4.
 */
export function GutterPreview({ config }: { config: EstimateConfig }) {
  const color = COLOR_OPTIONS.find((c) => c.id === config.color);
  const hex = color?.hex ?? "#f4f4f5";
  const mat = MATERIAL_BADGE[config.material];
  const acc = config.accessories;
  const halfRound = config.style === "half-round";

  // Gutter width drives the visual size of the cross-section + outlet
  // position. 5/6/7" → progressively wider.
  const gWidth = config.size === "5" ? 60 : config.size === "6" ? 74 : 90;
  const gHeight = halfRound ? gWidth / 2 + 4 : gWidth * 0.75;

  // Position the gutter so its mounting flange sits flush with the
  // fascia board. (320, 150) is the top-back corner of the gutter.
  const gX = 220;
  const gY = 145;
  const gOutletX = gX + gWidth * 0.78;
  const gOutletY = gY + gHeight;

  // Downspout sizing — round = cylinder, rectangular = box.
  const ds = config.downspoutSize;
  const dsWidth = ds === "2x3" ? 24 : ds === "3x4" ? 30 : ds === "round-3" ? 26 : 32;
  const dsRound = ds === "round-3" || ds === "round-4";
  const useRainChain = acc?.rainChain;
  const guardTier = acc?.guard ?? "none";

  return (
    <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm">
      <div className="flex items-center justify-between border-b border-zinc-100 bg-white/70 px-3 py-2 backdrop-blur">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
          Live preview
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

      <div className="relative w-full">
        <motion.svg
          key={`${config.size}-${config.style}-${config.color}-${config.material}-${ds}-${guardTier}-${acc?.dripEdge}-${acc?.heatTape}-${acc?.iceGuard}-${useRainChain}`}
          viewBox="0 0 500 360"
          className="block h-64 w-full"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.25 }}
          aria-hidden
        >
          <defs>
            {/* Sky gradient backdrop */}
            <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#e0f2fe" />
              <stop offset="100%" stopColor="#f8fafc" />
            </linearGradient>
            {/* Roof / shingle base */}
            <linearGradient id="roof" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#4b5563" />
              <stop offset="100%" stopColor="#374151" />
            </linearGradient>
            {/* Fascia board */}
            <linearGradient id="fascia" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#f1f5f9" />
              <stop offset="100%" stopColor="#cbd5e1" />
            </linearGradient>
            {/* Siding */}
            <linearGradient id="siding" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#e7e5e4" />
              <stop offset="100%" stopColor="#a8a29e" />
            </linearGradient>
            {/* Gutter sheen — used as overlay on the colored body */}
            <linearGradient id="gutter-sheen" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="rgba(255,255,255,0.55)" />
              <stop offset="40%" stopColor="rgba(255,255,255,0)" />
              <stop offset="100%" stopColor="rgba(0,0,0,0.22)" />
            </linearGradient>
            {/* Downspout sheen — left→right cylindrical */}
            <linearGradient id="ds-sheen" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="rgba(255,255,255,0.45)" />
              <stop offset="50%" stopColor="rgba(255,255,255,0)" />
              <stop offset="100%" stopColor="rgba(0,0,0,0.22)" />
            </linearGradient>
            {/* Drip edge — bright flashing */}
            <linearGradient id="drip-edge" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={hex} />
              <stop offset="100%" stopColor="rgba(0,0,0,0.15)" />
            </linearGradient>
            {/* Mesh / screen pattern for guards */}
            <pattern
              id="guard-screen"
              width="6"
              height="6"
              patternUnits="userSpaceOnUse"
            >
              <rect width="6" height="6" fill="rgba(255,255,255,0.0)" />
              <line x1="0" y1="0" x2="6" y2="0" stroke="rgba(0,0,0,0.5)" strokeWidth="0.6" />
              <line x1="0" y1="0" x2="0" y2="6" stroke="rgba(0,0,0,0.5)" strokeWidth="0.6" />
            </pattern>
            <pattern
              id="guard-mesh"
              width="3.5"
              height="3.5"
              patternUnits="userSpaceOnUse"
            >
              <rect width="3.5" height="3.5" fill="rgba(255,255,255,0.0)" />
              <line x1="0" y1="0" x2="3.5" y2="0" stroke="rgba(0,0,0,0.55)" strokeWidth="0.35" />
              <line x1="0" y1="0" x2="0" y2="3.5" stroke="rgba(0,0,0,0.55)" strokeWidth="0.35" />
            </pattern>
            <pattern
              id="guard-micro"
              width="2"
              height="2"
              patternUnits="userSpaceOnUse"
            >
              <rect width="2" height="2" fill="rgba(255,255,255,0.0)" />
              <circle cx="1" cy="1" r="0.45" fill="rgba(0,0,0,0.7)" />
            </pattern>
            <filter id="soft-shadow" x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur in="SourceAlpha" stdDeviation="2" />
              <feOffset dx="0" dy="3" />
              <feComponentTransfer>
                <feFuncA type="linear" slope="0.32" />
              </feComponentTransfer>
              <feMerge>
                <feMergeNode />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {/* Sky */}
          <rect x="0" y="0" width="500" height="360" fill="url(#sky)" />

          {/* Roof slope — ends just above the back of the gutter so it
              doesn't visually cover the gutter mouth. The eave edge is
              a tiny shingle overhang past the fascia + drip edge. */}
          {(() => {
            const roofStartX = 60;
            const roofStartY = 30;
            // Roof ends just above-and-behind the gutter's back wall.
            // gX is the back-top corner of the gutter; the shingle
            // overhang sticks out ~10px past the fascia.
            const roofEndX = gX + 10;
            const roofEndY = gY - 6;
            const roofThick = 12;
            // Perpendicular thickness vector pointing "down-into-roof".
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
                {/* Shingle course lines along the slope */}
                {Array.from({ length: shingleCount }, (_, i) => {
                  const t = (i + 1) / (shingleCount + 1);
                  const sx = roofStartX + dx * t;
                  const sy = roofStartY + dy * t;
                  return (
                    <line
                      key={`tab-${i}`}
                      x1={sx}
                      y1={sy}
                      x2={sx + nx * 4}
                      y2={sy + ny * 4}
                      stroke="rgba(0,0,0,0.55)"
                      strokeWidth="0.6"
                    />
                  );
                })}
                {/* Bottom edge highlight at the drip line */}
                <line
                  x1={roofStartX}
                  y1={roofStartY}
                  x2={roofEndX}
                  y2={roofEndY}
                  stroke="rgba(255,255,255,0.15)"
                  strokeWidth="0.8"
                />
                {/* Snow / ice guards along the slope */}
                {acc?.iceGuard &&
                  Array.from({ length: 5 }, (_, i) => {
                    const t = 0.2 + i * 0.14;
                    const cx = roofStartX + dx * t;
                    const cy = roofStartY + dy * t;
                    // The guard sits ON the roof surface — kick it up
                    // along the negative-normal so it pokes up out of
                    // the shingles instead of into them.
                    const gxg = cx - nx * 2;
                    const gyg = cy - ny * 2;
                    return (
                      <polygon
                        key={`ice-${i}`}
                        points={`${gxg - 4},${gyg} ${gxg + 4},${gyg} ${gxg - nx * 7},${gyg - ny * 7}`}
                        fill="#e2e8f0"
                        stroke="rgba(0,0,0,0.4)"
                        strokeWidth="0.5"
                      />
                    );
                  })}
              </g>
            );
          })()}

          {/* Fascia board — vertical face the gutter mounts to */}
          <rect
            x={gX - 14}
            y={gY - 4}
            width="12"
            height={gHeight + 40}
            fill="url(#fascia)"
            stroke="rgba(0,0,0,0.18)"
            strokeWidth="0.7"
          />

          {/* Wall siding below the fascia (visible behind the downspout) */}
          <rect
            x={gX - 14}
            y={gY + gHeight + 36}
            width="220"
            height="120"
            fill="url(#siding)"
          />
          {/* Siding course lines */}
          {[0, 1, 2, 3, 4, 5, 6].map((i) => (
            <line
              key={`siding-${i}`}
              x1={gX - 14}
              y1={gY + gHeight + 50 + i * 14}
              x2={gX + 206}
              y2={gY + gHeight + 50 + i * 14}
              stroke="rgba(0,0,0,0.18)"
              strokeWidth="0.6"
            />
          ))}

          {/* Drip edge — tucked between shingles and the back of the gutter */}
          {acc?.dripEdge && (
            <g filter="url(#soft-shadow)">
              <path
                d={`M ${gX - 8} ${gY - 6} L ${gX + 6} ${gY - 6} L ${gX + 6} ${gY + 8} L ${gX - 8} ${gY + 8} Z`}
                fill="url(#drip-edge)"
                stroke="rgba(0,0,0,0.25)"
                strokeWidth="0.6"
              />
              {/* The kicked-out lip that sticks into the gutter */}
              <path
                d={`M ${gX + 2} ${gY + 8} L ${gX + 14} ${gY + 14} L ${gX + 14} ${gY + 18} L ${gX + 2} ${gY + 12} Z`}
                fill={hex}
                opacity="0.95"
                stroke="rgba(0,0,0,0.3)"
                strokeWidth="0.5"
              />
            </g>
          )}

          {/* Gutter cross-section */}
          <g filter="url(#soft-shadow)">
            {halfRound ? (
              <>
                <path
                  d={`M ${gX} ${gY}
                      A ${gWidth / 2} ${gWidth / 2} 0 0 0 ${gX + gWidth} ${gY}
                      L ${gX + gWidth} ${gY + 6}
                      A ${gWidth / 2 - 4} ${gWidth / 2 - 4} 0 0 1 ${gX} ${gY + 6} Z`}
                  fill={hex}
                />
                <path
                  d={`M ${gX} ${gY}
                      A ${gWidth / 2} ${gWidth / 2} 0 0 0 ${gX + gWidth} ${gY}
                      L ${gX + gWidth} ${gY + 6}
                      A ${gWidth / 2 - 4} ${gWidth / 2 - 4} 0 0 1 ${gX} ${gY + 6} Z`}
                  fill="url(#gutter-sheen)"
                />
                {/* Bead edges */}
                <circle cx={gX} cy={gY} r="3" fill={hex} stroke="rgba(0,0,0,0.3)" strokeWidth="0.7" />
                <circle cx={gX + gWidth} cy={gY} r="3" fill={hex} stroke="rgba(0,0,0,0.3)" strokeWidth="0.7" />
              </>
            ) : (
              <>
                {/* K-style ogee profile */}
                <path
                  d={`M ${gX} ${gY}
                      L ${gX} ${gY + 8}
                      Q ${gX + 2} ${gY + gHeight - 4} ${gX + 14} ${gY + gHeight}
                      L ${gX + gWidth - 4} ${gY + gHeight}
                      Q ${gX + gWidth} ${gY + gHeight - 6} ${gX + gWidth + 3} ${gY + gHeight - 18}
                      Q ${gX + gWidth + 5} ${gY + gHeight - 30} ${gX + gWidth + 1} ${gY + 4}
                      L ${gX + gWidth + 1} ${gY}
                      L ${gX + gWidth - 3} ${gY}
                      L ${gX + gWidth - 3} ${gY + gHeight - 22}
                      Q ${gX + gWidth - 5} ${gY + gHeight - 8} ${gX + gWidth - 10} ${gY + gHeight - 4}
                      L ${gX + 16} ${gY + gHeight - 4}
                      Q ${gX + 5} ${gY + gHeight - 8} ${gX + 4} ${gY + 8}
                      L ${gX + 4} ${gY} Z`}
                  fill={hex}
                />
                <path
                  d={`M ${gX} ${gY}
                      L ${gX} ${gY + 8}
                      Q ${gX + 2} ${gY + gHeight - 4} ${gX + 14} ${gY + gHeight}
                      L ${gX + gWidth - 4} ${gY + gHeight}
                      Q ${gX + gWidth} ${gY + gHeight - 6} ${gX + gWidth + 3} ${gY + gHeight - 18}
                      Q ${gX + gWidth + 5} ${gY + gHeight - 30} ${gX + gWidth + 1} ${gY + 4}
                      L ${gX + gWidth + 1} ${gY}
                      L ${gX + gWidth - 3} ${gY} Z`}
                  fill="url(#gutter-sheen)"
                />
              </>
            )}
          </g>

          {/* Hidden hangers — small clips inside the gutter */}
          {[0.25, 0.5, 0.75].map((t, i) => (
            <line
              key={`hanger-${i}`}
              x1={gX + 4 + (gWidth - 8) * t}
              y1={gY + 2}
              x2={gX + 4 + (gWidth - 8) * t}
              y2={gY + gHeight - 6}
              stroke="rgba(0,0,0,0.18)"
              strokeWidth="0.6"
              strokeDasharray="2 2"
            />
          ))}

          {/* Leaf protection across the top */}
          {guardTier !== "none" && (
            <g>
              <rect
                x={gX + 2}
                y={gY - 2}
                width={gWidth - 4}
                height="4"
                fill={
                  guardTier === "screen"
                    ? "url(#guard-screen)"
                    : guardTier === "mesh"
                      ? "url(#guard-mesh)"
                      : "url(#guard-micro)"
                }
                stroke="rgba(0,0,0,0.4)"
                strokeWidth="0.5"
                rx="0.5"
              />
              {/* Edge tone strip so it reads as material, not just a pattern */}
              <rect
                x={gX + 2}
                y={gY - 2}
                width={gWidth - 4}
                height="0.8"
                fill="rgba(0,0,0,0.25)"
              />
            </g>
          )}

          {/* Heat-tape cable looping inside the gutter when enabled */}
          {acc?.heatTape && (
            <path
              d={`M ${gX + 6} ${gY + gHeight - 6}
                  Q ${gX + gWidth * 0.25} ${gY + gHeight - 12}
                    ${gX + gWidth * 0.5} ${gY + gHeight - 6}
                  Q ${gX + gWidth * 0.75} ${gY + gHeight - 12}
                    ${gX + gWidth - 6} ${gY + gHeight - 6}`}
              fill="none"
              stroke="#dc2626"
              strokeWidth="1.6"
              strokeLinecap="round"
              opacity="0.9"
            />
          )}

          {/* Outlet drop — short flange + hole at the gutter floor */}
          <ellipse
            cx={gOutletX}
            cy={gOutletY}
            rx={dsWidth * 0.45}
            ry="3"
            fill="rgba(0,0,0,0.45)"
          />

          {/* Either a downspout OR a rain chain hangs below the outlet. */}
          {useRainChain ? (
            <g>
              {/* Copper rain chain — alternating cup links */}
              {Array.from({ length: 10 }, (_, i) => {
                const cy = gOutletY + 10 + i * 18;
                return (
                  <g key={`chain-${i}`}>
                    <path
                      d={`M ${gOutletX - 6} ${cy} Q ${gOutletX} ${cy + 10} ${gOutletX + 6} ${cy} Z`}
                      fill="#b87333"
                      stroke="rgba(0,0,0,0.35)"
                      strokeWidth="0.5"
                    />
                    <line
                      x1={gOutletX}
                      y1={cy + 8}
                      x2={gOutletX}
                      y2={cy + 18}
                      stroke="#b87333"
                      strokeWidth="1.2"
                    />
                  </g>
                );
              })}
            </g>
          ) : (
            <g filter="url(#soft-shadow)">
              {/* Elbow #1: comes out of the outlet, jogs back toward the wall */}
              <path
                d={`M ${gOutletX - dsWidth / 2} ${gOutletY + 2}
                    L ${gOutletX + dsWidth / 2} ${gOutletY + 2}
                    L ${gOutletX + dsWidth / 2 + 8} ${gOutletY + 20}
                    L ${gOutletX - dsWidth / 2 + 8} ${gOutletY + 20} Z`}
                fill={hex}
                stroke="rgba(0,0,0,0.3)"
                strokeWidth="0.6"
              />
              <path
                d={`M ${gOutletX - dsWidth / 2} ${gOutletY + 2}
                    L ${gOutletX + dsWidth / 2} ${gOutletY + 2}
                    L ${gOutletX + dsWidth / 2 + 8} ${gOutletY + 20}
                    L ${gOutletX - dsWidth / 2 + 8} ${gOutletY + 20} Z`}
                fill="url(#ds-sheen)"
              />

              {/* Vertical downspout shaft — bands every ~40px */}
              {(() => {
                const dsLeft = gOutletX - dsWidth / 2 + 8;
                const dsTop = gOutletY + 20;
                const dsBottom = 330;
                if (dsRound) {
                  return (
                    <g>
                      <ellipse
                        cx={dsLeft + dsWidth / 2}
                        cy={dsTop}
                        rx={dsWidth / 2}
                        ry="3"
                        fill={hex}
                        stroke="rgba(0,0,0,0.25)"
                        strokeWidth="0.5"
                      />
                      <rect
                        x={dsLeft}
                        y={dsTop}
                        width={dsWidth}
                        height={dsBottom - dsTop}
                        fill={hex}
                      />
                      <rect
                        x={dsLeft}
                        y={dsTop}
                        width={dsWidth}
                        height={dsBottom - dsTop}
                        fill="url(#ds-sheen)"
                      />
                      {/* Band rings */}
                      {[0.25, 0.55, 0.85].map((t, i) => (
                        <ellipse
                          key={`ring-${i}`}
                          cx={dsLeft + dsWidth / 2}
                          cy={dsTop + (dsBottom - dsTop) * t}
                          rx={dsWidth / 2 + 1}
                          ry="2.5"
                          fill="none"
                          stroke="rgba(0,0,0,0.3)"
                          strokeWidth="0.6"
                        />
                      ))}
                    </g>
                  );
                }
                return (
                  <g>
                    <rect
                      x={dsLeft}
                      y={dsTop}
                      width={dsWidth}
                      height={dsBottom - dsTop}
                      rx="1.5"
                      fill={hex}
                    />
                    <rect
                      x={dsLeft}
                      y={dsTop}
                      width={dsWidth}
                      height={dsBottom - dsTop}
                      rx="1.5"
                      fill="url(#ds-sheen)"
                    />
                    {/* Center seam line */}
                    <line
                      x1={dsLeft + dsWidth / 2}
                      y1={dsTop}
                      x2={dsLeft + dsWidth / 2}
                      y2={dsBottom}
                      stroke="rgba(0,0,0,0.18)"
                      strokeWidth="0.5"
                      strokeDasharray="3 4"
                    />
                    {/* Strap bands */}
                    {[0.2, 0.55, 0.85].map((t, i) => (
                      <rect
                        key={`strap-${i}`}
                        x={dsLeft - 2}
                        y={dsTop + (dsBottom - dsTop) * t - 1}
                        width={dsWidth + 4}
                        height="2.2"
                        fill="rgba(0,0,0,0.28)"
                      />
                    ))}
                  </g>
                );
              })()}

              {/* Kick-out elbow at the bottom — points away from the wall */}
              <path
                d={`M ${gOutletX - dsWidth / 2 + 8} ${330}
                    L ${gOutletX + dsWidth / 2 + 8} ${330}
                    L ${gOutletX + dsWidth / 2 + 22} ${346}
                    L ${gOutletX - dsWidth / 2 + 22} ${346} Z`}
                fill={hex}
                stroke="rgba(0,0,0,0.3)"
                strokeWidth="0.6"
              />
              <path
                d={`M ${gOutletX - dsWidth / 2 + 8} ${330}
                    L ${gOutletX + dsWidth / 2 + 8} ${330}
                    L ${gOutletX + dsWidth / 2 + 22} ${346}
                    L ${gOutletX - dsWidth / 2 + 22} ${346} Z`}
                fill="url(#ds-sheen)"
              />
            </g>
          )}

          {/* Ground — soft grass strip */}
          <rect x="0" y="346" width="500" height="14" fill="#86efac" opacity="0.4" />
          <line x1="0" y1="346" x2="500" y2="346" stroke="rgba(0,0,0,0.18)" strokeWidth="0.5" />

          {/* Annotations — small leader callouts */}
          {/* Gutter callout */}
          <g>
            <line x1={gX + gWidth + 18} y1={gY + 4} x2={gX + gWidth + 50} y2={gY - 16} stroke="rgba(0,0,0,0.45)" strokeWidth="0.6" />
            <rect
              x={gX + gWidth + 50}
              y={gY - 30}
              width="92"
              height="20"
              rx="4"
              fill="rgba(255,255,255,0.92)"
              stroke="rgba(0,0,0,0.15)"
            />
            <text
              x={gX + gWidth + 96}
              y={gY - 16}
              textAnchor="middle"
              fontSize="10"
              fontFamily="ui-sans-serif, system-ui"
              fill="#0f172a"
              fontWeight="600"
            >
              {config.size}″ {halfRound ? "Half-Round" : "K-Style"}
            </text>
          </g>

          {/* Downspout callout */}
          {!useRainChain && (
            <g>
              <line x1={gOutletX + dsWidth + 14} y1={250} x2={gOutletX + dsWidth + 60} y2={234} stroke="rgba(0,0,0,0.45)" strokeWidth="0.6" />
              <rect
                x={gOutletX + dsWidth + 58}
                y={222}
                width="92"
                height="20"
                rx="4"
                fill="rgba(255,255,255,0.92)"
                stroke="rgba(0,0,0,0.15)"
              />
              <text
                x={gOutletX + dsWidth + 104}
                y={236}
                textAnchor="middle"
                fontSize="10"
                fontFamily="ui-sans-serif, system-ui"
                fill="#0f172a"
                fontWeight="600"
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

          {/* Drip-edge callout */}
          {acc?.dripEdge && (
            <g>
              <line x1={gX + 4} y1={gY + 4} x2={gX - 50} y2={gY - 24} stroke="rgba(0,0,0,0.5)" strokeWidth="0.6" />
              <rect x={gX - 98} y={gY - 38} width="78" height="20" rx="4" fill="rgba(255,255,255,0.95)" stroke="rgba(0,0,0,0.15)" />
              <text x={gX - 59} y={gY - 24} textAnchor="middle" fontSize="10" fontFamily="ui-sans-serif, system-ui" fill="#0f172a" fontWeight="600">
                Drip edge
              </text>
            </g>
          )}

          {/* Leaf guard callout */}
          {guardTier !== "none" && (
            <g>
              <line x1={gX + gWidth / 2} y1={gY - 2} x2={gX + gWidth / 2 + 40} y2={gY - 60} stroke="rgba(0,0,0,0.5)" strokeWidth="0.6" />
              <rect x={gX + gWidth / 2 + 16} y={gY - 76} width="96" height="20" rx="4" fill="rgba(255,255,255,0.95)" stroke="rgba(0,0,0,0.15)" />
              <text x={gX + gWidth / 2 + 64} y={gY - 62} textAnchor="middle" fontSize="10" fontFamily="ui-sans-serif, system-ui" fill="#0f172a" fontWeight="600">
                {guardTier === "screen"
                  ? "Screen guard"
                  : guardTier === "mesh"
                    ? "Mesh guard"
                    : "Micro-mesh"}
              </text>
            </g>
          )}

          {/* Rain-chain callout */}
          {useRainChain && (
            <g>
              <line x1={gOutletX + 8} y1={260} x2={gOutletX + 70} y2={236} stroke="rgba(0,0,0,0.5)" strokeWidth="0.6" />
              <rect x={gOutletX + 60} y={222} width="98" height="20" rx="4" fill="rgba(255,255,255,0.95)" stroke="rgba(0,0,0,0.15)" />
              <text x={gOutletX + 109} y={236} textAnchor="middle" fontSize="10" fontFamily="ui-sans-serif, system-ui" fill="#0f172a" fontWeight="600">
                Copper rain chain
              </text>
            </g>
          )}
        </motion.svg>

        {/* Color chip overlay (bottom right) */}
        <div className="absolute bottom-2 right-3 inline-flex items-center gap-1.5 rounded-full bg-white/85 px-2 py-0.5 text-[10px] font-medium text-zinc-700 shadow-sm ring-1 ring-inset ring-zinc-200">
          <span
            className="h-2 w-2 rounded-full ring-1 ring-inset ring-white/50"
            style={{ background: hex }}
          />
          {color?.name ?? "Custom color"}
        </div>
        <div className="absolute bottom-2 left-3 inline-flex items-center gap-1.5 rounded-full bg-white/85 px-2 py-0.5 text-[10px] font-medium text-zinc-700 shadow-sm ring-1 ring-inset ring-zinc-200">
          Side elevation · approx scale
        </div>
      </div>
    </div>
  );
}
