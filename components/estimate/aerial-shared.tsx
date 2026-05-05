"use client";

import { motion } from "framer-motion";
import type {
  Downspout,
  EditableLine,
  RoofStructure,
  RoofStructureLine,
} from "@/lib/types";

export const VIEWBOX_W = 900;
export const VIEWBOX_H = 580;
export const PX_PER_FT = 2.4;

export type CanvasTheme = "tactical" | "schematic";

export const THEMES: Record<
  CanvasTheme,
  {
    eave: string;
    eaveSelected: string;
    eaveGlowFilter: string | null;
    downspout: string;
    downspoutCore: string;
    downspoutGlowFilter: string | null;
    overlay: string | null;
    handleStroke: string;
    handleFill: string;
    label: string;
  }
> = {
  tactical: {
    eave: "#00e5ff",
    eaveSelected: "#a3f7ff",
    eaveGlowFilter: "url(#neonCyanGlow)",
    downspout: "#ff2bd6",
    downspoutCore: "#fff0fb",
    downspoutGlowFilter: "url(#neonMagentaGlow)",
    overlay: "rgba(2, 6, 23, 0.45)",
    handleStroke: "#a3f7ff",
    handleFill: "#0b1220",
    label: "#a3f7ff",
  },
  schematic: {
    eave: "#059669",
    eaveSelected: "#0e7490",
    eaveGlowFilter: null,
    downspout: "#0e7490",
    downspoutCore: "#0e7490",
    downspoutGlowFilter: null,
    overlay: null,
    handleStroke: "#0e7490",
    handleFill: "white",
    label: "#0e7490",
  },
};

/**
 * SVG filter defs used for the Tactical theme. Drop this once anywhere
 * inside the SVG tree and the filters become referenceable as
 * `url(#neonCyanGlow)` / `url(#neonMagentaGlow)`.
 */
export function NeonDefs() {
  return (
    <defs>
      <filter id="neonCyanGlow" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="3.5" result="blur" />
        <feMerge>
          <feMergeNode in="blur" />
          <feMergeNode in="blur" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
      <filter
        id="neonMagentaGlow"
        x="-100%"
        y="-100%"
        width="300%"
        height="300%"
      >
        <feGaussianBlur stdDeviation="4" result="blur" />
        <feMerge>
          <feMergeNode in="blur" />
          <feMergeNode in="blur" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
    </defs>
  );
}

export function AerialImage({ imageDataUrl }: { imageDataUrl: string }) {
  return (
    <image
      href={imageDataUrl}
      x={0}
      y={0}
      width={VIEWBOX_W}
      height={VIEWBOX_H}
      preserveAspectRatio="xMidYMid slice"
    />
  );
}

export function AerialBackground() {
  return (
    <g aria-hidden>
      <defs>
        <linearGradient id="grass" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#bdcfa9" />
          <stop offset="100%" stopColor="#9bb086" />
        </linearGradient>
        <linearGradient id="roof-main" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#9c8b7d" />
          <stop offset="100%" stopColor="#7a6c5f" />
        </linearGradient>
        <linearGradient id="roof-garage" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#988779" />
          <stop offset="100%" stopColor="#736556" />
        </linearGradient>
        <linearGradient id="driveway" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#cfcdc8" />
          <stop offset="100%" stopColor="#b8b6b1" />
        </linearGradient>
        <pattern id="shingle" width="14" height="6" patternUnits="userSpaceOnUse">
          <path d="M0 6 L14 6" stroke="rgba(0,0,0,0.18)" />
        </pattern>
      </defs>

      <rect width={VIEWBOX_W} height={VIEWBOX_H} fill="url(#grass)" />

      {Array.from({ length: 32 }).map((_, i) => {
        const x = (i % 8) * 120 + (Math.floor(i / 8) % 2) * 60;
        const y = Math.floor(i / 8) * 150 + 20;
        return (
          <circle
            key={`bush-${i}`}
            cx={x + 30}
            cy={y + 30}
            r={6 + (i % 4) * 2}
            fill="#83a368"
            opacity={0.55}
          />
        );
      })}

      <g opacity={0.75}>
        <ellipse cx={120} cy={80} rx={28} ry={24} fill="#7ea264" />
        <ellipse cx={780} cy={120} rx={36} ry={30} fill="#82a866" />
        <ellipse cx={830} cy={500} rx={42} ry={36} fill="#75985b" />
        <ellipse cx={70} cy={520} rx={32} ry={28} fill="#7ca263" />
      </g>

      <rect x={620} y={420} width={170} height={80} rx={2} fill="url(#driveway)" />
      <line
        x1={620}
        y1={460}
        x2={790}
        y2={460}
        stroke="rgba(255,255,255,0.45)"
        strokeDasharray="6 8"
      />

      <rect
        x={220}
        y={240}
        width={360}
        height={140}
        fill="url(#roof-main)"
        stroke="#5b4f44"
        strokeWidth={1}
      />
      <rect x={220} y={240} width={360} height={140} fill="url(#shingle)" />
      <line
        x1={400}
        y1={240}
        x2={400}
        y2={380}
        stroke="rgba(0,0,0,0.35)"
        strokeWidth={1.5}
      />

      <rect
        x={580}
        y={280}
        width={140}
        height={80}
        fill="url(#roof-garage)"
        stroke="#5b4f44"
        strokeWidth={1}
      />
      <rect x={580} y={280} width={140} height={80} fill="url(#shingle)" />
      <line
        x1={650}
        y1={280}
        x2={650}
        y2={360}
        stroke="rgba(0,0,0,0.35)"
        strokeWidth={1.5}
      />

      <rect
        x={320}
        y={200}
        width={160}
        height={42}
        fill="url(#roof-main)"
        stroke="#5b4f44"
        strokeWidth={1}
      />
      <rect x={320} y={200} width={160} height={42} fill="url(#shingle)" />

      <rect x={355} y={300} width={20} height={26} fill="#3d342c" stroke="rgba(0,0,0,0.4)" />
      <rect x={425} y={300} width={20} height={26} fill="#3d342c" stroke="rgba(0,0,0,0.4)" />
      <circle cx={400} cy={355} r={6} fill="#5a4d40" stroke="rgba(0,0,0,0.4)" />

      <rect x={150} y={400} width={70} height={50} rx={3} fill="#a59c8e" opacity={0.85} />
    </g>
  );
}

