/**
 * Render the LIVE roof-engine output for the most recent stored Woodinville
 * PlanAnalysis — the real AI footprint + 4-face reads, exactly what the app
 * draws (vs scripts/render-woodinville.mts, the hand-curated target fixture).
 * Run:  npx tsx scripts/render-woodinville-live.mts
 * Writes scripts/woodinville-live.svg / .html (gitignored render outputs).
 */
import { PrismaClient } from "@prisma/client";
import { writeFileSync } from "node:fs";
import { buildEngineTakeoff } from "../lib/ai/engine-takeoff.ts";
import { deriveOrientationFromFaceTitles } from "../lib/ai/plan-orientation.ts";
type Pt = { x: number; y: number };
const db = new PrismaClient();
const row = await db.planAnalysis.findFirst({ where: { filename: { contains: "WOODINVILLE" } }, orderBy: { createdAt: "desc" } });
await db.$disconnect();
if (!row) { console.log("no WOODINVILLE PlanAnalysis found"); process.exit(0); }
const a = row.analysisJson as any;
// Orientation exactly as the app derives it (estimate.ts): elevation TITLES
// first (this plan set draws north DOWN), stored gate orientation as fallback.
const perFace = a._perFace?.per_face ?? null;
const orientation =
  deriveOrientationFromFaceTitles(perFace) ?? a._engine?.orientation ?? null;
if (orientation?.note) console.log("orientation:", orientation.note);
const b = buildEngineTakeoff(a, perFace, a._engine?.roofMasses ?? [], orientation?.normals ?? null);
if (!b) { console.log("engine returned null (no footprint/scale)"); process.exit(0); }
const takeoff: any = b.takeoff;
console.log(`masses: ${takeoff.masses.map((m: any) => m.name).join(", ")} | engine eave LF: ${b.eaveLfFt}`);
for (const f of takeoff.reviewFlags) console.log(`  [${f.severity}] ${f.code}: ${String(f.message).slice(0, 110)}`);

const pts: Pt[] = [];
for (const m of takeoff.masses) { for (const e of m.edges) pts.push(e.p1, e.p2); for (const e of m.interior) pts.push(e.p1, e.p2); for (const p of m.outline) pts.push(p); }
for (const d of takeoff.downspouts) pts.push(d.at);
const minX = Math.min(...pts.map((p) => p.x)), minY = Math.min(...pts.map((p) => p.y)), maxX = Math.max(...pts.map((p) => p.x)), maxY = Math.max(...pts.map((p) => p.y));
const S = 950 / Math.max(maxX - minX, 1);
const PAD = 64;
const W = (maxX - minX) * S + PAD * 2 + 160;
const H = Math.max((maxY - minY) * S + PAD * 2 + 96, W);
const X = (x: number) => (x - minX) * S + PAD;
const Y = (y: number) => (y - minY) * S + PAD;
const COL: Record<string, string> = { eave: "#0284c7", rake: "#94a3b8", ridge: "#dc2626", hip: "#0891b2", valley: "#9333ea" };
const parts: string[] = [`<rect width="${W}" height="${H}" fill="#f8fafc"/>`];
const fills = ["rgba(59,130,246,0.08)", "rgba(16,185,129,0.10)", "rgba(245,158,11,0.10)", "rgba(139,92,246,0.10)"];
takeoff.masses.forEach((m: any, i: number) => { const d = m.outline.map((p: Pt, j: number) => `${j ? "L" : "M"}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join(" ") + " Z"; parts.push(`<path d="${d}" fill="${fills[i % fills.length]}" stroke="none"/>`); });
const line = (p: Pt, q: Pt, c: string, w: number, dash?: boolean) => `<line x1="${X(p.x).toFixed(1)}" y1="${Y(p.y).toFixed(1)}" x2="${X(q.x).toFixed(1)}" y2="${Y(q.y).toFixed(1)}" stroke="${c}" stroke-width="${w}" ${dash ? 'stroke-dasharray="7 5"' : ""} stroke-linecap="round"/>`;
for (const m of takeoff.masses) for (const e of m.interior) parts.push(line(e.p1, e.p2, COL[e.type] ?? "#000", e.type === "ridge" ? 2.6 : 1.9, e.type === "valley"));
for (const m of takeoff.masses) for (const e of m.edges) parts.push(line(e.p1, e.p2, e.gutter ? COL.eave : COL.rake, e.gutter ? 3.6 : 2.2, !e.gutter));
for (const d of takeoff.downspouts) parts.push(`<circle cx="${X(d.at.x).toFixed(1)}" cy="${Y(d.at.y).toFixed(1)}" r="5" fill="#0f172a"/>`);
takeoff.masses.forEach((m: any) => { let cx = 0, cy = 0; for (const p of m.outline) { cx += p.x; cy += p.y; } cx /= m.outline.length; cy /= m.outline.length; parts.push(`<text x="${X(cx).toFixed(1)}" y="${Y(cy).toFixed(1)}" font-family="ui-sans-serif,Arial" font-size="13" font-weight="700" fill="#1e293b" text-anchor="middle" opacity="0.5">${m.name}</text>`); });
parts.push(`<text x="${PAD}" y="30" font-family="ui-sans-serif,Arial" font-size="16" font-weight="700" fill="#0f172a">LIVE AI-trace roof — Woodinville (what the pipeline actually extracted)</text>`);
parts.push(`<text x="${PAD}" y="48" font-family="ui-sans-serif,Arial" font-size="12" fill="#64748b">${takeoff.masses.length} masses · ${b.eaveLfFt} engine eave LF · bottom = FRONT/N, left = EAST · from the stored PlanAnalysis</text>`);
const legend: [string, string][] = [["eave (gutter)", COL.eave], ["rake / gable end", COL.rake], ["ridge", COL.ridge], ["hip", COL.hip], ["valley", COL.valley], ["downspout ●", "#0f172a"]];
let lx = PAD; const ly = H - 44;
for (const [label, c] of legend) { parts.push(`<line x1="${lx}" y1="${ly}" x2="${lx + 28}" y2="${ly}" stroke="${c}" stroke-width="3.6" stroke-linecap="round"/>`); parts.push(`<text x="${lx + 34}" y="${ly + 4}" font-family="ui-sans-serif,Arial" font-size="12.5" fill="#334155">${label}</text>`); lx += 34 + label.length * 7.2 + 26; }
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join("")}</svg>`;
writeFileSync("scripts/woodinville-live.svg", svg);
writeFileSync("scripts/woodinville-live.html", `<!doctype html><meta charset="utf-8"><body style="margin:0">${svg}</body>`);
console.log(`wrote scripts/woodinville-live.svg (${Math.round(W)}x${Math.round(H)})`);
