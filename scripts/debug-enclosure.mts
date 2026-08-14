/**
 * Dump the raw Solar layers (RGB / DSM / building mask) for an address so
 * the screen-enclosure detector can be designed against real pixels.
 */
import { PNG } from "pngjs";
import { readFileSync, writeFileSync } from "node:fs";
import { fetchSolarLayersWithKey } from "../lib/ai/solar-layers.ts";

const SCRATCH =
  "/private/tmp/claude-501/-Users-dmitriyapetenok-Documents-gutters-project/875c9705-d53b-4402-a8d7-2e23d7906c02/scratchpad";

const env = readFileSync(
  "/Users/dmitriyapetenok/Documents/gutters project/.env",
  "utf8",
);
const key = env.match(/^GOOGLE_MAPS_API_KEY="?([^"\n]+)"?/m)?.[1]!;

const address = process.argv[2] ?? "7207 39th Ln E, Sarasota, FL 34243, USA";
const slug = address.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 24);

const geo = await (async () => {
  const res = await fetch(
    `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${key}`,
  );
  const d = (await res.json()) as any;
  return d.results[0].geometry.location as { lat: number; lng: number };
})();

// Same window logic as verify script: center on insights bbox when present.
const ins = await (async () => {
  const res = await fetch(
    `https://solar.googleapis.com/v1/buildingInsights:findClosest?location.latitude=${geo.lat}&location.longitude=${geo.lng}&requiredQuality=LOW&key=${key}`,
  );
  if (!res.ok) return null;
  return (await res.json()) as any;
})();
let centerLat = geo.lat;
let centerLng = geo.lng;
let radius = 45;
if (ins?.boundingBox) {
  centerLat = (ins.boundingBox.ne.latitude + ins.boundingBox.sw.latitude) / 2;
  centerLng = (ins.boundingBox.ne.longitude + ins.boundingBox.sw.longitude) / 2;
  const mLat = 110_540;
  const mLng = 111_320 * Math.cos((centerLat * Math.PI) / 180);
  const spanY = Math.abs(ins.boundingBox.ne.latitude - ins.boundingBox.sw.latitude) * mLat;
  const spanX = Math.abs(ins.boundingBox.ne.longitude - ins.boundingBox.sw.longitude) * mLng;
  radius = Math.round(Math.min(90, Math.max(32, Math.hypot(spanX, spanY) / 2 + 12)));
}

const out = await fetchSolarLayersWithKey(key, centerLat, centerLng, radius);
if (!out.ok) throw new Error(out.reason);
const { grid, mask, dsm, dsmNoData, rgb } = out.layers;
const { width: W, height: H, metersPerPixel } = grid;
console.log(`grid ${W}x${H} @ ${metersPerPixel} m/px, ${grid.crsLabel}`);

const validH = (v: number) =>
  Number.isFinite(v) && Math.abs(v - dsmNoData) > 0.001 && v > -450 && v < 9000;

// ground ≈ 15th percentile of valid heights
const hs: number[] = [];
for (let i = 0; i < W * H; i++) if (validH(dsm[i])) hs.push(dsm[i]);
hs.sort((a, b) => a - b);
const ground = hs[Math.floor(hs.length * 0.15)];
const hMax = hs[Math.floor(hs.length * 0.999)];
console.log(`ground≈${ground.toFixed(2)} m, p99.9=${hMax.toFixed(2)} m`);

function savePng(name: string, fill: (i: number, px: number[]) => void) {
  const png = new PNG({ width: W, height: H });
  const px = [0, 0, 0];
  for (let i = 0; i < W * H; i++) {
    fill(i, px);
    png.data[i * 4] = px[0];
    png.data[i * 4 + 1] = px[1];
    png.data[i * 4 + 2] = px[2];
    png.data[i * 4 + 3] = 255;
  }
  writeFileSync(`${SCRATCH}/${slug}-${name}.png`, PNG.sync.write(png));
  console.log(`wrote ${slug}-${name}.png`);
}

savePng("rgb", (i, px) => {
  px[0] = rgb[i * 3];
  px[1] = rgb[i * 3 + 1];
  px[2] = rgb[i * 3 + 2];
});
savePng("dsm", (i, px) => {
  if (!validH(dsm[i])) {
    px[0] = 255; px[1] = 0; px[2] = 0;
    return;
  }
  const t = Math.max(0, Math.min(1, (dsm[i] - ground) / Math.max(1, hMax - ground)));
  px[0] = px[1] = px[2] = Math.round(t * 255);
});
savePng("mask", (i, px) => {
  const dim = mask[i] > 0 ? 1 : 0.35;
  px[0] = rgb[i * 3] * dim;
  px[1] = rgb[i * 3 + 1] * dim;
  px[2] = mask[i] > 0 ? Math.min(255, rgb[i * 3 + 2] * dim + 60) : rgb[i * 3 + 2] * dim;
});

