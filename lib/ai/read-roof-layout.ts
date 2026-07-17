import type Anthropic from "@anthropic-ai/sdk";
import type { PlanSource } from "./blueprint-from-plans";
import type { ElevationFaceName, FaceReadingRaw } from "./face-merge";

/**
 * read-roof-layout.ts — read the ROOF FRAMING / ROOF PLAN page as the
 * LAYOUT TRUTH (owner doctrine).
 *
 * When a plan set has a roof plan / roof framing page, that page shows the
 * actual roof layout — hips at every corner, gutter callouts, downspout dots,
 * tier steps. It must be read as the PRIMARY layout source, ABOVE the
 * elevations (the fallback, because not every set prints such a page), which
 * in turn rank above the vision trace's own claims. Live failure this fixes:
 * on the 1168G scan two elevation reads died with transient 529s, hip
 * unanimity couldn't form, and the trace's hallucinated "gable ends left and
 * right" unpriced both long walls (151 LF vs ~269 true) — while page 6 of the
 * very same PDF printed the full hip layout that answers everything.
 *
 * MODULE SHAPE (deliberate, mirrors the face-merge/read-elevations split):
 * everything around the single vision call is PURE and lives at module top
 * level with NO server-only imports, so the parser / evidence conversion /
 * priority merge run under `node --test`. The vision call itself pulls its
 * server deps (Anthropic client, api-keys, prompt registry) via dynamic
 * import inside the function — it only executes in a server context. Do not
 * add a top-level `import "server-only"` or a static import of a server
 * module here; that would break the pure tests.
 *
 * Fully fail-safe: the read never throws — any error degrades to
 * `readable:false`, and every downstream consumer treats an absent/unreadable
 * reading as "no roof page" (byte-identical legacy behavior; old stashes have
 * no `_roofPlanRead` field at all).
 */

// Vision read of a (often scanned) roof framing sheet — hip diagonals vs
// rakes is precision work, same class as the per-face elevation reads, so the
// default matches read-elevations.ts. Override with BLUEPRINT_ROOFPLAN_MODEL.
const MODEL = process.env.BLUEPRINT_ROOFPLAN_MODEL || "claude-sonnet-5";

export const ROOF_PLAN_SIDES = ["front", "rear", "left", "right"] as const;
export type RoofPlanSideName = (typeof ROOF_PLAN_SIDES)[number];

export type RoofPlanSide = {
  /** One guttered eave line runs this side's full width (tier steps don't
   *  break it; a rake does). null = genuinely unreadable. */
  eave_continuous: boolean | null;
  /** This side terminates in a straight rake (ridge dead-ends into the
   *  perimeter — NO gutter across it). false = hips close the side. */
  gable_end: boolean | null;
  /** Fascia steps on this side (parallel offset eave lines — tier changes). */
  steps: number | null;
  /** Downspout dots/"D.S." marks printed on this side. */
  ds_marks: number | null;
};

export type RoofPlanReading = {
  readable: boolean;
  unreadable_reason: string | null;
  sides: Record<RoofPlanSideName, RoofPlanSide>;
  /** 45° diagonals meet EVERY outline corner — a fully hipped roof. */
  hips_at_corners: boolean | null;
  /** Every downspout mark printed on the whole page. */
  total_ds_marks: number | null;
  /** Part of the roof is flat/low-slope (drains to scuppers, not gutters). */
  flat_sections: boolean | null;
  confidence: "high" | "medium" | "low";
  notes: string[];
};

export type RoofPlanReadResult = {
  reading: RoofPlanReading;
  /** 1-based page the reader was pointed at (from the Stage-1 classifier). */
  page: number | null;
  usage: { input_tokens: number; output_tokens: number };
};

/* ------------------------------------------------------------------ */
/* PURE: defensive parsing                                             */
/* ------------------------------------------------------------------ */

const asBool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const asCount = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null;

function parseSide(v: unknown): RoofPlanSide {
  const s =
    v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : ({} as Record<string, unknown>);
  return {
    eave_continuous: asBool(s.eave_continuous),
    gable_end: asBool(s.gable_end),
    steps: asCount(s.steps),
    ds_marks: asCount(s.ds_marks),
  };
}

