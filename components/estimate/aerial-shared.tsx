"use client";

import { motion } from "framer-motion";
import type {
  Downspout,
  EditableLine,
  RoofStructure,
  RoofStructureLine,
} from "@/lib/types";

// Geometry constants live in a directive-free module so the SERVER-ONLY
// plan→estimate converter can import the real numbers. Importing them
// from this "use client" file server-side turns them into RSC client
// references (PX_PER_FT reads as an object → NaN). Imported here for this
// module's own use AND re-exported so existing client imports
// `from "@/components/estimate/aerial-shared"` keep working unchanged.
import { VIEWBOX_W, VIEWBOX_H, PX_PER_FT } from "./aerial-constants";
export { VIEWBOX_W, VIEWBOX_H, PX_PER_FT };

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
    // Softer teal — was too bright and competed with the satellite
    // image for attention. New tone reads as a clear trace but lets
    // the roof show through clearly.
    eave: "#2dd4bf",
    eaveSelected: "#5eead4",
    eaveGlowFilter: "url(#neonCyanGlow)",
    downspout: "#e879f9",
    downspoutCore: "#fdf4ff",
    downspoutGlowFilter: "url(#neonMagentaGlow)",
    overlay: "rgba(2, 6, 23, 0.35)",
    handleStroke: "#5eead4",
    handleFill: "#0b1220",
    label: "#5eead4",
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

/**
 * Drafting-paper background for plan-based takeoffs. Replaces the
 * cartoon yard scene (and the unreliable "rasterize the source PDF
 * page" approach — Claude consistently picks the site plan page,
 * not the roof plan, because the schema has no robust way to tell
 * them apart).
 *
 * Visual: warm off-white paper with a faint engineering grid, corner
 * registration marks, and a subtle title-block-style trim along the
 * right edge. Looks like an architectural drawing the contractor
 * could fold and hand to a customer.
 */