export function AerialReadonly({
  eaves,
  downspouts,
  className,
  theme = "tactical",
  imageDataUrl,
}: {
  eaves: EditableLine[];
  downspouts: Downspout[];
  className?: string;
  theme?: CanvasTheme;
  imageDataUrl?: string;
}) {
  const t = THEMES[theme];
  return (
    <div
      className={
        "relative overflow-hidden rounded-2xl border " +
        (theme === "tactical"
          ? "border-cyan-900/40 bg-slate-950 "
          : "border-zinc-200 bg-zinc-100 ") +
        (className ?? "")
      }
    >
      <svg
        viewBox={`0 0 ${VIEWBOX_W} ${VIEWBOX_H}`}
        preserveAspectRatio="xMidYMid slice"
        className="h-full w-full"
        style={{ minHeight: 280 }}
      >
        <NeonDefs />
        {imageDataUrl ? (
          <AerialImage imageDataUrl={imageDataUrl} />
        ) : (
          <AerialBackground />
        )}
        {t.overlay && (
          <rect
            x={0}
            y={0}
            width={VIEWBOX_W}
            height={VIEWBOX_H}
            fill={t.overlay}
            pointerEvents="none"
          />
        )}
        {eaves.map((line, i) => (
          <motion.path
            key={line.id}
            d={pathFor(line)}
            stroke={t.eave}
            strokeWidth={theme === "tactical" ? 3 : 4}
            strokeLinecap="round"
            fill="none"
            initial={{ pathLength: 0, opacity: 0 }}
            animate={{ pathLength: 1, opacity: 1 }}
            transition={{ duration: 0.7, ease: "easeOut", delay: i * 0.06 }}
            style={{
              filter:
                theme === "tactical"
                  ? "drop-shadow(0 0 6px rgba(0,229,255,0.95))"
                  : "drop-shadow(0 1px 4px rgba(5,150,105,0.45))",
            }}
          />
        ))}
        {downspouts.map((d, i) => (
          <g key={d.id}>
            {theme === "tactical" ? (
              <>
                <motion.circle
                  cx={d.x}
                  cy={d.y}
                  r={14}
                  fill={t.downspout}
                  opacity={0.18}
                  initial={{ scale: 0.7, opacity: 0 }}
                  animate={{ scale: [0.7, 1.25, 0.9], opacity: [0, 0.35, 0.18] }}
                  transition={{
                    duration: 2.2,
                    repeat: Infinity,
                    ease: "easeInOut",
                    delay: i * 0.15,
                  }}
                />
                <circle
                  cx={d.x}
                  cy={d.y}
                  r={6}
                  fill={t.downspout}
                  filter={t.downspoutGlowFilter ?? undefined}
                />
                <circle cx={d.x} cy={d.y} r={2.2} fill={t.downspoutCore} />
              </>
            ) : (
              <>
                <circle
                  cx={d.x}
                  cy={d.y}
                  r={9}
                  fill="white"
                  stroke={t.downspout}
                  strokeWidth={2}
                />
                <circle cx={d.x} cy={d.y} r={3.5} fill={t.downspoutCore} />
              </>
            )}
          </g>
        ))}
      </svg>
    </div>
  );
}

