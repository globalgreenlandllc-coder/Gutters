/**
 * Visual verification harness: SSR-render PresentationCanvas (plan mode)
 * with a 1168G-like footprint, rasterize to PNG via sharp.
 * Includes: an ORPHAN ridge stub (must disappear), 12 downspouts (one
 * outlier height 18' -> badge; rest 10' -> no badges), 22 eave runs.
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import sharp from "sharp";
import { writeFileSync } from "node:fs";
import { PresentationCanvas } from "@/components/proposal/presentation-canvas";
import type { Downspout, EditableLine, RoofStructure } from "@/lib/types";

// Footprint in canvas coords (~2.4 px/ft), traced off the 1168G screenshot /5.9
type P = { x: number; y: number };
const pt = (x: number, y: number): P => ({ x, y });

// Perimeter (clockwise from top-left), with top notch (patio) and bottom porch bump
const PERIM: P[] = [
  pt(78, 54), pt(122, 54),           // top-left eave
  pt(122, 68), pt(158, 68),          // patio notch (14 ft)
  pt(158, 54), pt(206, 54),          // top-right eave (19 ft)
  pt(206, 75), pt(250, 75),          // right upper jog (17 ft)
  pt(250, 160),                      // right 35 ft
  pt(257, 160), pt(257, 206),        // small jog + garage 13 ft
  pt(188, 206),                      // bottom 27 ft (garage)
  pt(188, 197), pt(140, 197),        // porch bump (19 ft)
  pt(140, 206), pt(78, 206),         // bottom 24 ft
];

function runs(perim: P[]): EditableLine[] {
  const out: EditableLine[] = [];
  for (let i = 0; i < perim.length; i++) {
    const a = perim[i];
    const b = perim[(i + 1) % perim.length];
    if (Math.hypot(b.x - a.x, b.y - a.y) < 4) continue;
    const horiz = Math.abs(b.x - a.x) > Math.abs(b.y - a.y);
    const side = horiz ? (a.y < 130 ? "back" : "front") : a.x < 160 ? "left" : "right";
    out.push({
      id: `e${i}`,
      points: [a, b],
      side: side as EditableLine["side"],
    } as EditableLine);
  }
  return out;
}

const eaves = runs(PERIM);

// 12 downspouts on corners, all 10' except one porch outlier at 18'
const dsAt: [number, number, number][] = [
  [78, 54, 10], [122, 54, 10], [206, 54, 10], [206, 75, 10], [250, 75, 10],
  [250, 160, 18], // outlier -> badge
  [257, 206, 10], [188, 206, 10], [140, 206, 10], [78, 206, 10], [78, 130, 10], [122, 68, 10],
];
const downspouts: Downspout[] = dsAt.map(([x, y, h], i) => ({
  id: `d${i}`,
  x,
  y,
  heightFt: h,
})) as Downspout[];

// Roof structure: connected hip skeleton + ONE ORPHAN porch ridge stub
const structure: RoofStructure = {
  perimeter: PERIM,
  ridges: [
    { id: "engine-r1", points: [pt(115, 95), pt(215, 95)] }, // main ridge (connects to hips)
    { id: "engine-r2", points: [pt(164, 168), pt(164, 190)] }, // ORPHAN porch stub -> must vanish
  ],
  hips: [
    { id: "engine-h1", points: [pt(78, 54), pt(115, 95)] },
    { id: "engine-h2", points: [pt(78, 206), pt(115, 95)] },
    { id: "engine-h3", points: [pt(250, 75), pt(215, 95)] },
    { id: "engine-h4", points: [pt(257, 206), pt(215, 95)] },
  ],
  valleys: [],
  gables: [],
  confidence: 0.6,
} as unknown as RoofStructure;

const html = renderToStaticMarkup(
  <div style={{ width: 1100, height: 720 }}>
    <PresentationCanvas
      eaves={eaves}
      rakes={[]}
      downspouts={downspouts}
      roofStructure={structure}
      planMode
    />
  </div>,
);

// framer-motion SSRs initial={opacity:0, scale:...} — force visible for the raster
const visible = html
  .replace(/opacity="0"/g, 'opacity="1"').replace(/opacity:0(?![.\d])/g, "opacity:1")
  .replace(/transform:\s*scale\([^)]*\)[^;"]*/g, "")
  .replace(/stroke-dashoffset:[^;"]*/g, "").replace(/transform="scale\([^)"]*\)"/g, "").replace(/(stroke-)?dasharray="0px 1px"/g, "").replace(/pathLength="1"/g, "");

const m = visible.match(/<svg[\s\S]*<\/svg>/);
if (!m) throw new Error("no svg found");
let svg = m[0];
// give the svg explicit pixel dims for sharp
svg = svg.replace(
  /<svg /,
  '<svg width="1800" height="1160" ',
);
writeFileSync("/private/tmp/claude-501/-Users-dmitriyapetenok-Documents-gutters-project/1af6dbb3-39a4-4b63-8e63-aa839f020db9/scratchpad/preview.svg", svg);

sharp(Buffer.from(svg))
  .png()
  .toFile(
    "/private/tmp/claude-501/-Users-dmitriyapetenok-Documents-gutters-project/1af6dbb3-39a4-4b63-8e63-aa839f020db9/scratchpad/preview.png",
  )
  .then(() => console.log("rendered preview.png"));

// ---------------------------------------------------------------------------
// Second render: GutterDiagram (satellite / address flow drafting sheet).
// Same footprint scaled into the 900x580 satellite canvas space, downspouts
// deliberately ON run midpoints to force label<->pin collisions, plus an
// upper-tier interior loop for tier colors.
// ---------------------------------------------------------------------------
import { GutterDiagram } from "@/components/estimate/gutter-diagram";

const S = 2.2;
const OX = 150;
const OY = 40;
const sp = (p: P): P => ({ x: p.x * S + OX, y: p.y * S + OY });
const satPerim = PERIM.map(sp);
const satEaves: EditableLine[] = runs(PERIM).map((l) => ({
  ...l,
  points: l.points.map(sp),
}));
// Upper-roof interior loop (solar tier run)
satEaves.push({
  id: "tier-eave-1",
  points: [sp(pt(120, 100)), sp(pt(190, 100)), sp(pt(190, 140)), sp(pt(120, 140)), sp(pt(120, 100))],
} as EditableLine);
// Downspouts on run MIDPOINTS (collision stress) + corners
const satDs: Downspout[] = (
  [
    [100, 54], [250, 118], [78, 130], [140, 206], [222, 206], [257, 183],
    [182, 54], [78, 180],
  ] as [number, number][]
).map(([x, y], i) => ({ id: `sd${i}`, ...sp(pt(x, y)), heightFt: 10 })) as Downspout[];

const satStructure = {
  perimeter: satPerim,
  ridges: [{ id: "r1", points: [sp(pt(115, 95)), sp(pt(215, 95))] }],
  hips: [],
  valleys: [],
  gables: [],
  confidence: 0.82,
} as unknown as RoofStructure;

const satHtml = renderToStaticMarkup(
  <div style={{ width: 1100, height: 720 }}>
    <GutterDiagram
      eaves={satEaves}
      rakes={[]}
      downspouts={satDs}
      roofStructure={satStructure}
      pxPerFt={2.4 * S}
      address="123 Verification Ln, Test WA"
      confidence={0.82}
    />
  </div>,
);
const satM = satHtml.match(/<svg[\s\S]*<\/svg>/);
if (!satM) throw new Error("no satellite svg found");
const satSvg = satM[0].replace(/<svg /, '<svg width="1800" height="1160" ');
writeFileSync(
  "/private/tmp/claude-501/-Users-dmitriyapetenok-Documents-gutters-project/1af6dbb3-39a4-4b63-8e63-aa839f020db9/scratchpad/preview-satellite.svg",
  satSvg,
);
sharp(Buffer.from(satSvg))
  .png()
  .toFile(
    "/private/tmp/claude-501/-Users-dmitriyapetenok-Documents-gutters-project/1af6dbb3-39a4-4b63-8e63-aa839f020db9/scratchpad/preview-satellite.png",
  )
  .then(() => console.log("rendered preview-satellite.png"));
