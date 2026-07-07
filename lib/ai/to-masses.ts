/**
 * to-masses.ts — bridge the EXISTING flat `BlueprintAnalysis` into the roof
 * engine's world so the area gate (the spec's explicit first thing to build)
 * and the closure gate can run on today's real uploads immediately, WITHOUT
 * waiting for the enriched one-sheet-at-a-time reading.
 *
 * This is pure VALIDATION: it never mutates geometry and never touches the
 * priced totals (those still come from the reconciled `gutter_runs`). It only
 * emits `ReviewFlag`s — so it can never make a takeoff worse, only surface which
 * mass the reader botched.
 *
 * What it does:
 *  1. Unify the two parallel arrays (`gutter_runs` + `excluded_edges`) into a
 *     single classified `edges[]` per footprint edge — a proto `Mass.edges`.
 *  2. Run the AREA GATE: footprint area vs the schedule area (width × depth from
 *     the classifier). Needs an INDEPENDENT px→ft scale to be meaningful; when
 *     absent it reports `no_schedule` (honest) and falls back to a scale-free
 *     aspect-ratio check that still catches gross mis-reads.
 *  3. Run the CLOSURE gate on the footprint ring.
 *
 * PURE + never throws: any failure returns empty flags (worst case = today).
 */

import type { BlueprintAnalysis } from "./blueprint-from-plans";
import type { PlanClassification } from "./classify-plans";
import { polyArea, polygonCloses, type Edge, type Mass, type ReviewFlag } from "../roof-engine";
import { cleanRing, isFinitePt, type Pt } from "../roof-skeleton";

export type BlueprintValidation = {
  /** The single footprint mass with unified, classified edges. */
  mass: Mass | null;
  /** ft per pixel used for the area gate, or null when no independent scale. */
  scaleFtPerPx: number | null;
  reviewFlags: ReviewFlag[];
};

export type ScheduleAreaHit = {
  areaFt2: number;
  /** What the callout was labelled (floor/footprint > roof > total), so the
   *  human can judge whether it's the right area to compare a plan polygon to. */
  label: string;
};

/**
 * Parse a stated schedule / title-block AREA (ft²) out of raw plan text. This is
 * the AUTHORITATIVE input to the area gate when present; width × depth is the
 * always-available backstop. Deterministic + pure so it's node-testable.
 *
 * A real plan set is FULL of area callouts that are NOT the building's roof
 * (a Woodinville set has LOT AREA 21001, TOTAL LOT COV'G 9346, IMPERVIOUS,
 * DRIVEWAY, GARAGE 674, and a 2-story CONDITIONED FLOOR 4667). So we:
 *  - REJECT site / coverage / partial-structure contexts outright;
 *  - PREFER the ROOF area (per the spec, the roof-edge polygon compares to a
 *    roof-area schedule), then the building FOOTPRINT, then a single FLOOR,
 *    and DEPRIORITIZE 2-story totals (TOTAL / CONDITIONED / HEATED / GROSS);
 *  - within the best tier take the LARGEST (the whole/main roof, not a small
 *    porch/patio sub-roof).
 * Positive keywords win over the reject list, so "ROOF & GUTTERS AREA" under an
 * "IMPERVIOUS AREA" header is still read as a roof area. Bounds the value so a
 * "12 SF" detail note can't hijack it.
 */