/**
 * Coerce a raw tool output / stored stash blob into a RoofPlanReading.
 * Garbage-tolerant: wrong types become nulls, never dropped fields; a
 * non-object returns null (treated everywhere as "no roof page read").
 */
export function parseRoofPlanReading(raw: unknown): RoofPlanReading | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const sidesRaw =
    r.sides && typeof r.sides === "object" && !Array.isArray(r.sides)
      ? (r.sides as Record<string, unknown>)
      : ({} as Record<string, unknown>);
  return {
    readable: r.readable !== false,
    unreadable_reason:
      typeof r.unreadable_reason === "string" && r.unreadable_reason.trim()
        ? r.unreadable_reason
        : null,
    sides: {
      front: parseSide(sidesRaw.front),
      rear: parseSide(sidesRaw.rear),
      left: parseSide(sidesRaw.left),
      right: parseSide(sidesRaw.right),
    },
    hips_at_corners: asBool(r.hips_at_corners),
    total_ds_marks: asCount(r.total_ds_marks),
    flat_sections: asBool(r.flat_sections),
    confidence:
      r.confidence === "high" || r.confidence === "medium" ? r.confidence : "low",
    notes: Array.isArray(r.notes)
      ? r.notes.filter((n): n is string => typeof n === "string" && n.trim().length > 0).slice(0, 12)
      : [],
  };
}

export function emptyRoofPlanReading(reason: string): RoofPlanReading {
  const side = (): RoofPlanSide => ({
    eave_continuous: null,
    gable_end: null,
    steps: null,
    ds_marks: null,
  });
  return {
    readable: false,
    unreadable_reason: reason,
    sides: { front: side(), rear: side(), left: side(), right: side() },
    hips_at_corners: null,
    total_ds_marks: null,
    flat_sections: null,
    confidence: "low",
    notes: [],
  };
}

/* ------------------------------------------------------------------ */
/* PURE: converting the reading into per-face evidence                 */
/* ------------------------------------------------------------------ */

function sideHasVerdict(s: RoofPlanSide): boolean {
  return s.eave_continuous !== null || s.gable_end !== null;
}

/**
 * Convert the roof-page sides into the minimal per-face shape the downstream
 * consumers understand (the `{ readable, continuous_eave, gable_count }`
 * slice of a FaceReadingRaw). Only sides with an actual verdict get an entry.
 *
 * Field choices are deliberate:
 *  - `gable_end:false` on a fully hipped page ⇒ roof_form "hipped",
 *    gable_count 0, gables [] — qualifies for the closure's
 *    ELEVATION-EAVE-WINS restoration and for explainUnanimousHip;
 *  - `gable_end:true` ⇒ roof_form "gabled", gable_count 1 — vetoes hip
 *    unanimity and keeps that side's rake unpriced (gutter-protective in the
 *    no-overbilling direction);
 *  - `eave_steps` is deliberately ABSENT (the page reports a count, not
 *    positions) so every eave-step consumer degrades to its legacy behavior.
 */
