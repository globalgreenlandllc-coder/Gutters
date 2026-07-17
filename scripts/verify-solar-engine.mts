/**
 * End-to-end verification of the solar-first engine against the LIVE
 * Google APIs, bypassing the DB key vault (env GOOGLE_MAPS_API_KEY).
 *
 * Run:  NODE_OPTIONS="--conditions=react-server" npx tsx verify-solar-engine.mts "ADDRESS"
 *
 * Writes to the scratchpad:
 *   <slug>-overlay.png  — cropped RGB orthophoto with eaves (cyan),
 *                         rakes (red), downspouts (magenta), suggested
 *                         interior eaves (yellow) rasterized on top
 *   <slug>-report.json  — notes, measurements, traceQuality
 */
import { PNG } from "pngjs";
import { readFileSync, writeFileSync } from "node:fs";
import { fetchSolarLayersWithKey } from "../lib/ai/solar-layers.ts";
import { runSolarFirstEstimate } from "../lib/ai/solar-engine.ts";
import type { BuildingInsights } from "../lib/ai/solar.ts";

const SCRATCH =
  process.env.SOLAR_VERIFY_OUT ??
  "/private/tmp/claude-501/-Users-dmitriyapetenok-Documents-gutters-project/d6dbc9c0-98c0-45a6-bd46-8fb0269129af/scratchpad";

// Pull the key from the project .env without loading the whole app.
const env = readFileSync(
  "/Users/dmitriyapetenok/Documents/gutters project/.env",
  "utf8",
);
const key = env.match(/^GOOGLE_MAPS_API_KEY="?([^"\n]+)"?/m)?.[1];
if (!key) throw new Error("no GOOGLE_MAPS_API_KEY in .env");

const address = process.argv[2] ?? "6232 97th Dr NE, Lake Stevens, WA 98258, USA";
const slug = address.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);

async function geocode(addr: string) {
  const res = await fetch(
    `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(addr)}&key=${key}`,
  );
  const data = (await res.json()) as {
    status: string;
    results?: { formatted_address: string; geometry: { location: { lat: number; lng: number } } }[];
  };
  if (data.status !== "OK" || !data.results?.[0]) {
    throw new Error(`geocode ${data.status}`);
  }
  return {
    formatted: data.results[0].formatted_address,
    lat: data.results[0].geometry.location.lat,
    lng: data.results[0].geometry.location.lng,
  };
}

async function buildingInsights(lat: number, lng: number): Promise<BuildingInsights | null> {
  const res = await fetch(
    `https://solar.googleapis.com/v1/buildingInsights:findClosest?location.latitude=${lat}&location.longitude=${lng}&requiredQuality=LOW&key=${key}`,
  );
  if (!res.ok) return null;
  const d = (await res.json()) as {
    boundingBox?: { ne: { latitude: number; longitude: number }; sw: { latitude: number; longitude: number } };
    solarPotential?: {
      wholeRoofStats?: { areaMeters2?: number };
      roofSegmentStats?: {
        pitchDegrees?: number;
        azimuthDegrees?: number;
        stats?: { areaMeters2?: number };
        center?: { latitude?: number; longitude?: number };
        boundingBox?: { ne?: { latitude?: number; longitude?: number }; sw?: { latitude?: number; longitude?: number } };
        planeHeightAtCenterMeters?: number;
      }[];
    };
  };
  if (!d.boundingBox) return null;
  const ll = (p?: { latitude?: number; longitude?: number }) =>
    p && typeof p.latitude === "number" && typeof p.longitude === "number"
      ? { lat: p.latitude, lng: p.longitude }
      : null;
  return {
    boundingBoxNE: { lat: d.boundingBox.ne.latitude, lng: d.boundingBox.ne.longitude },
    boundingBoxSW: { lat: d.boundingBox.sw.latitude, lng: d.boundingBox.sw.longitude },
    roofSegments: (d.solarPotential?.roofSegmentStats ?? []).map((s) => ({
      pitchDegrees: s.pitchDegrees ?? 0,
      azimuthDegrees: s.azimuthDegrees ?? 0,
      areaMeters2: s.stats?.areaMeters2 ?? 0,
      center: ll(s.center),
      boundingBoxNE: ll(s.boundingBox?.ne),
      boundingBoxSW: ll(s.boundingBox?.sw),
      planeHeightMeters:
        typeof s.planeHeightAtCenterMeters === "number" ? s.planeHeightAtCenterMeters : null,
    })),
    totalRoofAreaMeters2: d.solarPotential?.wholeRoofStats?.areaMeters2 ?? 0,
    source: "google_solar",
  };
}