// Region stats helper: prints signature numbers for a box
function stats(name: string, x0: number, y0: number, x1: number, y1: number) {
  let n = 0, inMask = 0, blue = 0, green = 0;
  const above: number[] = [];
  const lumSpread: number[] = [];
  const rough: number[] = [];
  let nodata = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = y * W + x;
      n++;
      if (mask[i] > 0) inMask++;
      const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
      if (b > r + 10 && b >= g) blue++;
      if (g > r + 6 && g > b + 6) green++;
      if (validH(dsm[i])) above.push(dsm[i] - ground);
      else nodata++;
      // 3x3 luminance spread + DSM roughness (mirror recoverAttachedRoofs)
      let lLo = 255, lHi = 0, hLo = Infinity, hHi = -Infinity, bad = false;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const j = (y + dy) * W + (x + dx);
        const lum = (rgb[j * 3] + rgb[j * 3 + 1] + rgb[j * 3 + 2]) / 3;
        if (lum < lLo) lLo = lum;
        if (lum > lHi) lHi = lum;
        const v = dsm[j];
        if (!validH(v)) { bad = true; continue; }
        if (v < hLo) hLo = v;
        if (v > hHi) hHi = v;
      }
      lumSpread.push(lHi - lLo);
      if (!bad) rough.push(hHi - hLo);
    }
  }
  const q = (a: number[], p: number) => {
    if (!a.length) return NaN;
    const s = [...a].sort((x2, y2) => x2 - y2);
    return s[Math.floor(s.length * p)];
  };
  console.log(
    `${name}: n=${n} inMask=${(100 * inMask / n).toFixed(0)}% blue=${(100 * blue / n).toFixed(0)}% green=${(100 * green / n).toFixed(0)}% nodata=${(100 * nodata / n).toFixed(0)}%` +
    ` above[p25,p50,p75]=[${q(above, 0.25)?.toFixed(1)},${q(above, 0.5)?.toFixed(1)},${q(above, 0.75)?.toFixed(1)}]` +
    ` lumSpread[p50,p90]=[${q(lumSpread, 0.5)?.toFixed(0)},${q(lumSpread, 0.9)?.toFixed(0)}]` +
    ` rough[p50,p90]=[${q(rough, 0.5)?.toFixed(2)},${q(rough, 0.9)?.toFixed(2)}]`,
  );
}

// Boxes are passed as name:x0,y0,x1,y1 CLI args after the address
for (const arg of process.argv.slice(3)) {
  const m = arg.match(/^([\w-]+):(\d+),(\d+),(\d+),(\d+)$/);
  if (m) stats(m[1], +m[2], +m[3], +m[4], +m[5]);
}

// ---- blue-seed census: what actually passes the pool-blue test ------
{
  let n = 0;
  const samples: string[] = [];
  const lums: number[] = [];
  const bMinusR: number[] = [];
  const bOverR: number[] = [];
  for (let i = 0; i < W * H; i++) {
    if (mask[i] === 0) continue;
    const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
    if (!(b > r + 12 && b > 55 && b >= g - 6)) continue;
    if (!validH(dsm[i]) || dsm[i] - ground < 1.5) continue;
    n++;
    lums.push((r + g + b) / 3);
    bMinusR.push(b - r);
    bOverR.push(b / Math.max(1, r));
    if (n % 97 === 1 && samples.length < 12) {
      samples.push(`(${i % W},${Math.floor(i / W)}) rgb=${r},${g},${b}`);
    }
  }
  const q = (a: number[], p: number) => {
    const s = [...a].sort((x, y) => x - y);
    return s.length ? s[Math.floor(s.length * p)] : NaN;
  };
  console.log(`blue-seeds: n=${n} (${(n * 0.01).toFixed(0)} m²)`);
  console.log(`  lum p25/p50/p75 = ${q(lums, .25)?.toFixed(0)}/${q(lums, .5)?.toFixed(0)}/${q(lums, .75)?.toFixed(0)}`);
  console.log(`  b-r p25/p50/p75 = ${q(bMinusR, .25)?.toFixed(0)}/${q(bMinusR, .5)?.toFixed(0)}/${q(bMinusR, .75)?.toFixed(0)}`);
  console.log(`  b/r p25/p50/p75 = ${q(bOverR, .25)?.toFixed(2)}/${q(bOverR, .5)?.toFixed(2)}/${q(bOverR, .75)?.toFixed(2)}`);
  for (const s of samples) console.log("  " + s);
}