export function BlueprintBackground() {
  return (
    <g aria-hidden>
      <defs>
        <pattern
          id="blueprint-grid"
          width="24"
          height="24"
          patternUnits="userSpaceOnUse"
        >
          <path
            d="M 24 0 L 0 0 0 24"
            fill="none"
            stroke="rgba(30, 58, 138, 0.06)"
            strokeWidth="0.6"
          />
        </pattern>
        <pattern
          id="blueprint-grid-major"
          width="120"
          height="120"
          patternUnits="userSpaceOnUse"
        >
          <path
            d="M 120 0 L 0 0 0 120"
            fill="none"
            stroke="rgba(30, 58, 138, 0.12)"
            strokeWidth="0.9"
          />
        </pattern>
      </defs>
      {/* Warm paper tone */}
      <rect width={VIEWBOX_W} height={VIEWBOX_H} fill="#f7f4ee" />
      {/* Vignette toward edges for a printed-paper feel */}
      <radialGradient id="blueprint-vignette" cx="50%" cy="50%" r="65%">
        <stop offset="50%" stopColor="rgba(247, 244, 238, 0)" />
        <stop offset="100%" stopColor="rgba(120, 95, 60, 0.10)" />
      </radialGradient>
      <rect
        width={VIEWBOX_W}
        height={VIEWBOX_H}
        fill="url(#blueprint-vignette)"
      />
      <rect width={VIEWBOX_W} height={VIEWBOX_H} fill="url(#blueprint-grid)" />
      <rect
        width={VIEWBOX_W}
        height={VIEWBOX_H}
        fill="url(#blueprint-grid-major)"
      />
      {/* Border frame */}
      <rect
        x={20}
        y={20}
        width={VIEWBOX_W - 40}
        height={VIEWBOX_H - 40}
        fill="none"
        stroke="rgba(30, 58, 138, 0.45)"
        strokeWidth="1.2"
      />
      <rect
        x={28}
        y={28}
        width={VIEWBOX_W - 56}
        height={VIEWBOX_H - 56}
        fill="none"
        stroke="rgba(30, 58, 138, 0.18)"
        strokeWidth="0.6"
      />
      {/* Corner registration marks */}
      {[
        { x: 28, y: 28 },
        { x: VIEWBOX_W - 28, y: 28 },
        { x: 28, y: VIEWBOX_H - 28 },
        { x: VIEWBOX_W - 28, y: VIEWBOX_H - 28 },
      ].map((c, i) => (
        <g key={i}>
          <circle
            cx={c.x}
            cy={c.y}
            r={5}
            fill="none"
            stroke="rgba(30, 58, 138, 0.55)"
            strokeWidth="0.8"
          />
          <line
            x1={c.x - 8}
            y1={c.y}
            x2={c.x + 8}
            y2={c.y}
            stroke="rgba(30, 58, 138, 0.55)"
            strokeWidth="0.8"
          />
          <line
            x1={c.x}
            y1={c.y - 8}
            x2={c.x}
            y2={c.y + 8}
            stroke="rgba(30, 58, 138, 0.55)"
            strokeWidth="0.8"
          />
        </g>
      ))}
      {/* Title-block strip along the right edge */}
      <g transform={`translate(${VIEWBOX_W - 56}, 40)`}>
        <line
          x1={0}
          y1={0}
          x2={0}
          y2={VIEWBOX_H - 80}
          stroke="rgba(30, 58, 138, 0.35)"
          strokeWidth="0.8"
        />
        {[0.2, 0.4, 0.6, 0.8].map((p, i) => (
          <line
            key={i}
            x1={0}
            y1={p * (VIEWBOX_H - 80)}
            x2={24}
            y2={p * (VIEWBOX_H - 80)}
            stroke="rgba(30, 58, 138, 0.2)"
            strokeWidth="0.5"
          />
        ))}
      </g>
      {/* "GUTTER TAKEOFF" stencil-style label in the lower-right title block */}
      <g transform={`translate(${VIEWBOX_W - 200}, ${VIEWBOX_H - 64})`}>
        <text
          x={0}
          y={0}
          fill="rgba(30, 58, 138, 0.55)"
          fontSize="9"
          fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
          letterSpacing="0.18em"
        >
          GUTTER TAKEOFF
        </text>
        <line
          x1={0}
          y1={4}
          x2={130}
          y2={4}
          stroke="rgba(30, 58, 138, 0.3)"
          strokeWidth="0.6"
        />
        <text
          x={0}
          y={16}
          fill="rgba(30, 58, 138, 0.4)"
          fontSize="7"
          fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
          letterSpacing="0.12em"
        >
          AI-ASSISTED · CONTRACTOR VERIFIED
        </text>
      </g>
    </g>
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
    const d = dist(line.points[i - 1], line.points[i]);
    // Skip non-finite segments so a single bad point (NaN/undefined coord
    // from a stale stored takeoff) contributes 0 instead of poisoning the
    // whole legend with "NaN LF".
    if (Number.isFinite(d)) total += d;
  }
  return total / PX_PER_FT;
}

/**
 * Frame the takeoff so it fills the canvas.
 *
 * The plan→estimate projection lays geometry out at a FIXED scale
 * (canvas-px = feet × PX_PER_FT) so the live LF recompute round-trips.
 * The side effect: a correctly-sized small building — a 64 ft house is
 * only 64 × 2.4 ≈ 154 px — renders as a tiny trace marooned in the
 * 900×580 frame. (The bug only surfaced once the LF numbers were fixed;
 * the earlier inflated ~200-ft traces happened to fill the frame.)
 *
 * Rather than rescale the geometry (which would desync px↔ft and break
 * both the LF math and drag-to-reprice), we move the CAMERA: compute a
 * viewBox window tight around the trace, matched to the canvas aspect
 * ratio so preserveAspectRatio="slice" doesn't crop it. Pointer math in
 * both canvases already goes through getScreenCTM().inverse(), so
 * dragging is unaffected by the zoomed window.
 *
 * Returns null when there's nothing to frame, or when the trace already
 * fills most of the frame — callers fall back to the full 0 0 900 580
 * view so an already-large (or satellite-calibrated) trace is untouched.
 */