/* Canvas(900×580, cover-fit) → image px inverse */
function canvasToImg(p: { x: number; y: number }, W: number, H: number) {
  const scale = Math.max(900 / W, 580 / H);
  const offX = (900 - W * scale) / 2;
  const offY = (580 - H * scale) / 2;
  return { x: (p.x - offX) / scale, y: (p.y - offY) / scale };
}

function drawLine(
  png: PNG,
  a: { x: number; y: number },
  b: { x: number; y: number },
  rgb: [number, number, number],
  thick = 2,
) {
  const steps = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y)));
  for (let i = 0; i <= steps; i++) {
    const x = a.x + ((b.x - a.x) * i) / steps;
    const y = a.y + ((b.y - a.y) * i) / steps;
    for (let dy = -thick; dy <= thick; dy++) {
      for (let dx = -thick; dx <= thick; dx++) {
        const xi = Math.round(x + dx);
        const yi = Math.round(y + dy);
        if (xi < 0 || yi < 0 || xi >= png.width || yi >= png.height) continue;
        const idx = (yi * png.width + xi) * 4;
        png.data[idx] = rgb[0];
        png.data[idx + 1] = rgb[1];
        png.data[idx + 2] = rgb[2];
        png.data[idx + 3] = 255;
      }
    }
  }
}

const t0 = Date.now();
const geo = await geocode(address);
console.log(`geocoded: ${geo.formatted} @ ${geo.lat},${geo.lng}`);
const insights = await buildingInsights(geo.lat, geo.lng);
console.log(
  insights
    ? `insights: ${insights.roofSegments.length} segments, ${Math.round(insights.totalRoofAreaMeters2)} m²`
    : "insights: none",
);

// Mirror the engine's window choice (it can't use the DB vault here, so
// we fetch the layers ourselves and inject them).
let centerLat = geo.lat;
let centerLng = geo.lng;
let radius = 45;
if (insights) {
  centerLat = (insights.boundingBoxNE.lat + insights.boundingBoxSW.lat) / 2;
  centerLng = (insights.boundingBoxNE.lng + insights.boundingBoxSW.lng) / 2;
  const mLat = 110_540;
  const mLng = 111_320 * Math.cos((centerLat * Math.PI) / 180);
  const spanY = Math.abs(insights.boundingBoxNE.lat - insights.boundingBoxSW.lat) * mLat;
  const spanX = Math.abs(insights.boundingBoxNE.lng - insights.boundingBoxSW.lng) * mLng;
  radius = Math.round(Math.min(90, Math.max(32, Math.hypot(spanX, spanY) / 2 + 12)));
}
const layersOutcome = await fetchSolarLayersWithKey(key, centerLat, centerLng, radius);
if (!layersOutcome.ok) {
  console.log("fetchSolarLayers failed:", layersOutcome.reason);
  process.exit(2);
}

const notes: string[] = [];
const result = await runSolarFirstEstimate({
  lat: geo.lat,
  lng: geo.lng,
  insights,
  notes,
  layersOverride: layersOutcome.layers,
});

console.log("\n--- notes ---");
for (const n of notes) console.log("•", n);

if (!result) {
  console.log("\nSOLAR-FIRST ENGINE BAILED (legacy path would run)");
  process.exit(2);
}

console.log("\n--- result ---");
console.log("measurements:", JSON.stringify(result.measurements));
console.log("traceQuality:", JSON.stringify(result.traceQuality));
console.log(
  `eaves: ${result.eaves.length} runs, rakes: ${result.rakes.length}, downspouts: ${result.downspouts.length}, suggested: ${result.suggestedEaves.length}, ridges: ${result.roofStructure.ridges.length}`,
);
console.log(`aerial: ${result.aerial.width}×${result.aerial.height}, canvasPxPerFt=${result.canvasPxPerFt.toFixed(2)}`);
console.log(`durationMs: ${Date.now() - t0}`);