export function parseScheduleAreaFt2(text: string): ScheduleAreaHit | null {
  if (!text || typeof text !== "string") return null;
  const T = text.replace(/\s+/g, " ");
  // A number (opt. thousands commas / decimal) directly followed by an area
  // unit: SF / S.F. / SQ FT / SQ. FT. / SQUARE FEET / FT2 / FT². The lookbehind
  // rejects a number that's part of a larger token (phone "555-1234 SF",
  // dimension "24'-0", a decimal tail) so those can't masquerade as an area.
  const re =
    /(?<![\d.'\-])([0-9][0-9,]{2,6}(?:\.[0-9]+)?)\s*(?:s\.?\s?f\.?|sq\.?\s?ft\.?|sq\.?\s?feet|square\s+feet|ft\s?2|ft²)\b/gi;
  const hits: { value: number; tier: number; label: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(T)) !== null) {
    const numStr = m[1];
    // Reject malformed thousands grouping like "1,2,345" (real areas group as
    // 1-3 digits then ,ddd groups). A comma-free number is always fine.
    if (numStr.includes(",") && !/^\d{1,3}(?:,\d{3})+$/.test(numStr)) continue;
    const value = Number(numStr.replace(/,/g, ""));
    if (!Number.isFinite(value) || value < 200 || value > 50000) continue;
    const ctx = T.slice(Math.max(0, m.index - 26), m.index).toUpperCase();
    let tier: number;
    let label: string;
    if (/ROOF/.test(ctx)) {
      tier = 1;
      label = "roof area";
    } else if (/FOOT ?PRINT/.test(ctx)) {
      tier = 2;
      label = "footprint area";
    } else if (/\b(?:LOT|SITE|IMPERVIOUS|DRIVE|SIDE ?WALK|WALK|HVAC|PAD|COVERAGE|COV'?G|EASEMENT|LANDSCAP|GARAGE)\b/.test(ctx)) {
      continue; // site / coverage / partial area — never the roof footprint
    } else if (/TOTAL|CONDITION|HEATED|GROSS/.test(ctx)) {
      tier = 4; // 2-story aggregate — deprioritize (≈2× a single-mass footprint)
      label = "total/conditioned area";
    } else if (/(?:MAIN|FIRST|GROUND|LIVING)\s*(?:FLOOR|LEVEL)|FLOOR AREA|PLAN AREA/.test(ctx)) {
      tier = 3;
      label = "floor area";
    } else {
      tier = 5;
      label = "stated area";
    }
    hits.push({ value, tier, label });
  }
  if (hits.length === 0) return null;
  // Best tier wins; within a tier prefer the LARGEST area (whole/main roof).
  hits.sort((a, b) => a.tier - b.tier || b.value - a.value);
  return { areaFt2: hits[0].value, label: hits[0].label };
}

/** A per-mass roof area stated in a roof schedule (roof-vent / roofing table).
 *  `label` is normalized (upper/main/patio/porch/garage/lower). Used to resolve
 *  a projecting gable's DEPTH = area ÷ span (LAW 2 — depth from the plan, not the
 *  face view). */
export type RoofMassArea = { label: string; areaFt2: number };

/**
 * Parse per-mass ROOF areas out of a roof schedule, e.g. the roof-VENTILATION
 * table which lists "UPPER ROOF … Roof Area 2902 s.f.", "PATIO ROOF … Roof Area
 * 228 s.f.", "PORCH ROOF … Roof Area 180 s.f.". Deterministic + pure.
 *
 * These are plan-projected roof areas, so for a gable roof over a rectangular
 * mass, area ≈ span × depth — which lets us recover a projection DEPTH that a
 * face elevation can't give. Returns one entry per (label, area) found.
 */
export function parseRoofMasses(text: string): RoofMassArea[] {
  if (!text || typeof text !== "string") return [];
  const T = text.replace(/\s+/g, " ");
  const out: RoofMassArea[] = [];
  const seen = new Set<string>();
  // "<LABEL> ROOF …(<=60 chars)… ROOF AREA <n> s.f."
  const re =
    /\b(UPPER|MAIN|LOWER|PATIO|PORCH|GARAGE|DECK)\s+ROOF\b[\s\S]{0,60}?ROOF\s*AREA\s*[:=]?\s*([0-9][0-9,]{1,6}(?:\.[0-9]+)?)\s*(?:s\.?\s?f\.?|sq\.?\s?ft\.?|square\s+feet)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(T)) !== null) {
    const numStr = m[2];
    if (numStr.includes(",") && !/^\d{1,3}(?:,\d{3})+$/.test(numStr)) continue;
    const areaFt2 = Number(numStr.replace(/,/g, ""));
    if (!Number.isFinite(areaFt2) || areaFt2 < 50 || areaFt2 > 50000) continue;
    const label = m[1].toLowerCase();
    const key = `${label}:${areaFt2}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label, areaFt2 });
  }
  return out;
}

export type ValidateOptions = {
  /** Authoritative stated area (ft²) from the title-block/schedule, when found.
   *  Takes priority over the classifier's width × depth. */
  statedScheduleAreaFt2?: number | null;
  /** Label of the schedule area (for the flag message). */
  scheduleLabel?: string;
};

/** An independent px→ft scale from the roof-plan scale reading (NOT derived from
 *  the footprint itself, which would make the area gate circular). */
function independentScaleFtPerPx(analysis: BlueprintAnalysis): number | null {
  const s = analysis?.scale;
  if (!s) return null;
  // `unit: "pixels"` means feet_per_unit is feet-per-pixel — exactly what we
  // need. `inches_on_paper` would require the raster DPI to convert; skip it
  // rather than guess.
  if (s.unit === "pixels" && typeof s.feet_per_unit === "number" && s.feet_per_unit > 0 && Number.isFinite(s.feet_per_unit))
    return s.feet_per_unit;
  return null;
}

export function scheduleAreaFt2(classification?: PlanClassification | null): number | null {
  const d = classification?.building_dimensions;
  if (!d) return null;
  const w = d.width_ft;
  const h = d.depth_ft;
  if (typeof w === "number" && w > 0 && typeof h === "number" && h > 0) return w * h;
  return null;
}

function bbox(poly: Pt[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of poly) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { w: maxX - minX, h: maxY - minY };
}

/**
 * Scale-free shape check: does the footprint's ELONGATION (long side / short
 * side) match the stated width:depth? Uses magnitudes so a 90° drawing rotation
 * (portrait vs landscape) doesn't false-flag — we only care whether the box has
 * the right proportions, not its orientation. Returns null when no dims.
 */
function shapeCheck(
  ringPx: Pt[],
  classification?: PlanClassification | null,
): { off: boolean; traceElong: number; statedElong: number; w: number; h: number } | null {
  const d = classification?.building_dimensions;
  if (!d || !(typeof d.width_ft === "number" && d.width_ft > 0) || !(typeof d.depth_ft === "number" && d.depth_ft > 0))
    return null;
  const bb = bbox(ringPx);
  if (!(bb.w > 0) || !(bb.h > 0)) return null;
  const statedElong = Math.max(d.width_ft, d.depth_ft) / Math.min(d.width_ft, d.depth_ft);
  const traceElong = Math.max(bb.w, bb.h) / Math.min(bb.w, bb.h);
  const ratio = traceElong / statedElong;
  return { off: ratio > 1.35 || ratio < 1 / 1.35, traceElong, statedElong, w: d.width_ft, h: d.depth_ft };
}

/**
 * The footprint's area in ft² computed WITHOUT trusting the AI's absolute scale
 * — which is unreliable (the AI's footprint-px and scale-ft frequently disagree,
 * and runEstimateFromPlan later swaps the footprint into the vector-outline's
 * coordinate space without updating `scale`). Instead we anchor on the ONE
 * trusted absolute number, the stated overall dimension, by matching the
 * footprint's longer bbox side to the larger of width/depth (an isotropic scale
 * — a plan is drawn to scale). This yields a believable area from the footprint's
 * own shape; comparing it to the stated schedule area then validates depth / fill
 * (a missing wing) rather than the meaningless absolute scale.
 */
export function selfConsistentAreaFt2(ringPx: Pt[], classification?: PlanClassification | null): number | null {
  const d = classification?.building_dimensions;
  const w = typeof d?.width_ft === "number" && d.width_ft > 0 ? d.width_ft : 0;
  const h = typeof d?.depth_ft === "number" && d.depth_ft > 0 ? d.depth_ft : 0;
  const overallMax = Math.max(w, h);
  if (!(overallMax > 0)) return null;
  const bb = bbox(ringPx);
  const bbMax = Math.max(bb.w, bb.h);
  if (!(bbMax > 0)) return null;
  const scale = overallMax / bbMax; // ft per px, from the trusted overall dim
  return polyArea(ringPx) * scale * scale;
}

/** Fraction of edge a→b covered by segment s, when s lies on the edge's line
 *  within `tol` and overlaps it. Compact local copy (reconcile-eaves keeps its
 *  own; the two modules stay decoupled). */
function edgeCoverage(a: Pt, b: Pt, s: { a: Pt; b: Pt }, tol: number): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len <= 0) return 0;
  const ux = dx / len;
  const uy = dy / len;
  const perp = (p: Pt) => Math.abs((p.x - a.x) * -uy + (p.y - a.y) * ux);
  if (perp(s.a) > tol || perp(s.b) > tol) return 0;
  const t = (p: Pt) => ((p.x - a.x) * ux + (p.y - a.y) * uy) / len;
  let t0 = t(s.a);
  let t1 = t(s.b);
  if (t0 > t1) [t0, t1] = [t1, t0];
  return Math.max(0, Math.min(1, t1) - Math.max(0, t0));
}

/**
 * Validate a blueprint analysis against the roof engine's gates. Pure; returns
 * flags only.
 */
export function validateBlueprintGeometry(
  analysis: BlueprintAnalysis,
  classification?: PlanClassification | null,
  options?: ValidateOptions,
): BlueprintValidation {
  const flags: ReviewFlag[] = [];
  try {
    const rawPoly = (analysis?.building_footprint ?? []).filter(isFinitePt);
    if (rawPoly.length < 4) return { mass: null, scaleFtPerPx: null, reviewFlags: flags };

    const span = Math.max(bbox(rawPoly).w, bbox(rawPoly).h);
    const tol = Math.max(2, span * 0.012);
    const ringPx = cleanRing(rawPoly, tol);
    if (ringPx.length < 4) return { mass: null, scaleFtPerPx: null, reviewFlags: flags };

    const ftPerPx = independentScaleFtPerPx(analysis);
    const toFt = (p: Pt): Pt => (ftPerPx ? { x: p.x * ftPerPx, y: p.y * ftPerPx } : p);
    const ring = ringPx.map(toFt);

    // 1. Unify edges: each footprint edge is an eave if a gutter_run covers >50%
    //    of it, else look for an excluded_edge classification, else "rake".
    const gutterSegs = (analysis.gutter_runs ?? [])
      .map((r) => ({ a: r.start as Pt, b: r.end as Pt }))
      .filter((s) => isFinitePt(s.a) && isFinitePt(s.b));
    const excludedSegs = (analysis.excluded_edges ?? [])
      .map((x) => ({ a: x.start as Pt, b: x.end as Pt, kind: x.kind }))
      .filter((s) => isFinitePt(s.a) && isFinitePt(s.b));

    const edges: Edge[] = [];
    const eaveTol = Math.max(2, span * 0.02);
    for (let i = 0; i < ringPx.length; i++) {
      const aPx = ringPx[i];
      const bPx = ringPx[(i + 1) % ringPx.length];
      const guttered = gutterSegs.reduce((m, s) => Math.max(m, edgeCoverage(aPx, bPx, s, eaveTol)), 0) > 0.5;
      let type: Edge["type"] = "rake";
      let gutter = false;
      if (guttered) {
        type = "eave";
        gutter = true;
      } else {
        const ex = excludedSegs.find((s) => edgeCoverage(aPx, bPx, s, eaveTol) > 0.5);
        if (ex) type = ex.kind === "eave_no_gutter" ? "eave" : ex.kind === "dormer_rake" ? "rake" : (ex.kind as Edge["type"]);
      }
      edges.push({ p1: toFt(aPx), p2: toFt(bPx), type, gutter, source: "blueprint" });
    }

    // Schedule-area priority: title-block area (authoritative) → width × depth
    // (backstop). Aspect ratio (scale-free) is the last resort below.
    const titleArea =
      options?.statedScheduleAreaFt2 != null && options.statedScheduleAreaFt2 > 0
        ? options.statedScheduleAreaFt2
        : null;
    const wd = scheduleAreaFt2(classification);
    const stated = titleArea ?? wd;
    const statedSource =
      titleArea != null
        ? `title-block ${options?.scheduleLabel ?? "schedule"}`
        : wd != null
          ? "width × depth"
          : null;

    const mass: Mass = {
      name: "main",
      outline: ring,
      statedArea: ftPerPx ? stated ?? null : null, // area gate only when scaled
      edges,
      interior: [],
    };

    // 2. Closure gate.
    if (!polygonCloses(ring)) {
      flags.push({
        code: "outline_open",
        severity: "warn",
        mass: mass.name,
        message: `[main] footprint outline self-intersects or is degenerate — the trace needs review.`,
      });
    }

    // 3. Area gate. Scaled comparison when we have a declared scale, but a HUGE
    //    miss is diagnosed as a scale mismatch (not a missing plane) and deferred
    //    to the scale-free shape check.
    const shape = shapeCheck(ringPx, classification);
    if (ftPerPx && stated != null) {
      const computed = polyArea(ring);
      // width × depth is a BOUNDING BOX, not a real roof/footprint area. An
      // articulated (L/T/U) house fills only PART of its box, so comparing the
      // POLYGON area to it false-flags "a plane may be missing" on a perfectly
      // good trace (a Woodinville L fills ~57% of its box → a phantom 43% miss).
      // Against a bounding box, GAUGE the trace's own bounding box — does it span
      // the stated extent? — and treat the polygon-vs-box shortfall as expected
      // articulation. Against a real schedule/roof area, compare the polygon area.
      const vsBox = statedSource === "width × depth";
      const bb = bbox(ringPx);
      const traceBoxFt = bb.w * ftPerPx * (bb.h * ftPerPx);
      const gauge = vsBox ? traceBoxFt : computed;
      const diff = Math.abs(gauge - stated) / stated;
      if (diff > 0.5) {
        // A >50% miss at a DECLARED scale is almost never one missing plane — it
        // means the declared px→ft scale doesn't match the footprint's own
        // coordinate space (the AI's footprint-px and scale-ft disagree, and the
        // footprint is later re-spaced without rescaling). The measured-run LF is
        // scale-independent, so it's unaffected. Re-check using the footprint's
        // OWN scale (anchored on the trusted overall dimension) for a real area.
        const selfArea = selfConsistentAreaFt2(ringPx, classification);
        let verdict: string;
        if (selfArea != null) {
          const selfDiff = Math.abs(selfArea - stated) / stated;
          verdict =
            selfDiff <= 0.25
              ? `re-scaled from the footprint's own geometry it's ~${selfArea.toFixed(0)} sf vs stated ${stated.toFixed(0)} sf (${(selfDiff * 100).toFixed(0)}% — reconciles), so the declared scale was just mislabeled and the priced LF (measured) is unaffected`
              : `even re-scaled from the footprint's own geometry it's ~${selfArea.toFixed(0)} sf vs stated ${stated.toFixed(0)} sf (${(selfDiff * 100).toFixed(0)}% off) — re-check the footprint trace (a wing/mass may be missing)`;
        } else if (shape) {
          verdict = shape.off
            ? `and the footprint PROPORTIONS also look wrong (elongation ${shape.traceElong.toFixed(2)} vs stated ${shape.statedElong.toFixed(2)}) — re-check the footprint trace`
            : `but the footprint PROPORTIONS match the stated ${shape.w}×${shape.h} ft — the shape is likely fine and only the declared scale is off; the priced LF (measured) is unaffected`;
        } else {
          verdict = "verify the declared plan scale";
        }
        flags.push({
          code: "area_gate",
          severity: "warn",
          mass: mass.name,
          message:
            `[main] area gate: declared scale gives ${gauge.toFixed(0)} sf${vsBox ? " (trace extent)" : ""} vs stated ${stated.toFixed(0)} sf ` +
            `(${statedSource}) — ${(diff * 100).toFixed(1)}% off. Likely a SCALE MISMATCH (AI footprint-px vs declared plan scale), not a missing plane; ${verdict}.`,
        });
      } else {
        const over = diff > 0.15;
        flags.push({
          code: "area_gate",
          severity: over ? "warn" : "info",
          mass: mass.name,
          message: vsBox
            ? `[main] area gate: the trace spans a ${traceBoxFt.toFixed(0)} sf envelope (footprint ${computed.toFixed(0)} sf; the rest is normal articulation) vs the stated ${stated.toFixed(0)} sf width×depth box — ${(diff * 100).toFixed(1)}% off — ${over ? "FLAG (the trace may not cover the full building)" : "OK"}.`
            : `[main] area gate: computed ${computed.toFixed(0)} sf vs stated ${stated.toFixed(0)} sf ` +
              `(${statedSource}) — ${(diff * 100).toFixed(1)}% off — ${over ? "FLAG (a plane, wing, or gable may be missing)" : "OK"}.`,
        });
      }
    } else {
      const reason = !ftPerPx ? "no independent px→ft scale" : "no schedule area";
      flags.push({
        code: "no_schedule",
        severity: "info",
        mass: mass.name,
        message: `[main] area gate skipped (${reason}); footprint area unverified.`,
      });
      // Scale-free sanity: footprint elongation vs stated width:depth.
      if (shape?.off) {
        flags.push({
          code: "area_gate",
          severity: "warn",
          mass: mass.name,
          message: `[main] footprint proportions (elongation ${shape.traceElong.toFixed(2)}) don't match stated ${shape.w}×${shape.h} ft (elongation ${shape.statedElong.toFixed(2)}) — the trace may be mis-scaled or missing a wing.`,
        });
      }
    }

    return { mass, scaleFtPerPx: ftPerPx, reviewFlags: flags };
  } catch {
    return { mass: null, scaleFtPerPx: null, reviewFlags: flags };
  }
}