export function fitViewBox(
  points: readonly { x: number; y: number }[],
  opts?: { padPct?: number },
): { x: number; y: number; width: number; height: number } | null {
  const pad = opts?.padPct ?? 0.08;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let n = 0;
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
    n++;
  }
  if (n < 2) return null;
  let cw = (maxX - minX) * (1 + 2 * pad);
  let ch = (maxY - minY) * (1 + 2 * pad);
  if (cw <= 1 && ch <= 1) return null;
  cw = Math.max(cw, 1);
  ch = Math.max(ch, 1);
  // Expand the short axis so the window matches the canvas aspect —
  // otherwise "slice" crops the long axis of the trace.
  const aspect = VIEWBOX_W / VIEWBOX_H;
  if (cw / ch < aspect) cw = ch * aspect;
  else ch = cw / aspect;
  // Cap the zoom (~3.5×) so a very small trace doesn't fill the frame at
  // a disorienting magnification — the contractor can still zoom in
  // further by hand.
  const minW = VIEWBOX_W / 3.5;
  if (cw < minW) {
    ch = (ch * minW) / cw;
    cw = minW;
  }
  // Already fills ~the whole frame → zooming buys nothing; let the
  // caller use the default viewBox.
  if (cw >= VIEWBOX_W * 0.9) return null;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return { x: cx - cw / 2, y: cy - ch / 2, width: cw, height: ch };
}

/**
 * Roof-structure overlay: the building OUTLINE (the roof shape) plus the
 * interior ridge / hip / valley lines, drawn under the gutter trace. Lets
 * the contractor read the whole roof at a glance — where the eaves (and
 * therefore gutters) sit on it, and where a run is MISSING (a stretch of
 * outline with no eave on top of it).
 */
export function RoofStructureOverlay({
  structure,
  tone = "onDark",
  scale = 1,
}: {
  structure: RoofStructure;
  /** "onDark" = light strokes for the dark tactical canvas; "onLight" =
   *  dark strokes for the cream drafting-paper proposal. */
  tone?: "onDark" | "onLight";
  /** Inverse-zoom factor (view.width / VIEWBOX_W) so stroke weights stay
   *  visually constant when the camera is zoomed in to frame the trace. */
  scale?: number;
}) {
  if (structure.perimeter.length < 3) return null;
  const onDark = tone === "onDark";
  const perim = onDark ? "rgba(226,232,240,0.85)" : "rgba(30,58,138,0.72)";
  const ridgeC = onDark ? "rgba(148,163,184,0.7)" : "rgba(71,85,105,0.6)";
  const hipC = onDark ? "rgba(125,211,252,0.6)" : "rgba(14,116,144,0.55)";
  const valleyC = onDark ? "rgba(196,181,253,0.65)" : "rgba(109,40,217,0.5)";
  const interior: { l: RoofStructureLine; c: string }[] = [
    ...structure.ridges.map((l) => ({ l, c: ridgeC })),
    ...(structure.hips ?? []).map((l) => ({ l, c: hipC })),
    ...structure.valleys.map((l) => ({ l, c: valleyC })),
  ].filter(({ l }) => l.points.length >= 2);
  return (
    <g pointerEvents="none">
      {/* Interior roof lines first, under the perimeter + the trace */}
      {interior.map(({ l, c }) => (
        <path
          key={l.id}
          d={linePathD(l.points)}
          fill="none"
          stroke={c}
          strokeWidth={1.4 * scale}
          strokeDasharray={`${5 * scale} ${4 * scale}`}
          strokeLinecap="round"
        />
      ))}
      {/* Building outline — the roof shape */}
      <motion.path
        d={closedPathD(structure.perimeter)}
        fill="none"
        stroke={perim}
        strokeWidth={2.4 * scale}
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={{ pathLength: 0, opacity: 0 }}
        animate={{ pathLength: 1, opacity: 1 }}
        transition={{ duration: 0.6, delay: 0.2, ease: "easeOut" }}
        style={{
          filter: onDark ? "drop-shadow(0 0 4px rgba(0,0,0,0.55))" : "none",
        }}
      />
    </g>
  );
}

function linePathD(points: { x: number; y: number }[]): string {
  if (points.length === 0) return "";
  const [first, ...rest] = points;
  return `M ${first.x} ${first.y} ` + rest.map((p) => `L ${p.x} ${p.y}`).join(" ");
}

function closedPathD(points: { x: number; y: number }[]): string {
  return points.length === 0 ? "" : linePathD(points) + " Z";
}
