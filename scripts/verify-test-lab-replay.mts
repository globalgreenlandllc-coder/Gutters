/**
 * End-to-end verification of the ADMIN ACCURACY LAB's capture→replay loop:
 *
 *   1. run the solar engine live (capturing layers via onLayers, exactly
 *      like runLabEstimate does)
 *   2. serialize → deserialize the layer snapshot (the DB round-trip)
 *   3. REPLAY the engine offline via layersOverride + frozen nowMs
 *   4. score the replay against the original output — identical engine +
 *      identical inputs must score ~100 and "clean"
 *
 * Run:  NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-test-lab-replay.mts "ADDRESS"
 * Needs GOOGLE_MAPS_API_KEY in the project .env (live APIs for step 1 only).
 */
import { readFileSync } from "node:fs";
import { fetchSolarLayersWithKey, type SolarLayers } from "../lib/ai/solar-layers.ts";
import { runSolarFirstEstimate } from "../lib/ai/solar-engine.ts";
import type { BuildingInsights } from "../lib/ai/solar.ts";
import { deserializeSolarLayers, serializeSolarLayers } from "../lib/test-lab/layers-io.ts";
import { scoreAgainstTruth } from "../lib/test-lab/score.ts";
import { computeLabDiff } from "../lib/test-lab/diff.ts";

const env = readFileSync(new URL("../.env", import.meta.url), "utf8");
const key = env.match(/^GOOGLE_MAPS_API_KEY="?([^"\n]+)"?/m)?.[1];
if (!key) throw new Error("no GOOGLE_MAPS_API_KEY in .env");

const address = process.argv[2] ?? "6232 97th Dr NE, Lake Stevens, WA 98258, USA";

async function geocode(addr: string) {
  const res = await fetch(
    `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(addr)}&key=${key}`,
  );
  const data = (await res.json()) as {
    status: string;
    results?: { geometry: { location: { lat: number; lng: number } } }[];
  };
  if (data.status !== "OK" || !data.results?.[0]) throw new Error(`geocode ${data.status}`);
  return data.results[0].geometry.location;
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
        pitchDegrees?: number; azimuthDegrees?: number;
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

const { lat, lng } = await geocode(address);
const insights = await buildingInsights(lat, lng);
console.log(`geocoded ${address} → ${lat.toFixed(6)},${lng.toFixed(6)}; insights: ${insights ? insights.roofSegments.length + " segments" : "none"}`);

// ---- 1. LIVE run with capture (mirrors runLabEstimate) -----------------
let captured: SolarLayers | null = null;
const notes1: string[] = [];
// The engine's own fetch path uses the DB vault; inject layers the same
// way app code ends up with them by pre-fetching with the env key, then
// letting the engine run on the override while ALSO exercising onLayers.
let centerLat = lat, centerLng = lng, radius = 45;
if (insights) {
  centerLat = (insights.boundingBoxNE.lat + insights.boundingBoxSW.lat) / 2;
  centerLng = (insights.boundingBoxNE.lng + insights.boundingBoxSW.lng) / 2;
  const mLat = 110_540;
  const mLng = 111_320 * Math.cos((centerLat * Math.PI) / 180);
  const spanY = Math.abs(insights.boundingBoxNE.lat - insights.boundingBoxSW.lat) * mLat;
  const spanX = Math.abs(insights.boundingBoxNE.lng - insights.boundingBoxSW.lng) * mLng;
  radius = Math.round(Math.min(90, Math.max(32, Math.hypot(spanX, spanY) / 2 + 12)));
}
const outcome = await fetchSolarLayersWithKey(key, centerLat, centerLng, radius);
if (!outcome.ok) throw new Error(`layers fetch failed: ${outcome.reason}`);

const original = await runSolarFirstEstimate({
  lat, lng, insights, notes: notes1,
  layersOverride: outcome.layers,
  onLayers: (l) => { captured = l; },
});
if (!original) throw new Error(`engine returned null: ${notes1.join(" | ")}`);
if (!captured) throw new Error("onLayers capture hook never fired");
console.log(`live run: ${original.eaves.length} eaves, ${Math.round(original.measurements.eaveLF)} LF, ${original.downspouts.length} downspouts`);

// ---- 2. DB round-trip ---------------------------------------------------
const packed = serializeSolarLayers(captured);
console.log(`snapshot: ${(packed.length / 1024).toFixed(0)} KB base64-gzip`);
const restored = deserializeSolarLayers(packed);

// ---- 3. OFFLINE replay --------------------------------------------------
const notes2: string[] = [];
const replay = await runSolarFirstEstimate({
  lat, lng, insights, notes: notes2,
  layersOverride: restored,
  nowMs: Date.now(), // frozen clock — same semantics retestLabRun uses
});
if (!replay) throw new Error(`replay returned null: ${notes2.join(" | ")}`);
console.log(`replay:   ${replay.eaves.length} eaves, ${Math.round(replay.measurements.eaveLF)} LF, ${replay.downspouts.length} downspouts`);

// ---- 4. Score + diff: identical engine ⇒ identical output ---------------
const score = scoreAgainstTruth(
  { eaves: replay.eaves, downspouts: replay.downspouts, pxPerFt: replay.canvasPxPerFt },
  { eaves: original.eaves, downspouts: original.downspouts, pxPerFt: original.canvasPxPerFt },
);
const diff = computeLabDiff(
  { eaves: original.eaves, rakes: original.rakes, downspouts: original.downspouts },
  { eaves: replay.eaves, rakes: replay.rakes, downspouts: replay.downspouts },
  original.canvasPxPerFt,
);
console.log(`score: ${score.scorePct}% (F1 ${score.eaveF1}, clean ${score.clean}); diff clean: ${diff.isClean}`);

if (score.scorePct < 100 || !diff.isClean) {
  console.error("FAIL — replay diverged from the live run");
  process.exit(1);
}
console.log("PASS — capture → serialize → replay is bit-faithful");