export function pathFor(line: EditableLine) {
  if (line.points.length === 0) return "";
  const [first, ...rest] = line.points;
  return (
    `M ${first.x} ${first.y} ` +
    rest.map((p) => `L ${p.x} ${p.y}`).join(" ")
  );
}

export function dist(a: { x: number; y: number }, b: { x: number; y: number }) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

export function lineLengthFt(line: EditableLine) {
  let total = 0;
  for (let i = 1; i < line.points.length; i++) {
    total += dist(line.points[i - 1], line.points[i]);
  }
  return total / PX_PER_FT;
}

/**
 * Recreational roof-structure annotation: blue RIDGE labels (solid line)
 * and green VALLEY labels (dashed line) over the satellite image.
 *
 * The perimeter is intentionally NOT rendered here — the cyan eaves
 * already trace the building outline, and a second perimeter from a
 * separate vision call almost always disagrees with the eave polygon
 * (different model, different math), looking like a random white
 * outline floating off the building. Just show the inside structure
 * lines that the eaves layer can't show on its own.
 */
export function RoofStructureOverlay({
  structure,
}: {
  structure: RoofStructure;
}) {
  if (
    structure.ridges.length === 0 &&
    structure.valleys.length === 0
  ) {
    return null;
  }
  return (
    <g pointerEvents="none">
      {structure.ridges.map((ridge, i) => (
        <RoofLineWithLabel
          key={ridge.id}
          line={ridge}
          stroke="#ffffff"
          dashed={false}
          strokeWidth={2.5}
          labelFill="#1e3a8a"
          labelText={ridge.label ?? "RIDGE"}
          delay={0.4 + i * 0.08}
        />
      ))}
      {structure.valleys.map((valley, i) => (
        <RoofLineWithLabel
          key={valley.id}
          line={valley}
          stroke="#e5e7eb"
          dashed
          strokeWidth={2.5}
          labelFill="#0f5132"
          labelText={valley.label ?? "VALLEY"}
          delay={0.55 + i * 0.08}
        />
      ))}
    </g>
  );
}

function RoofLineWithLabel({
  line,
  stroke,
  dashed,
  strokeWidth,
  labelFill,
  labelText,
  delay,
}: {
  line: RoofStructureLine;
  stroke: string;
  dashed: boolean;
  strokeWidth: number;
  labelFill: string;
  labelText: string;
  delay: number;
}) {
  if (line.points.length < 2) return null;
  const a = line.points[0];
  const b = line.points[line.points.length - 1];
  const cx = (a.x + b.x) / 2;
  const cy = (a.y + b.y) / 2;
  const lineD = `M ${a.x} ${a.y} L ${b.x} ${b.y}`;
  const w = Math.max(46, labelText.length * 7 + 14);
  const h = 18;
  return (
    <g>
      <motion.path
        d={lineD}
        fill="none"
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeDasharray={dashed ? "8 6" : undefined}
        opacity={0.9}
        initial={{ pathLength: 0, opacity: 0 }}
        animate={{ pathLength: 1, opacity: 0.9 }}
        transition={{ duration: 0.6, delay, ease: "easeOut" }}
        style={{ filter: "drop-shadow(0 0 3px rgba(0,0,0,0.5))" }}
      />
      <motion.g
        initial={{ opacity: 0, scale: 0.8 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.4, delay: delay + 0.2 }}
      >
        <rect
          x={cx - w / 2}
          y={cy - h / 2}
          width={w}
          height={h}
          rx={5}
          fill={labelFill}
          stroke="rgba(255,255,255,0.85)"
          strokeWidth={1}
          style={{ filter: "drop-shadow(0 1px 3px rgba(0,0,0,0.45))" }}
        />
        <text
          x={cx}
          y={cy + 4}
          textAnchor="middle"
          fill="white"
          fontSize={11}
          fontWeight={700}
          letterSpacing={0.6}
          fontFamily="ui-sans-serif, system-ui, sans-serif"
        >
          {labelText}
        </text>
      </motion.g>
    </g>
  );
}

function closedPathD(points: { x: number; y: number }[]): string {
  if (points.length === 0) return "";
  const [first, ...rest] = points;
  return (
    `M ${first.x} ${first.y} ` +
    rest.map((p) => `L ${p.x} ${p.y}`).join(" ") +
    " Z"
  );
}
