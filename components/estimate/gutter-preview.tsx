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
 * Visual preview of the configured gutter system. Drawn as SVG so it
 * scales cleanly + responds instantly to material/size/profile/color
 * changes. The cross-section is roughly to-scale relative to size: a 7"
 * gutter renders visibly wider than a 5" one so the homeowner can see
 * the difference. Half-round vs K-style swaps the profile path; the
 * downspout shape branches on the four supported sizes.
 *
 * Color fills both the gutter body and the downspout — that's how an
 * actual installation looks (matching gutter + downspout). Metallic
 * sheen is a subtle linear gradient overlay so the swatch reads as a
 * coated surface rather than a flat color chip.
 */
export function GutterPreview({ config }: { config: EstimateConfig }) {
  const color = COLOR_OPTIONS.find((c) => c.id === config.color);
  const hex = color?.hex ?? "#f4f4f5";
  const mat = MATERIAL_BADGE[config.material];

  // Width tier — visually distinguish 5/6/7" gutters.
  const widthPx = config.size === "5" ? 56 : config.size === "6" ? 70 : 84;
  const halfRound = config.style === "half-round";

  // Downspout cross-section: rect for box, circle for round.
  const ds = config.downspoutSize;
  const dsWidth = ds === "2x3" ? 24 : ds === "3x4" ? 32 : ds === "round-3" ? 28 : 36;
  const dsHeight = 70;
  const dsRound = ds === "round-3" || ds === "round-4";

  return (
    <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-gradient-to-b from-sky-50/60 via-white to-zinc-50 shadow-sm">
      {/* Sky / header strip */}
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

      {/* Visualization area */}
      <div className="relative h-44 w-full overflow-hidden">
        {/* Soft sky gradient backdrop */}
        <div className="absolute inset-0 bg-gradient-to-b from-sky-100/50 via-white to-zinc-100/40" />
        {/* Faux fascia board behind the gutter */}
        <div className="absolute left-1/2 top-6 h-3 w-[78%] -translate-x-1/2 rounded-sm bg-zinc-400/40 ring-1 ring-inset ring-zinc-500/30 shadow-inner" />

        {/* Centered gutter cross-section */}
        <motion.svg
          key={`${config.size}-${config.style}-${config.color}-${config.material}`}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25 }}
          viewBox="0 0 200 120"
          className="absolute left-1/2 top-3 -translate-x-1/2"
          width={widthPx * 2.2}
          height={widthPx * 1.4}
          aria-hidden
        >
          <defs>
            <linearGradient id="gutter-sheen" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="rgba(255,255,255,0.55)" />
              <stop offset="40%" stopColor="rgba(255,255,255,0.0)" />
              <stop offset="100%" stopColor="rgba(0,0,0,0.18)" />
            </linearGradient>
            <linearGradient id="gutter-edge" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="rgba(0,0,0,0.25)" />
              <stop offset="50%" stopColor="rgba(0,0,0,0)" />
              <stop offset="100%" stopColor="rgba(0,0,0,0.25)" />
            </linearGradient>
            <filter id="dropshadow" x="-10%" y="-10%" width="120%" height="120%">
              <feGaussianBlur in="SourceAlpha" stdDeviation="2" />
              <feOffset dx="0" dy="3" result="off" />
              <feComponentTransfer>
                <feFuncA type="linear" slope="0.35" />
              </feComponentTransfer>
              <feMerge>
                <feMergeNode />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {halfRound ? (
            // Half-round profile: outer hemisphere arc
            <g filter="url(#dropshadow)">
              <path
                d="M 30 30 A 70 70 0 0 0 170 30 L 170 38 A 62 62 0 0 1 30 38 Z"
                fill={hex}
              />
              <path
                d="M 30 30 A 70 70 0 0 0 170 30 L 170 38 A 62 62 0 0 1 30 38 Z"
                fill="url(#gutter-sheen)"
              />
              {/* Bead edge */}
              <ellipse cx="30" cy="30" rx="4" ry="4" fill={hex} stroke="rgba(0,0,0,0.2)" strokeWidth="0.8" />
              <ellipse cx="170" cy="30" rx="4" ry="4" fill={hex} stroke="rgba(0,0,0,0.2)" strokeWidth="0.8" />
            </g>
          ) : (
            // K-style profile: ogee-style outer face + flat back
            <g filter="url(#dropshadow)">
              <path
                d="M 30 30 L 30 50 Q 32 80 60 90 L 140 90 Q 168 80 170 50 L 170 30 L 165 30 L 165 80 Q 160 86 145 86 L 55 86 Q 40 86 35 80 L 35 30 Z"
                fill={hex}
              />
              <path
                d="M 30 30 L 30 50 Q 32 80 60 90 L 140 90 Q 168 80 170 50 L 170 30 L 165 30 L 165 80 Q 160 86 145 86 L 55 86 Q 40 86 35 80 L 35 30 Z"
                fill="url(#gutter-sheen)"
              />
              <rect x="30" y="30" width="140" height="2" fill="url(#gutter-edge)" />
            </g>
          )}
        </motion.svg>

        {/* Downspout — vertical pipe descending from one corner */}
        <motion.svg
          key={`ds-${config.downspoutSize}-${config.color}`}
          initial={{ opacity: 0, x: 4 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.25 }}
          viewBox={`0 0 ${dsWidth + 10} ${dsHeight + 5}`}
          width={dsWidth + 10}
          height={dsHeight + 5}
          className="absolute right-[14%] bottom-0"
          aria-hidden
        >
          <defs>
            <linearGradient id="ds-sheen" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="rgba(255,255,255,0.45)" />
              <stop offset="50%" stopColor="rgba(255,255,255,0)" />
              <stop offset="100%" stopColor="rgba(0,0,0,0.18)" />
            </linearGradient>
          </defs>
          {dsRound ? (
            <g>
              <ellipse cx={dsWidth / 2 + 5} cy={5} rx={dsWidth / 2} ry={3} fill={hex} stroke="rgba(0,0,0,0.2)" strokeWidth="0.6" />
              <rect x={5} y={5} width={dsWidth} height={dsHeight - 5} fill={hex} />
              <rect x={5} y={5} width={dsWidth} height={dsHeight - 5} fill="url(#ds-sheen)" />
              <ellipse cx={dsWidth / 2 + 5} cy={dsHeight} rx={dsWidth / 2} ry={3} fill={hex} stroke="rgba(0,0,0,0.25)" strokeWidth="0.6" />
            </g>
          ) : (
            <g>
              <rect x={5} y={5} width={dsWidth} height={dsHeight - 5} rx={1.5} fill={hex} />
              <rect x={5} y={5} width={dsWidth} height={dsHeight - 5} rx={1.5} fill="url(#ds-sheen)" />
              <line x1={5} y1={dsHeight / 2} x2={dsWidth + 5} y2={dsHeight / 2} stroke="rgba(0,0,0,0.12)" strokeWidth="0.5" strokeDasharray="2 3" />
            </g>
          )}
        </motion.svg>

        {/* Dimension callout under the gutter */}
        <div className="absolute bottom-2 left-3 inline-flex items-center gap-1.5 rounded-full bg-white/85 px-2 py-0.5 text-[10px] font-medium text-zinc-700 shadow-sm ring-1 ring-inset ring-zinc-200">
          <span className="font-mono tabular-nums">{config.size}″</span> width ·
          <span className="font-mono tabular-nums">
            {ds === "2x3"
              ? '2×3"'
              : ds === "3x4"
                ? '3×4"'
                : ds === "round-3"
                  ? '3" round'
                  : '4" round'}
          </span>{" "}
          downspout
        </div>
        <div className="absolute bottom-2 right-3 inline-flex items-center gap-1.5 rounded-full bg-white/85 px-2 py-0.5 text-[10px] font-medium text-zinc-700 shadow-sm ring-1 ring-inset ring-zinc-200">
          <span
            className="h-2 w-2 rounded-full ring-1 ring-inset ring-white/50"
            style={{ background: hex }}
          />
          {color?.name ?? "Custom color"}
        </div>
      </div>
    </div>
  );
}