// Canvas-bounds check: every drawn point must live inside the 900×580
// viewBox, or the proposal diagram / 3D tabs clip it.
{
  const all = [
    ...result.eaves.flatMap((e) => e.points),
    ...result.rakes.flatMap((e) => e.points),
    ...result.suggestedEaves.flatMap((e) => e.points),
    ...result.roofStructure.perimeter,
    ...result.downspouts.map((d) => ({ x: d.x, y: d.y })),
  ];
  const out = all.filter(
    (p) => p.x < -1 || p.y < -1 || p.x > 901 || p.y > 581,
  );
  console.log(
    out.length === 0
      ? "bounds: ✓ all geometry inside the 900×580 canvas"
      : `bounds: ✗ ${out.length}/${all.length} points OUTSIDE the canvas`,
  );
  const mp = result.magnetPath ?? [];
  const mpOut = mp.filter((p) => p.x < -1 || p.y < -1 || p.x > 901 || p.y > 581);
  console.log(`magnetPath: ${mp.length} pts, ${mpOut.length} out of canvas`);
  if (out.length > 0) {
    const bucket = (pts: {x:number;y:number}[], name: string) => {
      const o = pts.filter((p) => p.x < -1 || p.y < -1 || p.x > 901 || p.y > 581);
      if (o.length) console.log(`  ${name}: ${o.length} out — e.g.`, o.slice(0, 3));
    };
    bucket(result.eaves.flatMap((e) => e.points), "eaves");
    bucket(result.rakes.flatMap((e) => e.points), "rakes");
    bucket(result.suggestedEaves.flatMap((e) => e.points), "suggested");
    bucket(result.roofStructure.perimeter, "perimeter");
    bucket(result.roofStructure.ridges.flatMap((r) => r.points), "ridges");
    bucket(result.downspouts.map((d) => ({ x: d.x, y: d.y })), "downspouts");
  }
}

// Composite overlay
const b64 = result.aerial.imageDataUrl.split(",")[1];
const png = PNG.sync.read(Buffer.from(b64, "base64"));
const W = png.width;
const H = png.height;
const mapLine = (l: { points: { x: number; y: number }[] }, color: [number, number, number], thick = 2) => {
  for (let i = 1; i < l.points.length; i++) {
    drawLine(png, canvasToImg(l.points[i - 1], W, H), canvasToImg(l.points[i], W, H), color, thick);
  }
};
// Traced footprint perimeter (dark blue, thin) — under everything, so a
// perimeter edge that got neither an eave nor a rake shows as bare blue.
{
  const perim = result.roofStructure.perimeter;
  for (let i = 0; i < perim.length; i++) {
    drawLine(
      png,
      canvasToImg(perim[i], W, H),
      canvasToImg(perim[(i + 1) % perim.length], W, H),
      [40, 60, 255],
      1,
    );
  }
}
for (const r of result.roofStructure.ridges) mapLine(r, [255, 165, 0], 1); // orange ridges
for (const r of result.rakes) mapLine(r, [255, 60, 60], 1); // red rakes
for (const e of result.eaves) mapLine(e, [0, 255, 255], 2); // cyan eaves
for (const s of result.suggestedEaves) mapLine(s, [255, 255, 0], 1); // yellow suggestions
for (const d of result.downspouts) {
  const p = canvasToImg({ x: d.x, y: d.y }, W, H);
  drawLine(png, { x: p.x - 4, y: p.y - 4 }, { x: p.x + 4, y: p.y + 4 }, [255, 0, 255], 2);
  drawLine(png, { x: p.x - 4, y: p.y + 4 }, { x: p.x + 4, y: p.y - 4 }, [255, 0, 255], 2);
}
writeFileSync(`${SCRATCH}/${slug}-overlay.png`, PNG.sync.write(png));
writeFileSync(
  `${SCRATCH}/${slug}-report.json`,
  JSON.stringify(
    {
      address: geo.formatted,
      notes,
      measurements: result.measurements,
      traceQuality: result.traceQuality,
      canvasPxPerFt: result.canvasPxPerFt,
      // Full geometry so accuracy work can diff runs offline without
      // re-hitting the live APIs.
      eaves: result.eaves,
      rakes: result.rakes,
      suggestedEaves: result.suggestedEaves,
      downspouts: result.downspouts,
      perimeter: result.roofStructure.perimeter,
      ridges: result.roofStructure.ridges,
    },
    null,
    2,
  ),
);
console.log(`\nwrote ${slug}-overlay.png + ${slug}-report.json`);
