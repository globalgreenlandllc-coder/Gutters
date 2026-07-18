/**
 * Drive cleanFootprint's stages one at a time on a saved raw boundary
 * (SOLAR_DEBUG_DIR/boundary-raw.json) and render each stage's ring over
 * the RGB tile — pinpoints which stage eats a real feature.
 *
 * Run: NODE_OPTIONS="--conditions=react-server" npx tsx scripts/debug-clean-stages.mts <boundary.json> <rgb.png> <outdir> [x0 y0 w h]
 */
import { PNG } from "pngjs";
import { readFileSync, writeFileSync } from "node:fs";
import {
  regularizeRing,
  rectifyShortEdgeChains,
  collapseOffGridBulges,
  collapseTaperWedges,
  dechamferPolygon,
} from "../lib/ai/solar-geometry.ts";

const [boundaryPath, rgbPath, outDir, cx0, cy0, cw, ch] = process.argv.slice(2);
const mpp = 0.1;
type Pt = { x: number; y: number };
const boundary: Pt[] = JSON.parse(readFileSync(boundaryPath, "utf8"));

// Mirror cleanFootprint's private simplify: downsample + Douglas-Peucker.
function dp(points: Pt[], eps: number): Pt[] {
  if (points.length < 3) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [i0, i1] = stack.pop()!;
    const a = points[i0];
    const b = points[i1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    let worst = -1;
    let worstD = eps;
    for (let i = i0 + 1; i < i1; i++) {
      const d = Math.abs((points[i].x - a.x) * dy - (points[i].y - a.y) * dx) / len;
      if (d > worstD) {
        worstD = d;
        worst = i;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([i0, worst], [worst, i1]);
    }
  }
  return points.filter((_, i) => keep[i] === 1);
}

const downsampled =
  boundary.length > 800
    ? boundary.filter((_, i) => i % Math.ceil(boundary.length / 800) === 0)
    : boundary;
const stages: { name: string; ring: Pt[] }[] = [];
const simplified = dp(downsampled, 0.3 / mpp);
stages.push({ name: "1-dp", ring: simplified });
const reg = regularizeRing(simplified, mpp);
stages.push({ name: "2-regularize", ring: reg.points });
const rect = rectifyShortEdgeChains(reg.points, mpp);
stages.push({ name: "3-notch", ring: rect.points });
const bulge = collapseOffGridBulges(rect.points, mpp);
stages.push({ name: "4-bulge", ring: bulge.points });
const wedge = collapseTaperWedges(bulge.points, mpp);
stages.push({ name: "5-wedge", ring: wedge.points });
const dech = dechamferPolygon(wedge.points, mpp);
stages.push({ name: "6-dechamfer", ring: dech.points });

const src = PNG.sync.read(readFileSync(rgbPath));
const x0 = Number(cx0 ?? 0);
const y0 = Number(cy0 ?? 0);
const w = Number(cw ?? src.width);
const h = Number(ch ?? src.height);
const S = 4;

for (const st of stages) {
  const img = new PNG({ width: w * S, height: h * S });
  for (let y = 0; y < h * S; y++) {
    for (let x = 0; x < w * S; x++) {
      const sx = x0 + Math.floor(x / S);
      const sy = y0 + Math.floor(y / S);
      const si = (sy * src.width + sx) * 4;
      const di = (y * img.width + x) * 4;
      img.data[di] = src.data[si];
      img.data[di + 1] = src.data[si + 1];
      img.data[di + 2] = src.data[si + 2];
      img.data[di + 3] = 255;
    }
  }
  const ring = st.ring;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const steps = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) * S));
    for (let k = 0; k <= steps; k++) {
      const px = (a.x + ((b.x - a.x) * k) / steps - x0) * S;
      const py = (a.y + ((b.y - a.y) * k) / steps - y0) * S;
      const xi = Math.round(px);
      const yi = Math.round(py);
      if (xi < 0 || yi < 0 || xi >= img.width || yi >= img.height) continue;
      const di = (yi * img.width + xi) * 4;
      img.data[di] = 255;
      img.data[di + 1] = 0;
      img.data[di + 2] = 255;
    }
  }
  writeFileSync(`${outDir}/stage-${st.name}.png`, PNG.sync.write(img));
  console.log(`${st.name}: ${st.ring.length} vertices`);
}