export function roofPlanAsFaceEvidence(
  reading: RoofPlanReading | null | undefined,
): Partial<Record<RoofPlanSideName, FaceReadingRaw>> {
  const out: Partial<Record<RoofPlanSideName, FaceReadingRaw>> = {};
  if (!reading || !reading.readable) return out;
  for (const face of ROOF_PLAN_SIDES) {
    const s = reading.sides[face];
    if (!sideHasVerdict(s)) continue;
    out[face] = {
      face: face as ElevationFaceName,
      sheet_title: null,
      readable: true,
      unreadable_reason: null,
      roof_form:
        s.gable_end === true
          ? "gabled"
          : s.gable_end === false
            ? reading.hips_at_corners === true
              ? "hipped"
              : "unknown"
            : "unknown",
      gable_count: s.gable_end === true ? 1 : s.gable_end === false ? 0 : null,
      continuous_eave: s.eave_continuous === true,
      gables: [],
      projections: [],
      projection_cues: [],
      stories_visible: null,
      confidence: reading.confidence,
    };
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* PURE: priority merge — roof page > elevations > (trace, downstream)  */
/* ------------------------------------------------------------------ */

export type LayoutEvidenceMerge = {
  /** The merged per-face map — drop-in for every consumer that took the
   *  elevation per-face map (tierCornerVeto, reconcileEaveSteps,
   *  explainUnanimousHip, closeVectorPerimeter). */
  perFace: Record<string, FaceReadingRaw>;
  /** "📄 Roof-plan page: …" note strings naming which source ruled each side. */
  notes: string[];
  /** True when the roof page actually filled or overrode at least one face —
   *  callers keep the ORIGINAL map (byte-identical) when false. */
  usedRoofPlan: boolean;
};

function describeSideVerdict(s: RoofPlanSide): string {
  const bits: string[] = [];
  if (s.gable_end === true) bits.push("a gable end (rake — no gutter across it)");
  else if (s.eave_continuous === true)
    bits.push(
      s.gable_end === false
        ? "a continuous guttered eave (hips close the side, no gable end)"
        : "a continuous guttered eave",
    );
  else if (s.eave_continuous === false) bits.push("a broken eave line");
  else if (s.gable_end === false) bits.push("no gable end (hips close the side)");
  if (s.steps != null && s.steps > 0) bits.push(`${s.steps} fascia step(s)`);
  if (s.ds_marks != null && s.ds_marks > 0) bits.push(`${s.ds_marks} downspout mark(s)`);
  return bits.join(", ");
}

/**
 * PRIORITY merge of layout evidence: for each face, the roof-page verdict
 * wins when readable/non-null; the elevations fill the gaps (they keep every
 * field the plan view can't see — gable positions, projections, eave_steps).
 * Both absent → empty map. Every fill/override produces a note naming the
 * ruling source. Absent/unreadable roof page → `usedRoofPlan:false` and the
 * elevation map passes through untouched.
 */
export function mergeLayoutEvidence(
  roofPlan: RoofPlanReading | null | undefined,
  perFaceElevations:
    | Partial<Record<string, FaceReadingRaw | undefined>>
    | null
    | undefined,
): LayoutEvidenceMerge {
  const out: Record<string, FaceReadingRaw> = {};
  for (const [k, v] of Object.entries(perFaceElevations ?? {})) {
    if (v) out[k] = v;
  }
  const notes: string[] = [];
  let usedRoofPlan = false;

  if (roofPlan && roofPlan.readable) {
    const synth = roofPlanAsFaceEvidence(roofPlan);
    for (const face of ROOF_PLAN_SIDES) {
      const side = roofPlan.sides[face];
      if (!sideHasVerdict(side)) continue;
      const elev = out[face];
      const what = describeSideVerdict(side);

      // FILL: no elevation read for this face, or it degraded (529s, low-res)
      // — the roof page IS the layout source for the side.
      if (!elev || elev.readable === false) {
        const filler = synth[face];
        if (!filler) continue;
        out[face] = filler;
        usedRoofPlan = true;
        notes.push(
          `📄 Roof-plan page: the ${face} side reads ${what} — used as the layout source (` +
            (elev
              ? `the ${face} elevation degraded: ${elev.unreadable_reason ?? "unreadable"}`
              : `no ${face} elevation was read`) +
            `).`,
        );
        continue;
      }

      // OVERRIDE field-by-field: the roof page wins on what it actually read;
      // the elevation keeps everything else.
      let merged = elev;
      const deltas: string[] = [];
      if (
        side.eave_continuous !== null &&
        side.eave_continuous !== elev.continuous_eave
      ) {
        merged = { ...merged, continuous_eave: side.eave_continuous };
        deltas.push(
          side.eave_continuous
            ? "a continuous eave (the elevation read a broken one)"
            : "a broken eave line (the elevation read it continuous)",
        );
      }
      if (
        side.gable_end === true &&
        merged.roof_form !== "gabled" &&
        merged.roof_form !== "mixed"
      ) {
        // The page shows a rake end the elevation didn't call — protective in
        // the no-overbilling direction (that side must not be auto-priced).
        merged = {
          ...merged,
          roof_form:
            (merged.gable_count ?? 0) > 0 || (merged.gables?.length ?? 0) > 0
              ? "mixed"
              : "gabled",
        };
        deltas.push("a gable end (rake) the elevation didn't call");
      }
      if (merged !== elev) {
        out[face] = merged;
        usedRoofPlan = true;
        notes.push(
          `📄 Roof-plan page: the ${face} side reads ${deltas.join(" and ")} — used as the layout source (overrules the ${face} elevation).`,
        );
      }
      if (
        side.gable_end === false &&
        (elev.roof_form === "gabled" || (elev.gable_count ?? 0) > 0)
      ) {
        // Compatible readings, not a conflict: dormer / frame-over gables are
        // invisible as ENDS on the plan view. Keep the elevation's gables;
        // say the end itself is hipped so a rake there isn't auto-believed.
        usedRoofPlan = true;
        notes.push(
          `📄 Roof-plan page: the ${face} side's END shows hips, not a rake — the ${face} elevation's gable(s) read as dormer/frame-over shapes above a guttered eave (agrees with the elevations on the eave; verify before dropping gutter there).`,
        );
      }
    }
  }

  return { perFace: out, notes, usedRoofPlan };
}

/* ------------------------------------------------------------------ */
/* PURE: unanimity + downspout floor derivations                        */
/* ------------------------------------------------------------------ */

/**
 * UNANIMOUS HIP straight from the roof page: readable, hips at every corner,
 * a continuous eave on ALL four sides, and no side reads a gable end. This
 * establishes unanimity EVEN when the elevations are degraded (the 529-outage
 * fix) — the page literally draws an eave around the whole perimeter.
 * `gable_end:null` is tolerated only because `eave_continuous:true` is
 * required on every side (a side can't be both a full eave and a rake).
 */
export function roofPlanUnanimousHip(
  reading: RoofPlanReading | null | undefined,
): boolean {
  if (!reading || !reading.readable) return false;
  if (reading.hips_at_corners !== true) return false;
  return ROOF_PLAN_SIDES.every(
    (f) =>
      reading.sides[f].eave_continuous === true &&
      reading.sides[f].gable_end !== true,
  );
}

/**
 * Printed downspout marks are a FLOOR for the takeoff's downspout count
 * (same doctrine as the elevations' min-downspouts constraint: printed marks
 * beat the 1-per-40 ft rule). Note-only — positions aren't read off the
 * page, so nothing is fabricated; the note tells the owner to tap-add.
 * Returns null when the page prints no floor or the takeoff already meets it.
 */
export function roofPlanDsFloor(
  reading: RoofPlanReading | null | undefined,
  currentDownspoutCount: number,
): { floor: number; note: string } | null {
  if (!reading || !reading.readable) return null;
  const perSide = ROOF_PLAN_SIDES.map((f) => reading.sides[f].ds_marks).filter(
    (n): n is number => typeof n === "number" && Number.isFinite(n),
  );
  const summed = perSide.length > 0 ? perSide.reduce((a, b) => a + b, 0) : 0;
  const floor = Math.max(reading.total_ds_marks ?? 0, summed);
  if (!Number.isFinite(floor) || floor <= 0) return null;
  const current = Math.max(0, Math.round(Number.isFinite(currentDownspoutCount) ? currentDownspoutCount : 0));
  if (current >= floor) return null;
  return {
    floor,
    note:
      `💧 Roof-plan page prints ${floor} downspout mark(s) but the takeoff carries ${current} — ` +
      `the printed marks are the minimum from the plan itself. Add the ${floor - current} missing ` +
      `drop(s) on the canvas and verify locations against the roof plan.`,
  };
}

/** One-line human summary for the takeoff panel / analysis notes. */
export function describeRoofPlanReading(reading: RoofPlanReading): string {
  if (!reading.readable) {
    return `unreadable (${reading.unreadable_reason ?? "too low-res"}) — layout fell back to the elevations.`;
  }
  const parts: string[] = [];
  if (reading.hips_at_corners === true) parts.push("hips at every corner");
  else if (reading.hips_at_corners === false) parts.push("not fully hipped");
  const eaves = ROOF_PLAN_SIDES.filter((f) => reading.sides[f].eave_continuous === true);
  const gables = ROOF_PLAN_SIDES.filter((f) => reading.sides[f].gable_end === true);
  if (eaves.length > 0) parts.push(`continuous eave on ${eaves.join("/")}`);
  if (gables.length > 0) parts.push(`gable end on ${gables.join("/")}`);
  const steps = ROOF_PLAN_SIDES.map((f) => ({ f, n: reading.sides[f].steps })).filter(
    (s) => (s.n ?? 0) > 0,
  );
  if (steps.length > 0)
    parts.push(steps.map((s) => `${s.n} fascia step(s) on ${s.f}`).join(", "));
  if (reading.total_ds_marks != null)
    parts.push(`${reading.total_ds_marks} printed downspout mark(s)`);
  if (reading.flat_sections === true)
    parts.push("flat/low-slope section(s) — drains there, not gutters");
  return parts.length > 0
    ? `${parts.join("; ")}.`
    : "read, but no per-side verdicts could be made out.";
}

/* ------------------------------------------------------------------ */
/* The one vision call (server-only via dynamic imports)                */
/* ------------------------------------------------------------------ */

export const ROOF_PLAN_SYSTEM = `
You are a senior rain-gutter estimator reading the ROOF PLAN / ROOF FRAMING
page of a residential construction set. This page is the LAYOUT TRUTH for a
gutter takeoff: it shows the roof exactly as built, from above — hips,
ridges, valleys, gable ends, fascia/tier steps, gutter callouts, and
downspout marks. Your verdicts here outrank the elevation views, so work
hard to give EVERY side of the roof an explicit answer; report null only
when the page genuinely does not show it.

<find_the_roof>
Read ONLY the page named in the user message. Find the roof OUTLINE — the
outermost boundary of the roof planes (the perimeter fascia / eave line).
Ignore the sheet border, dimension-line lattices, truss webbing, section
bubbles, and detail callout boxes. The outline is usually the heaviest
closed shape on the sheet, with 45° diagonal lines (hips / valleys)
springing from its corners and re-entrant corners. A detached garage or
shed sharing the page is a SEPARATE outline — read the LARGEST structure
and mention the other in notes.
</find_the_roof>

<orient>
Walk the four sides of the roof outline AS DRAWN on the sheet: FRONT, REAR,
LEFT, RIGHT. FRONT is the side with the main entry and/or garage — find it
from the titleblock, room/feature labels (ENTRY, PORCH, GARAGE, DRIVEWAY),
or a street arrow. When nothing labels it, FRONT is the BOTTOM of the sheet
(standard drafting convention). LEFT and RIGHT are as you FACE the front —
the viewer's left/right with the front at the bottom of the sheet.
</orient>

<hip_vs_gable>
Decide each side's ends from the DIAGONALS — this is the call that most
changes the gutter price:
  • HIP: a 45° diagonal runs from the outline corner INWARD to a ridge. Two
    diagonals meeting at (or springing from) a corner mean the roof plane
    folds down to a horizontal edge there — that side's edge is a guttered
    EAVE across its full length.
  • GABLE END: the side terminates in a straight RAKE — the ridge runs all
    the way OUT to the perimeter and dead-ends into the edge, with NO
    diagonals at the two corners. A gable end carries NO gutter.
A roof with a 45° diagonal at EVERY outline corner is fully hipped: set
hips_at_corners true — every side is then a continuous eave. If ANY side
ends in a rake, hips_at_corners is false. Read the diagonals on THIS page;
never infer gables from habit, symmetry, or what elevations usually show.
</hip_vs_gable>

<per_side>
For EACH of front / rear / left / right report:
  - eave_continuous: true when one guttered eave line runs the side's full
    width (fascia steps / tier changes do NOT break it; a rake does); false
    when a rake or gable end interrupts it; null when unreadable.
  - gable_end: true when that side terminates in a straight rake (ridge
    dead-ends into the perimeter); false when hips close it; null unknown.
  - steps: how many FASCIA STEPS the side shows — parallel, offset eave
    lines where a lower tier (porch, garage, patio cover) steps in front of
    or below the main eave; 0 when the eave is one plane; null unknown.
  - ds_marks: downspout marks printed on that side (see <downspouts>);
    null unknown.
</per_side>

<downspouts>
Count EVERY downspout mark on the page: filled dots or small squares at the
eave line, "D.S." / "DS" / "R.W.L." (rain-water leader) callouts, and the
legend's downspout symbol — check the LEGEND first, it tells you what the
dots mean. Downspout dots print small and cluster at outside corners and
tier steps — scan every corner. Report per-side counts in ds_marks and the
whole-page total in total_ds_marks. Null when the page prints no downspout
convention at all — never invent a count.
</downspouts>

<gutter_callouts>
Text like "G.I. GUTTER", "5\\" K-STYLE GUTTER", "GUTTER & D.S.", a "GUTTER"
leader pointing at an edge, or a fascia callout CONFIRMS that edge is a
guttered eave — fold that into eave_continuous for its side and cite the
callout in notes.
</gutter_callouts>

<flat_sections>
Set flat_sections true when part of the roof is flat / low-slope ("FLAT
ROOF", "TPO", "MEMBRANE", crickets sloping to roof drains/scuppers) — those
areas drain to drains, not eave gutters. false when the whole roof is
clearly sloped; null when you can't tell.
</flat_sections>

<honesty>
This page is often a SCAN — lines can be faint. A verdict you CAN read is
load-bearing, and an explicit false ("no gable end here") is as valuable as
a true. But NEVER guess: any side or field you cannot actually read stays
null, and if the page is too degraded to find the roof outline at all, set
readable:false with unreadable_reason. Use notes for anything a human
should verify (tier steps, unusual callouts, a second structure).
</honesty>

Call record_roof_plan_reading with your result. Do not output prose.
`.trim();

/** Markers the engine depends on the prompt teaching — a stale /admin/prompts
 *  override missing any of these is bypassed for the code default. */
export const ROOF_PLAN_PROMPT_MARKERS = [
  "eave_continuous",
  "gable_end",
  "ds_marks",
  "hips_at_corners",
];

const SIDE_SCHEMA = {
  type: "object",
  properties: {
    eave_continuous: {
      type: ["boolean", "null"],
      description:
        "One guttered eave line runs this side's full width (tier steps don't break it; a rake does). Null when unreadable.",
    },
    gable_end: {
      type: ["boolean", "null"],
      description:
        "This side terminates in a straight rake (ridge dead-ends into the perimeter — no gutter). false = hips close it. Null unknown.",
    },
    steps: {
      type: ["integer", "null"],
      description:
        "Fascia steps on this side (parallel offset eave lines — tier changes). 0 = one plane. Null unknown.",
    },
    ds_marks: {
      type: ["integer", "null"],
      description: "Downspout dots / D.S. marks printed on this side. Null unknown.",
    },
  },
  required: ["eave_continuous", "gable_end"],
} as const;

const RECORD_ROOF_PLAN_TOOL: Anthropic.Tool = {
  name: "record_roof_plan_reading",
  description:
    "Record the reading of the roof plan / roof framing page — the layout truth for a gutter takeoff.",
  input_schema: {
    type: "object",
    properties: {
      readable: {
        type: "boolean",
        description: "false when the page is too degraded to find the roof outline.",
      },
      unreadable_reason: { type: ["string", "null"] },
      sides: {
        type: "object",
        description:
          "The four sides of the roof outline as drawn (front = entry/garage side, else the bottom of the sheet).",
        properties: {
          front: SIDE_SCHEMA,
          rear: SIDE_SCHEMA,
          left: SIDE_SCHEMA,
          right: SIDE_SCHEMA,
        },
        required: ["front", "rear", "left", "right"],
      },
      hips_at_corners: {
        type: ["boolean", "null"],
        description:
          "45° diagonals meet EVERY outline corner (fully hipped roof — every side a continuous eave). false when any side ends in a rake.",
      },
      total_ds_marks: {
        type: ["integer", "null"],
        description: "Every downspout mark printed on the whole page. Null when no downspout convention is printed.",
      },
      flat_sections: {
        type: ["boolean", "null"],
        description: "Part of the roof is flat/low-slope (drains to scuppers/roof drains, not eave gutters).",
      },
      confidence: { type: "string", enum: ["high", "medium", "low"] },
      notes: { type: "array", items: { type: "string" } },
    },
    required: ["readable", "sides", "hips_at_corners", "confidence"],
  },
};

/**
 * Read the roof plan / roof framing page in ONE vision call. Never throws —
 * any failure (missing key, transient 529, truncation) returns
 * `readable:false` with the reason, so the run degrades to the elevations
 * exactly as before.
 */
export async function readRoofPlanLayout(
  source: PlanSource,
  spec: { page: number | null },
): Promise<RoofPlanReadResult> {
  const zero = { input_tokens: 0, output_tokens: 0 };
  try {
    // Server deps loaded lazily so the module's pure parts stay testable
    // under node --test (see the module header).
    const [{ default: AnthropicClient }, { getActiveApiKey }, { getPrompt }] =
      await Promise.all([
        import("@anthropic-ai/sdk"),
        import("@/lib/api-keys"),
        import("./prompts"),
      ]);

    const apiKey = (await getActiveApiKey("ANTHROPIC")) ?? process.env.ANTHROPIC_API_KEY ?? null;
    if (!apiKey) {
      return { reading: emptyRoofPlanReading("no Anthropic API key"), page: spec.page, usage: zero };
    }
    const client = new AnthropicClient({ apiKey });
    // Engine-critical vocabulary the prompt MUST teach — a stale
    // /admin/prompts override without these field names produces readings
    // with no per-side verdicts; it's bypassed for the code default.
    const system = await getPrompt("blueprint.roofplan.system", ROOF_PLAN_SYSTEM, {
      requiredMarkers: ROOF_PLAN_PROMPT_MARKERS,
    });

    const sourceBlock: Anthropic.ContentBlockParam = (() => {
      switch (source.kind) {
        case "pdf":
          return { type: "document", source: { type: "base64", media_type: "application/pdf", data: source.base64 } };
        case "pdf-url":
          return { type: "document", source: { type: "url", url: source.url } };
        case "image":
          return { type: "image", source: { type: "base64", media_type: source.mediaType, data: source.base64 } };
        case "image-url":
          return { type: "image", source: { type: "url", url: source.url } };
      }
    })();

    const response = await client.messages.create({
      model: MODEL,
      // Output is small (~400 tokens of tool JSON), but non-haiku models
      // spend adaptive-thinking tokens from this same budget and a faint
      // scan is exactly where thinking runs long — size for that, not the
      // typical case (same rationale as read-elevations.ts).
      max_tokens: /haiku/.test(MODEL) ? 4000 : 12000,
      // Opus 4.7+/Sonnet 5 reject `temperature`. Positive allowlist — same
      // pattern as read-elevations.ts.
      ...(/haiku|sonnet-4-/.test(MODEL) ? { temperature: 0 } : {}),
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                `Read the roof layout from the ROOF PLAN / ROOF FRAMING page of the attached construction set` +
                (spec.page != null
                  ? ` — it is page ${spec.page} (1-based). Read ONLY that page; ignore every other sheet. `
                  : `. Locate it (the bird's-eye roof view with hips/ridges/valleys and pitch arrows — NOT the site plan), then read ONLY that page. `) +
                `Identify the roof outline, orient FRONT (the entry/garage side per the labels, else the bottom of the sheet), ` +
                `walk all four sides for eave vs gable end and fascia steps, count every downspout mark (check the legend first), ` +
                `and call record_roof_plan_reading. If the page is too degraded to read, set readable:false — never guess.`,
            },
            sourceBlock,
          ],
        },
      ],
      tools: [RECORD_ROOF_PLAN_TOOL],
      tool_choice: { type: "tool", name: RECORD_ROOF_PLAN_TOOL.name },
    });

    const usage = {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
    };
    // A truncated tool call parses as a PLAUSIBLE reading (defaults fill the
    // lost tail) — poison for the priority merge. Degrade honestly instead.
    if (response.stop_reason === "max_tokens") {
      return {
        reading: emptyRoofPlanReading("tool output truncated at max_tokens — reading discarded"),
        page: spec.page,
        usage,
      };
    }
    const toolUse = response.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    if (!toolUse) {
      return {
        reading: emptyRoofPlanReading("model returned no structured reading"),
        page: spec.page,
        usage,
      };
    }
    const reading =
      parseRoofPlanReading(toolUse.input) ??
      emptyRoofPlanReading("model returned a non-object reading");
    return { reading, page: spec.page, usage };
  } catch (e) {
    return {
      reading: emptyRoofPlanReading(
        `read failed: ${e instanceof Error ? e.message : "unknown"}`,
      ),
      page: spec.page,
      usage: zero,
    };
  }
}
